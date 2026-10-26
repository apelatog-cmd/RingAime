const $ = (id) => document.getElementById(id);
let followed = {};
let results = [];

// Dibuja una tarjeta de anime
function makeCard(item, actionEl, chipInfo) {
  const card = document.createElement("div");
  card.className = "card";

  const poster = document.createElement("div");
  poster.className = "poster";
  if (item.color) poster.style.background = item.color;
  if (item.cover) {
    const img = document.createElement("img");
    img.src = item.cover;
    img.alt = "";
    poster.appendChild(img);
  }

  const body = document.createElement("div");
  body.className = "card-body";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = item.title;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = item.meta;
  body.append(title, meta);
  if (chipInfo) {
    const chip = document.createElement("span");
    chip.className = "chip " + chipInfo.kind;
    chip.textContent = chipInfo.text;
    body.appendChild(chip);
  }

  card.append(poster, body, actionEl);
  return card;
}

function updateCount() {
  $("tab-siguiendo").textContent = "Siguiendo (" + Object.keys(followed).length + ")";
}

async function saveFollowed() {
  await chrome.storage.local.set({ followed });
  updateCount();
}

function followButton(item) {
  const btn = document.createElement("button");
  btn.className = "follow-btn";
  const paint = () => {
    const on = !!followed[item.id];
    btn.textContent = on ? "Siguiendo" : "Seguir";
    btn.classList.toggle("on", on);
  };
  paint();
  btn.addEventListener("click", async () => {
    if (followed[item.id]) {
      delete followed[item.id];
      await saveFollowed();
      paint();
      renderFollowed();
    } else {
      followed[item.id] = item;
      await saveFollowed();
      paint();
      renderFollowed();
      // Al empezar a seguirlo, buscamos de inmediato si tiene novedades
      const r = await RingCheck.runCheck({ ids: [item.id] });
      if (r.ok) {
        followed = r.followed;
        updateCount();
        renderFollowed();
      }
    }
  });
  return btn;
}

function makeSeriesCard(entry) {
  const group = document.createElement("div");
  group.className = "group";
  const card = makeCard(entry.item, followButton(entry.item));

  const toggle = document.createElement("button");
  toggle.className = "link-btn";
  toggle.textContent = "Ver temporadas ▾";
  card.querySelector(".card-body").appendChild(toggle);

  const list = document.createElement("div");
  list.className = "seasons hidden";
  entry.seasons.forEach((s) => {
    const row = document.createElement("div");
    row.className = "season-row";
    const left = document.createElement("div");
    const name = document.createElement("div");
    name.className = "season-name";
    name.textContent = "Temporada " + s.n;
    const title = document.createElement("div");
    title.className = "season-title";
    title.textContent = s.title;
    left.append(name, title);
    const status = document.createElement("span");
    status.className = "season-status";
    status.textContent = s.status;
    row.append(left, status);
    list.appendChild(row);
  });

  toggle.addEventListener("click", () => {
    const open = list.classList.toggle("hidden") === false;
    toggle.textContent = open ? "Ocultar temporadas ▴" : "Ver temporadas ▾";
  });

  group.append(card, list);
  return group;
}

function renderResults() {
  const box = $("results");
  box.innerHTML = "";
  results.forEach((entry) => {
    if (entry.type === "series") box.appendChild(makeSeriesCard(entry));
    else box.appendChild(makeCard(entry.item, followButton(entry.item)));
  });
}

function renderFollowed() {
  const box = $("followed");
  box.innerHTML = "";
  const items = Object.values(followed);
  $("empty").classList.toggle("hidden", items.length > 0);
  items.forEach((item) => {
    const remove = document.createElement("button");
    remove.className = "remove-btn";
    remove.textContent = "✕";
    remove.setAttribute("aria-label", "Dejar de seguir");
    remove.addEventListener("click", async () => {
      delete followed[item.id];
      await saveFollowed();
      renderFollowed();
    });
    box.appendChild(makeCard(item, remove, item.info || { kind: "none", text: "Sin novedades por ahora" }));
  });
}

function setMsg(text) {
  $("msg").textContent = text;
}

let searchSeq = 0;
async function search(text) {
  const mySeq = ++searchSeq; // para ignorar respuestas viejas si el usuario sigue escribiendo
  if (!text.trim()) {
    results = [];
    renderResults();
    setMsg("Escribe el nombre de un anime para empezar.");
    return;
  }
  setMsg("Buscando…");
  try {
    const found = await RingGroups.search(text);
    if (mySeq !== searchSeq) return;
    results = found;
    renderResults();
    setMsg(results.length ? "" : "No encontramos resultados.");
  } catch (err) {
    if (mySeq === searchSeq) setMsg("No pudimos conectar. Inténtalo de nuevo en un momento.");
  }
}

// Búsqueda con una pequeña espera para no pedir datos en cada letra
let timer;
$("q").addEventListener("input", (e) => {
  clearTimeout(timer);
  timer = setTimeout(() => search(e.target.value), 400);
});

// Cambio de pestañas
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.add("hidden"));
    tab.classList.add("active");
    $(tab.dataset.tab).classList.remove("hidden");
    if (tab.dataset.tab === "buscar") renderResults();
  });
});


// Notificación de prueba
function createNotification(id, options, fallback) {
  chrome.notifications.create(id, options, () => {
    if (chrome.runtime.lastError) {
      if (fallback) {
        createNotification(id, fallback, null);
      } else {
        $("test-status").textContent =
          "No se pudo mostrar la notificación. Revisa que las notificaciones de Chrome estén activadas en tu sistema.";
      }
      return;
    }
    $("test-status").textContent =
      "Listo: deberías verla abajo a la derecha. Si no aparece, revisa que no esté activado el modo No molestar en tu sistema.";
  });
}

$("test-btn").addEventListener("click", async () => {
  const first = Object.values(followed)[0];
  const name = first ? first.title : "Tu anime favorito";
  const animeId = first ? first.id : 0;
  const id = "test|" + animeId + "|" + Date.now();
  const base = {
    type: "basic",
    iconUrl: "icon128.png",
    title: name + ": nueva temporada anunciada",
    message: first
      ? "Esta es una notificación de prueba. Tócala para abrir la página del anime."
      : "Esta es una notificación de prueba. Aún no sigues ningún anime, así que usamos un ejemplo.",
    priority: 2,
    requireInteraction: true, // la notificación se queda hasta que el usuario la toque o la cierre
  };
  // Primero intentamos con la portada del anime; si falla, usamos el icono de RingAnime
  if (first && first.cover) {
    const cover = await RingCheck.imageToDataUrl(first.cover);
    createNotification(id, cover ? { ...base, iconUrl: cover } : base, base);
  } else {
    createNotification(id, base, null);
  }
});

// Revisión de novedades (manual)
async function showLastCheck() {
  const data = await chrome.storage.local.get("lastCheck");
  const el = $("check-last");
  if (!data.lastCheck) {
    el.textContent = "Aún no se ha hecho ninguna revisión.";
    return;
  }
  const min = Math.round((Date.now() - data.lastCheck) / 60000);
  const when = min < 1 ? "hace un momento" : min < 60 ? "hace " + min + " min" : "hace " + Math.round(min / 60) + " h";
  el.textContent = "Última revisión: " + when + ".";
}

$("check-btn").addEventListener("click", async () => {
  const btn = $("check-btn");
  btn.disabled = true;
  btn.textContent = "Revisando…";
  $("check-status").textContent = "";
  const r = await RingCheck.runCheck();
  btn.disabled = false;
  btn.textContent = "Revisar novedades ahora";
  if (!r.ok) {
    $("check-status").textContent = "No pudimos conectar con AniList. Inténtalo de nuevo en un momento.";
  } else {
    followed = r.followed || followed;
    updateCount();
    renderFollowed();
    $("check-status").textContent = r.notified
      ? "Listo: te enviamos " + r.notified + (r.notified === 1 ? " aviso." : " avisos.")
      : "Listo: no hay novedades nuevas.";
  }
  showLastCheck();
});

// Si la lista cambia desde el segundo plano, la ventana se actualiza sola
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.followed) {
    followed = changes.followed.newValue || {};
    updateCount();
    renderFollowed();
  }
});

// Tutorial de bienvenida (solo la primera vez)
const STEPS = [
  {
    title: "Te damos la bienvenida a RingAnime",
    text: "Sigue tus animes favoritos y te avisamos de sus nuevas temporadas, sin que tengas que buscar nada.",
    art: '<div class="tut-circle"><svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#FF5C7A" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7"/><path d="M10 20a2 2 0 0 0 4 0"/></svg></div>',
  },
  {
    title: "Busca y sigue",
    text: "Escribe el anime que quieras en el buscador y toca Seguir. RingAnime te avisará cuando haya novedades sobre él.",
    art: '<div class="mock"><div class="mock-input">Escribe el nombre de un anime</div><div class="mock-row"><span>Tu anime favorito</span><span class="mock-btn">Seguir</span></div></div>',
  },
  {
    title: "Dos tipos de aviso",
    text: "",
    top: true,
    art: '<div class="tut-card"><h3>Anuncio</h3><p>Te decimos que viene una nueva temporada y cuándo se estrena.</p></div><div class="tut-card"><h3>Ya estrenada</h3><p>Te avisamos cuando por fin sale, por si se te pasó el anuncio.</p></div><p class="tut-note">Los avisos llegan mientras tu navegador esté abierto.</p>',
  },
];
let step = 0;

function renderTutorial() {
  const s = STEPS[step];
  const body = $("tut-body");
  body.classList.toggle("top", !!s.top);
  const title = '<h2 class="tut-title">' + s.title + "</h2>";
  const text = s.text ? '<p class="tut-text">' + s.text + "</p>" : "";
  // Las tarjetas de la pantalla 3 van después del título; en las demás, la ilustración va primero
  body.innerHTML = s.top ? title + s.art : s.art + title + text;
  $("dots").innerHTML = STEPS.map((_, i) => '<span class="dot' + (i === step ? " on" : "") + '"></span>').join("");
  $("tut-next").textContent = step === STEPS.length - 1 ? "Empezar" : "Siguiente";
  $("tut-skip").style.visibility = step < STEPS.length - 1 ? "visible" : "hidden";
}

async function finishTutorial() {
  await chrome.storage.local.set({ onboardingDone: true });
  $("tutorial").classList.add("hidden");
  $("app").classList.remove("hidden");
}

$("tut-next").addEventListener("click", () => {
  if (step < STEPS.length - 1) {
    step++;
    renderTutorial();
  } else {
    finishTutorial();
  }
});
$("tut-skip").addEventListener("click", finishTutorial);

// Al abrir: cargar los animes guardados y decidir si mostrar el tutorial
(async function init() {
  const data = await chrome.storage.local.get(["followed", "onboardingDone"]);
  followed = data.followed || {};
  updateCount();
  renderFollowed();
  showLastCheck();
  if (!data.onboardingDone) {
    $("app").classList.add("hidden");
    $("tutorial").classList.remove("hidden");
    renderTutorial();
  }
})();

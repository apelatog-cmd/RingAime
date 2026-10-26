// Revisión de novedades: consulta AniList y avisa de anuncios y estrenos.
// Lo usan tanto la ventana (popup.js) como el segundo plano (background.js).
self.RingCheck = (function () {
  const API = "https://graphql.anilist.co";
  const SEASON_FORMATS = ["TV", "TV_SHORT", "ONA"]; // lo que cuenta como "temporada"
  const MAX_DEPTH = 6; // cuántas secuelas encadenadas seguimos
  const REMINDER_DAYS = 2; // cuántos días antes del estreno mandamos el recordatorio (puedes cambiarlo a 3)
  const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const FORMAT = {
    TV: "Serie", TV_SHORT: "Serie corta", MOVIE: "Película",
    OVA: "OVA", ONA: "ONA", SPECIAL: "Especial", MUSIC: "Música",
  };
  const STATUS = {
    FINISHED: "Finalizado", RELEASING: "En emisión", NOT_YET_RELEASED: "Aún no estrenado",
    CANCELLED: "Cancelado", HIATUS: "En pausa",
  };

  const QUERY = `
  query ($ids: [Int]) {
    Page(perPage: 50) {
      media(id_in: $ids, type: ANIME) {
        id
        title { romaji english }
        format
        status
        startDate { year month day }
        relations { edges { relationType node { id type format status } } }
      }
    }
  }`;

  // ---------- Datos de AniList ----------
  async function fetchMedia(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: QUERY, variables: { ids: chunk } }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();
      if (json.errors || !json.data) throw new Error("Respuesta inválida");
      out.push(...json.data.Page.media);
    }
    return out;
  }

  // Descarga los animes seguidos y toda su cadena de secuelas
  async function loadGraph(rootIds) {
    const byId = {};
    const children = {};
    let frontier = [...new Set(rootIds)];
    for (let depth = 0; depth <= MAX_DEPTH && frontier.length; depth++) {
      const media = await fetchMedia(frontier);
      const next = [];
      for (const m of media) {
        byId[m.id] = m;
        children[m.id] = [];
        const edges = (m.relations && m.relations.edges) || [];
        for (const e of edges) {
          if (e.relationType === "SEQUEL" && e.node && e.node.type === "ANIME") {
            children[m.id].push(e.node.id);
            if (!byId[e.node.id] && !frontier.includes(e.node.id) && !next.includes(e.node.id)) {
              next.push(e.node.id);
            }
          }
        }
      }
      frontier = next;
    }
    return { byId, children };
  }

  // Todas las temporadas que vienen después de un anime
  function descendants(rootId, graph) {
    const seen = new Set([rootId]);
    const stack = [...(graph.children[rootId] || [])];
    const result = [];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const m = graph.byId[id];
      if (!m) continue;
      if (SEASON_FORMATS.includes(m.format)) result.push(m);
      stack.push(...(graph.children[id] || []));
    }
    return result;
  }

  // ---------- Fechas y textos ----------
  function dateKey(m) {
    const d = m.startDate || {};
    return (d.year || 0) * 10000 + (d.month || 0) * 100 + (d.day || 0);
  }
  function upcomingKey(m) {
    return dateKey(m) || 99999999; // sin fecha = al final
  }
  function dateText(sd) {
    if (!sd || !sd.year) return "fecha por confirmar";
    if (sd.month && sd.day) {
      return sd.day + " " + MONTHS[sd.month - 1] + " " + sd.year;
    }
    if (sd.month) return MONTHS[sd.month - 1] + " " + sd.year;
    return String(sd.year);
  }
  function whenText(sd) {
    if (!sd || !sd.year) return "en una fecha por confirmar";
    return sd.month && sd.day ? "el " + dateText(sd) : "en " + dateText(sd);
  }
  // Días que faltan para una fecha (solo si tenemos día, mes y año)
  function daysUntil(sd) {
    if (!sd || !sd.year || !sd.month || !sd.day) return null;
    const target = new Date(sd.year, sd.month - 1, sd.day);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((target - today) / 86400000);
  }
  function titleOf(m) {
    return m.title.english || m.title.romaji;
  }
  const isOut = (s) => s === "RELEASING" || s === "FINISHED";

  // ---------- Qué cambió en un anime seguido ----------
  function evaluate(item, graph) {
    const self = graph.byId[item.id];
    if (!self) return null;
    const desc = descendants(item.id, graph);

    const tracked = { [self.id]: { status: self.status } };
    desc.forEach((d) => (tracked[d.id] = { status: d.status }));

    const known = item.known || null;
    const events = [];
    if (!known) {
      // Primera revisión: avisamos de lo que ya existía (por si el usuario no lo sabía)
      desc.forEach((d) => {
        if (d.status === "NOT_YET_RELEASED") events.push({ kind: "announced", target: d });
        else if (isOut(d.status)) events.push({ kind: "premiered", target: d });
      });
    } else {
      desc.forEach((d) => {
        const prev = known[d.id];
        if (!prev) {
          if (d.status === "NOT_YET_RELEASED") events.push({ kind: "announced", target: d });
          else if (isOut(d.status)) events.push({ kind: "premiered", target: d });
        } else if (prev.status === "NOT_YET_RELEASED" && isOut(d.status)) {
          events.push({ kind: "premiered", target: d });
        }
      });
      const prevSelf = known[self.id];
      if (prevSelf && prevSelf.status === "NOT_YET_RELEASED" && isOut(self.status)) {
        events.push({ kind: "premiered", target: self, self: true });
      }
    }

    // Un solo aviso de cada tipo por revisión
    const picked = {};
    picked.announced = events
      .filter((e) => e.kind === "announced")
      .sort((a, b) => upcomingKey(a.target) - upcomingKey(b.target))[0];
    picked.premiered = events
      .filter((e) => e.kind === "premiered")
      .sort((a, b) => {
        const ra = a.target.status === "RELEASING" ? 1 : 0;
        const rb = b.target.status === "RELEASING" ? 1 : 0;
        return rb - ra || dateKey(b.target) - dateKey(a.target);
      })[0];

    // Etiqueta que se muestra en la pestaña Siguiendo
    const releasing = desc.filter((d) => d.status === "RELEASING");
    const upcoming = desc
      .filter((d) => d.status === "NOT_YET_RELEASED")
      .sort((a, b) => upcomingKey(a) - upcomingKey(b));
    const finished = desc.filter((d) => d.status === "FINISHED");
    let info = { kind: "none", text: "Sin novedades por ahora" };
    if (releasing.length) {
      info = { kind: "premiered", text: "Nueva temporada ya estrenada" };
    } else if (upcoming.length) {
      info = { kind: "announced", text: "Nueva temporada anunciada · " + dateText(upcoming[0].startDate) };
    } else if (self.status === "NOT_YET_RELEASED") {
      info = { kind: "announced", text: "Próximamente · " + dateText(self.startDate) };
    } else if (finished.length) {
      info = { kind: "premiered", text: "Ya tiene nuevas temporadas" };
    }

    const meta = (FORMAT[self.format] || "Anime") + " · " + (STATUS[self.status] || "");

    // Recordatorio unos días antes del estreno
    const reminded = Object.assign({}, item.reminded || {});
    const candidates = desc.filter((d) => d.status === "NOT_YET_RELEASED");
    if (self.status === "NOT_YET_RELEASED") candidates.push(self);
    candidates.sort((a, b) => upcomingKey(a) - upcomingKey(b));
    let reminder = null;
    for (const c of candidates) {
      const days = daysUntil(c.startDate);
      if (days === null || days < 1 || days > REMINDER_DAYS || reminded[c.id]) continue;
      if (!known && c.id !== self.id) {
        reminded[c.id] = true; // el anuncio de hoy ya incluye la fecha
        continue;
      }
      if (!reminder) reminder = { target: c, days, self: c.id === self.id };
    }
    return { tracked, picked, info, meta, reminder, reminded };
  }

  // ---------- Notificaciones ----------
  // Chrome/Brave solo aceptan imágenes locales o "data:" en las notificaciones,
  // así que descargamos la portada y la convertimos.
  async function imageToDataUrl(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      const type = res.headers.get("content-type") || "image/jpeg";
      return "data:" + type + ";base64," + btoa(binary);
    } catch (err) {
      return null;
    }
  }

  function createNotification(id, options) {
    return new Promise((resolve) => {
      chrome.notifications.create(id, options, () => {
        resolve(!chrome.runtime.lastError);
      });
    });
  }

  async function notify(kind, item, ev) {
    const t = ev.target;
    const name = item.title;
    const targetName = titleOf(t);
    let title, message;
    if (kind === "announced") {
      title = name + ": nueva temporada anunciada";
      message = targetName + " se estrena " + whenText(t.startDate) + ". Toca para ver los detalles.";
    } else if (kind === "reminder") {
      const rel = ev.days === 1 ? "mañana" : "en " + ev.days + " días";
      title = ev.self ? name + ": se estrena " + rel : name + ": nueva temporada " + rel;
      message = ev.self
        ? "Estreno: " + dateText(t.startDate) + ". Toca para ver los detalles."
        : targetName + " se estrena el " + dateText(t.startDate) + ". ¡Ve preparándote!";
    } else {
      title = ev.self ? name + ": ¡ya se estrenó!" : name + ": ¡ya se estrenó la nueva temporada!";
      message = targetName + " ya se estrenó. Toca para ver los detalles.";
    }
    const icon = chrome.runtime.getURL("icon128.png");
    const base = {
      type: "basic", iconUrl: icon, title, message,
      priority: 2, requireInteraction: true,
    };
    const id = kind + "|" + t.id + "|" + Date.now();
    let ok = false;
    if (item.cover) {
      const cover = await imageToDataUrl(item.cover);
      if (cover) ok = await createNotification(id, { ...base, iconUrl: cover });
    }
    if (!ok) ok = await createNotification(id, base); // sin portada, usamos el icono de RingAnime
    return ok;
  }

  // ---------- Revisión completa ----------
  async function runCheck(opts) {
    opts = opts || {};
    const stored = await chrome.storage.local.get("followed");
    const all = stored.followed || {};
    let items = Object.values(all);
    if (opts.ids) items = items.filter((i) => opts.ids.includes(i.id));
    if (!items.length) {
      if (!opts.ids) await chrome.storage.local.set({ lastCheck: Date.now() });
      return { ok: true, notified: 0, followed: all };
    }

    let graph;
    try {
      graph = await loadGraph(items.map((i) => i.id));
    } catch (err) {
      return { ok: false, notified: 0 };
    }

    const updates = {};
    let notified = 0;
    for (const item of items) {
      const r = evaluate(item, graph);
      if (!r) continue;
      for (const kind of ["announced", "premiered"]) {
        if (r.picked[kind] && (await notify(kind, item, r.picked[kind]))) notified++;
      }
      if (r.reminder && (await notify("reminder", item, r.reminder))) {
        r.reminded[r.reminder.target.id] = true;
        notified++;
      }
      updates[item.id] = { known: r.tracked, info: r.info, meta: r.meta, reminded: r.reminded };
    }

    // Volvemos a leer por si el usuario cambió su lista mientras revisábamos
    const fresh = (await chrome.storage.local.get("followed")).followed || {};
    for (const id in updates) {
      if (fresh[id]) Object.assign(fresh[id], updates[id]);
    }
    const toSave = { followed: fresh };
    if (!opts.ids) toSave.lastCheck = Date.now();
    await chrome.storage.local.set(toSave);
    return { ok: true, notified, followed: fresh };
  }

  return { runCheck, evaluate, imageToDataUrl };
})();

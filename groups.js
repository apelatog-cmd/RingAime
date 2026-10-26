// Búsqueda agrupada: junta las temporadas de un mismo anime en una sola tarjeta.
self.RingGroups = (function () {
  const API = "https://graphql.anilist.co";
  const SEASON_FORMATS = ["TV", "TV_SHORT", "ONA"];
  const MAX_DEPTH = 5; // cuántos "saltos" damos buscando temporadas relacionadas
  const MAX_NODES = 60; // tope de animes por búsqueda
  const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const FORMAT = {
    TV: "Serie", TV_SHORT: "Serie corta", MOVIE: "Película",
    OVA: "OVA", ONA: "ONA", SPECIAL: "Especial", MUSIC: "Música",
  };
  const STATUS = {
    FINISHED: "Finalizado", RELEASING: "En emisión", NOT_YET_RELEASED: "Aún no estrenado",
    CANCELLED: "Cancelado", HIATUS: "En pausa",
  };

  const FIELDS = `
    id
    title { romaji english }
    format
    status
    startDate { year month day }
    coverImage { medium color }
    relations { edges { relationType node { id type format } } }`;
  const SEARCH_QUERY = `query ($search: String) {
    Page(perPage: 10) { media(search: $search, type: ANIME, sort: SEARCH_MATCH) { ${FIELDS} } }
  }`;
  const IDS_QUERY = `query ($ids: [Int]) {
    Page(perPage: 50) { media(id_in: $ids, type: ANIME) { ${FIELDS} } }
  }`;

  async function post(query, variables) {
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    if (json.errors || !json.data) throw new Error("Respuesta inválida");
    return json.data.Page.media;
  }

  // IDs de las temporadas anteriores y posteriores de un anime
  function links(m) {
    const edges = (m.relations && m.relations.edges) || [];
    return edges
      .filter((e) => (e.relationType === "SEQUEL" || e.relationType === "PREQUEL") && e.node && e.node.type === "ANIME")
      .map((e) => e.node.id);
  }

  // Descarga los animes relacionados con los resultados (hacia atrás y hacia adelante)
  async function expand(byId) {
    const tried = new Set();
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const room = MAX_NODES - Object.keys(byId).length;
      const missing = [...new Set(Object.values(byId).flatMap(links))]
        .filter((id) => !byId[id] && !tried.has(id))
        .slice(0, Math.min(50, room));
      if (!missing.length) break;
      missing.forEach((id) => tried.add(id));
      const media = await post(IDS_QUERY, { ids: missing });
      media.forEach((m) => (byId[m.id] = m));
    }
  }

  // Agrupa en "familias" los animes conectados entre sí
  function components(byId) {
    const comp = {};
    let next = 0;
    for (const startId of Object.keys(byId)) {
      if (comp[startId] !== undefined) continue;
      const stack = [startId];
      comp[startId] = next;
      while (stack.length) {
        const id = stack.pop();
        const neighbours = links(byId[id]).filter((n) => byId[n]);
        // también las conexiones inversas (por si solo una de las dos entradas enlaza a la otra)
        Object.values(byId).forEach((o) => {
          if (links(o).includes(Number(id))) neighbours.push(o.id);
        });
        for (const n of neighbours) {
          if (comp[n] === undefined) {
            comp[n] = next;
            stack.push(String(n));
          }
        }
      }
      next++;
    }
    return comp;
  }

  // ---------- Textos y fechas ----------
  function dateKey(m) {
    const d = m.startDate || {};
    return (d.year || 0) * 10000 + (d.month || 0) * 100 + (d.day || 0);
  }
  const orderKey = (m) => dateKey(m) || 99999999; // sin fecha = al final
  function dateText(sd) {
    if (!sd || !sd.year) return "fecha por confirmar";
    if (sd.month && sd.day) return sd.day + " " + MONTHS[sd.month - 1] + " " + sd.year;
    if (sd.month) return MONTHS[sd.month - 1] + " " + sd.year;
    return String(sd.year);
  }
  const titleOf = (m) => m.title.english || m.title.romaji;
  const coverOf = (m) => (m.coverImage && m.coverImage.medium) || "";
  const colorOf = (m) => (m.coverImage && m.coverImage.color) || "";
  function statusLine(m) {
    if (m.status === "NOT_YET_RELEASED") return "Aún no estrenado · " + dateText(m.startDate);
    return STATUS[m.status] || "";
  }

  function singleEntry(m) {
    return {
      type: "single",
      item: {
        id: m.id,
        title: titleOf(m),
        cover: coverOf(m),
        color: colorOf(m),
        meta: (FORMAT[m.format] || "Anime") + " · " + (STATUS[m.status] || ""),
      },
    };
  }

  // Una tarjeta para toda la serie. Al seguirla, vigilamos la última temporada.
  function seriesEntry(seasons) {
    const root = seasons[0];
    const latest = seasons[seasons.length - 1];
    const seriesTitle = titleOf(root);
    return {
      type: "series",
      count: seasons.length,
      item: {
        id: latest.id,
        title: seriesTitle,
        cover: coverOf(latest),
        color: colorOf(latest),
        meta: seasons.length + " temporadas · " + (STATUS[latest.status] || ""),
      },
      seasons: seasons.map((m, i) => ({
        n: i + 1,
        title: titleOf(m),
        status: statusLine(m),
      })),
    };
  }

  async function search(text) {
    const found = await post(SEARCH_QUERY, { search: text });
    const byId = {};
    found.forEach((m) => (byId[m.id] = m));
    await expand(byId);
    const comp = components(byId);

    const out = [];
    const done = new Set();
    for (const r of found) {
      if (!SEASON_FORMATS.includes(r.format)) {
        out.push(singleEntry(r)); // películas, OVAs y especiales van aparte
        continue;
      }
      const c = comp[r.id];
      if (done.has(c)) continue;
      done.add(c);
      const seasons = Object.values(byId)
        .filter((m) => comp[m.id] === c && SEASON_FORMATS.includes(m.format))
        .sort((a, b) => orderKey(a) - orderKey(b) || a.id - b.id);
      out.push(seasons.length > 1 ? seriesEntry(seasons) : singleEntry(r));
    }
    return out;
  }

  return { search };
})();

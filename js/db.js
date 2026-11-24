// Libreria sull'iPad (IndexedDB): i brani aperti e i loro progetti restano qui, non escono dal dispositivo.
let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    let req;
    try { req = indexedDB.open("dettato", 1); } catch (e) { rej(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("songs")) db.createObjectStore("songs", { keyPath: "id" });
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return dbp;
}
function tx(store, mode, fn) {
  return open().then(db => new Promise((res, rej) => {
    const t = db.transaction(store, mode), s = t.objectStore(store);
    let out;
    const r = fn(s);
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}
export const db = {
  putSong: song => tx("songs", "readwrite", s => s.put(song)),
  getSong: id => tx("songs", "readonly", s => s.get(id)),
  listSongs: () => tx("songs", "readonly", s => s.getAll()).then(a => (a || []).map(x => ({ ...x, blob: undefined }))),
  deleteSong: id => tx("songs", "readwrite", s => s.delete(id)).then(() => tx("projects", "readwrite", s => s.delete(id))),
  touchSong: async (id, fields) => { const s = await db.getSong(id); if (s) { Object.assign(s, fields); await db.putSong(s); } },
  putProject: (id, data) => tx("projects", "readwrite", s => s.put({ id, data, saved: Date.now() })),
  getProject: id => tx("projects", "readonly", s => s.get(id)).then(r => r ? r.data : null)
};

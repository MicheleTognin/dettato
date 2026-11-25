// Libreria sull'iPad (IndexedDB): i brani aperti e i loro progetti restano qui, non escono dal dispositivo.
// Versione 2: i dati audio stanno in un archivio a parte ("audio"), così i salvataggi automatici
// riscrivono solo le poche informazioni del brano e non l'intero file.
let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    let req;
    try { req = indexedDB.open("dettato", 2); } catch (e) { rej(e); return; }
    req.onupgradeneeded = e => {
      const db = req.result, t = req.transaction;
      if (!db.objectStoreNames.contains("songs")) db.createObjectStore("songs", { keyPath: "id" });
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
      if (!db.objectStoreNames.contains("audio")) db.createObjectStore("audio", { keyPath: "id" });
      if (e.oldVersion >= 1 && e.oldVersion < 2) {
        // dalla versione 1: il file stava dentro il brano, lo sposto nell'archivio audio
        const songs = t.objectStore("songs"), audio = t.objectStore("audio");
        songs.openCursor().onsuccess = ev => {
          const c = ev.target.result; if (!c) return;
          const v = c.value;
          if (v.blob) { audio.put({ id: v.id, data: v.blob }); delete v.blob; c.update(v); }
          c.continue();
        };
      }
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
    req.onblocked = () => rej(new Error("Archivio bloccato da un'altra finestra di Dettato"));
  });
  dbp.catch(() => { dbp = null; });
  return dbp;
}
function tx(stores, mode, fn) {
  return open().then(db => new Promise((res, rej) => {
    const t = db.transaction(stores, mode);
    let out;
    const r = fn(t);
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error("operazione annullata"));
  }));
}
export const db = {
  // song: { id, name, size, type, duration, added, opened, markers }; data: ArrayBuffer del file originale
  putSong: (song, data) => tx(["songs", "audio"], "readwrite", t => {
    t.objectStore("songs").put(song);
    if (data) t.objectStore("audio").put({ id: song.id, data });
  }),
  getSong: id => tx("songs", "readonly", t => t.objectStore("songs").get(id)),
  hasAudio: id => tx("audio", "readonly", t => t.objectStore("audio").getKey(id)).then(k => k !== undefined),
  // restituisce un ArrayBuffer (dalla versione 1 può arrivare un Blob)
  getAudio: id => tx("audio", "readonly", t => t.objectStore("audio").get(id))
    .then(r => !r ? null : (r.data instanceof Blob ? r.data.arrayBuffer() : r.data)),
  listSongs: () => tx("songs", "readonly", t => t.objectStore("songs").getAll()).then(a => a || []),
  deleteSong: id => tx(["songs", "audio", "projects"], "readwrite", t => {
    t.objectStore("songs").delete(id); t.objectStore("audio").delete(id); t.objectStore("projects").delete(id);
  }),
  touchSong: async (id, fields) => { const s = await db.getSong(id); if (s) { Object.assign(s, fields); await db.putSong(s); } },
  putProject: (id, data) => tx("projects", "readwrite", t => t.objectStore("projects").put({ id, data, saved: Date.now() })),
  getProject: id => tx("projects", "readonly", t => t.objectStore("projects").get(id)).then(r => r ? r.data : null)
};

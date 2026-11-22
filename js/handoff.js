// Bestand doorgeven tussen pagina's (orderoverzicht → CAD) via IndexedDB; werkt ook voor grote STL's.
const DB = 'ddcad-handoff', STORE = 'files';
function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
async function tx(mode, fn) { const db = await open(); return new Promise((resolve, reject) => { const t = db.transaction(STORE, mode); const out = fn(t.objectStore(STORE)); t.oncomplete = () => { db.close(); resolve(out?.result); }; t.onerror = () => reject(t.error); }); }
export const putHandoff = item => tx('readwrite', s => s.put({ ...item, at: Date.now() }, 'next'));
export async function takeHandoff() {
  const item = await tx('readonly', s => s.get('next'));
  await tx('readwrite', s => s.delete('next'));
  return item && Date.now() - item.at < 10 * 60 * 1000 ? item : null;
}

// Externe tandenbibliotheken (exocad-indeling): per set een map teeth/<set>/{upperjaw,lowerjaw}/1..8.eoff
// (kronen van één kwadrant, lokaal: x = mesiaal, y = buccaal, z = occlusaal, open aan de hals) en
// metadata/<set>/{upperjaw,lowerjaw}.xml (ToothBow: positie + occlusale en mesiale as per element = ideale opstelling).
// Alles blijft op het apparaat (IndexedDB). Er gaat niets naar een server en niets in de repository.
import { parseOFF } from './off.js';
import { listZip, readZipEntry } from './unzip.js';
import { edgeMap, boundaryLoops, fillHoles, weld } from './mesh.js';
import { toothDimensions } from './teeth.js';

// ---------- inlezen ----------
const TOOTH_RE = /(?:^|\/)([^/]+)\/(upper|lower)jaw\/([1-8])\.(eoff|off|stl)$/i;
const BOW_RE = /(?:^|\/)metadata\/([^/]+)\/(upper|lower)jaw\.xml$/i;
const PREVIEW_RE = /(?:^|\/)metadata\/([^/]+)\/preview\.png$/i;
const setKey = name => name.toLowerCase().replace(/[\s_]+/g, ' ').trim();

export function classifyPath(path) {
  const p = path.replace(/\\/g, '/');
  if (/\/metadata\//i.test('/' + p)) {
    let m = p.match(BOW_RE); if (m) return { kind: 'bow', set: m[1], jaw: m[2].toLowerCase() };
    m = p.match(PREVIEW_RE); if (m) return { kind: 'preview', set: m[1] };
    return null;
  }
  const m = p.match(TOOTH_RE);
  if (m && !/-reduced-|thimble|cutback/i.test(p)) return { kind: 'tooth', set: m[1], jaw: m[2].toLowerCase(), type: +m[3], ext: m[4].toLowerCase() };
  return null;
}

export function parseToothBow(text) {
  const out = [];
  const vecOf = (block, tag) => {
    const m = block.match(new RegExp(`<${tag}>\\s*<x>([^<]+)</x>\\s*<y>([^<]+)</y>\\s*<z>([^<]+)</z>`, 'i'));
    return m ? [+m[1], +m[2], +m[3]] : null;
  };
  for (const m of text.matchAll(/<ModelTooth>([\s\S]*?)<\/ModelTooth>/gi)) {
    const b = m[1], fdi = +(b.match(/<Number>(\d+)<\/Number>/i)?.[1] ?? NaN);
    const pos = vecOf(b, 'Position'), occ = vecOf(b, 'AxisOcclusal'), mes = vecOf(b, 'AxisMesial');
    if (Number.isFinite(fdi) && pos && occ && mes) out.push({ fdi, pos, occ, mes });
  }
  return out;
}

async function parseMeshFile(bytes, ext) {
  if (ext === 'stl') { const { parseSTL } = await import('./stl.js'); return weld(parseSTL(bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes), 1e-5); }
  return parseOFF(bytes);
}

// Verzamelt bestanden in sets. files: [{ path, read: () => Promise<ArrayBuffer> }]
async function collect(files, onProgress) {
  const sets = new Map(), get = name => { const k = setKey(name); if (!sets.has(k)) sets.set(k, { name: name.replace(/_/g, ' '), teeth: { upper: {}, lower: {} }, bow: {}, preview: null }); return sets.get(k); };
  const wanted = files.map(f => ({ f, c: classifyPath(f.path) })).filter(x => x.c);
  let done = 0;
  for (const { f, c } of wanted) {
    const buf = new Uint8Array(await f.read());
    const s = get(c.set);
    if (c.kind === 'tooth') s.teeth[c.jaw][c.type] = await parseMeshFile(buf, c.ext);
    else if (c.kind === 'bow') s.bow[c.jaw] = parseToothBow(new TextDecoder().decode(buf));
    else if (c.kind === 'preview') s.preview = buf;
    onProgress?.(++done / wanted.length, f.path);
  }
  // alleen sets met tanden; bogen zonder tanden (alleen metadata) vallen af
  return [...sets.values()].filter(s => Object.keys(s.teeth.upper).length + Object.keys(s.teeth.lower).length > 0);
}

// ZIP (ook een ZIP in een ZIP, en WinZip-AES-versleuteld) of een losse lijst bestanden.
export async function readLibraryZip(source, { password = null, onProgress, depth = 0 } = {}) {
  const entries = await listZip(source);
  const nested = entries.filter(e => /\.zip$/i.test(e.name));
  const files = entries.filter(e => classifyPath(e.name)).map(e => ({ path: e.name, read: () => readZipEntry(source, e, { password }) }));
  let sets = files.length ? await collect(files, onProgress) : [];
  if (depth < 2) for (const e of nested) {
    onProgress?.(0, `${e.name} uitpakken…`);
    const inner = await readZipEntry(source, e, { password });
    sets = sets.concat(await readLibraryZip(inner, { password, onProgress, depth: depth + 1 }));
  }
  if (depth === 0 && !sets.length) throw Error('Geen tandenbibliotheek gevonden (verwacht: <set>/upperjaw/1.eoff … en metadata/<set>/upperjaw.xml).');
  return sets;
}

export async function readLibraryFiles(fileList, opts = {}) {
  const arr = [...fileList];
  if (arr.length === 1 && /\.zip$/i.test(arr[0].name)) return readLibraryZip(arr[0], opts);
  const files = arr.map(f => ({ path: f.webkitRelativePath || f.name, read: () => f.arrayBuffer() }));
  const sets = await collect(files, opts.onProgress);
  for (const z of arr.filter(f => /\.zip$/i.test(f.name))) sets.push(...await readLibraryZip(z, opts));
  if (!sets.length) throw Error('Geen tandenbibliotheek gevonden in de gekozen bestanden.');
  return sets;
}

// ---------- opslag op het apparaat (IndexedDB) ----------
const DB = 'ddcad-library', VERSION = 1;
function openDB() {
  return new Promise((res, rej) => {
    if (typeof indexedDB === 'undefined') return rej(Error('Geen IndexedDB beschikbaar.'));
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains('sets')) db.createObjectStore('sets', { keyPath: 'key' }); if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
const tx = (db, store, mode, fn) => new Promise((res, rej) => { const t = db.transaction(store, mode); const out = fn(t.objectStore(store)); t.oncomplete = () => res(out?.result ?? out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || Error('Opslaan afgebroken (opslag vol?).')); });

export function setMeta(s, source = '') {
  const count = j => Object.keys(s.teeth[j] || {}).length;
  let bytes = 0; for (const j of ['upper', 'lower']) for (const m of Object.values(s.teeth[j] || {})) bytes += m.positions.byteLength + m.indices.byteLength;
  return { key: setKey(s.name), name: s.name, upper: count('upper'), lower: count('lower'), bow: !!(s.bow.upper?.length || s.bow.lower?.length), bytes, source, added: Date.now() };
}
export async function saveSets(sets, source = '') {
  const db = await openDB();
  for (const s of sets) {
    const meta = setMeta(s, source);
    await tx(db, 'sets', 'readwrite', st => st.put({ key: meta.key, name: s.name, teeth: s.teeth, bow: s.bow, preview: s.preview }));
    await tx(db, 'meta', 'readwrite', st => st.put(meta));
    cache.set(meta.key, s);
  }
  db.close();
}
export async function listSets() {
  try { const db = await openDB(); const all = await tx(db, 'meta', 'readonly', st => st.getAll()); db.close(); return (all || []).sort((a, b) => a.name.localeCompare(b.name, 'nl', { numeric: true })); } catch { return []; }
}
const cache = new Map();
export async function loadSet(name) {
  const key = setKey(name);
  if (cache.has(key)) return cache.get(key);
  const db = await openDB(); const s = await tx(db, 'sets', 'readonly', st => st.get(key)); db.close();
  if (!s) throw Error(`Bibliotheek "${name}" niet gevonden op dit apparaat.`);
  cache.set(key, s); return s;
}
export async function deleteSet(name) { const key = setKey(name); const db = await openDB(); await tx(db, 'sets', 'readwrite', st => st.delete(key)); await tx(db, 'meta', 'readwrite', st => st.delete(key)); db.close(); cache.delete(key); crownCache.clear(); }
export function registerSet(s) { cache.set(setKey(s.name), s); } // voor tests en tijdelijke sets

// ---------- kroon → element ----------
// Lokale assen van de app (zelfde als crowns.js): x = mesiodistaal, y = tandas (hals 0 → occlusaal +), z = buccaal.
const crownCache = new Map();
export function prepareCrown(raw, fdi = 11) {
  // exocad (x mesiaal, y buccaal, z occlusaal) → app (x, y = occlusaal, z = buccaal)
  const p = raw.positions, n = p.length / 3, pos = new Float32Array(p.length);
  for (let i = 0; i < n; i++) { pos[i * 3] = p[i * 3]; pos[i * 3 + 1] = p[i * 3 + 2]; pos[i * 3 + 2] = p[i * 3 + 1]; }
  let mesh = { positions: pos, indices: raw.indices.slice() };
  // kleine gaatjes dicht, de hals (grootste rand) blijft open
  let { loops } = boundaryLoops(mesh, edgeMap(mesh));
  if (!loops.length) {
    // gesloten tand met wortel: afsnijden op de geschatte glazuur-cementgrens (top − kroonhoogte uit de tabel)
    let top = -Infinity; for (let i = 1; i < pos.length; i += 3) top = Math.max(top, pos[i]);
    mesh = cutBelow(mesh, top - toothDimensions(fdi, 1).height);
    loops = boundaryLoops(mesh, edgeMap(mesh)).loops;
  } else {
    // kleine gaatjes dicht, de hals (grootste rand) blijft open
    mesh = fillHoles(mesh, { keepLargest: true, maxEdges: 400 }).mesh;
    loops = boundaryLoops(mesh, edgeMap(mesh)).loops;
  }
  if (!loops.length) throw Error('Kroon heeft geen open hals.');
  const len = l => { let s = 0; for (let i = 0; i < l.length; i++) { const a = l[i] * 3, b = l[(i + 1) % l.length] * 3; s += Math.hypot(mesh.positions[a] - mesh.positions[b], mesh.positions[a + 1] - mesh.positions[b + 1], mesh.positions[a + 2] - mesh.positions[b + 2]); } return s; };
  const loop = loops.reduce((a, b) => len(b) > len(a) ? b : a);
  // hals op y = 0 (gemiddelde halshoogte), kroon zijdelings gecentreerd op het halsmidden
  let cx = 0, cy = 0, cz = 0;
  for (const v of loop) { cx += mesh.positions[v * 3]; cy += mesh.positions[v * 3 + 1]; cz += mesh.positions[v * 3 + 2]; }
  cx /= loop.length; cy /= loop.length; cz /= loop.length;
  const q = mesh.positions;
  for (let i = 0; i < q.length; i += 3) { q[i] -= cx; q[i + 1] -= cy; q[i + 2] -= cz; }
  let top = -Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < q.length; i += 3) { top = Math.max(top, q[i + 1]); minX = Math.min(minX, q[i]); maxX = Math.max(maxX, q[i]); minZ = Math.min(minZ, q[i + 2]); maxZ = Math.max(maxZ, q[i + 2]); }
  return { mesh, loop, occlusalY: top, md: maxX - minX, bl: maxZ - minZ, offset: [cx, cy, cz] };
}

// Alles onder y = c wegsnijden (driehoeken op de snijlijn exact gesplitst; snijpunten per ribbe gedeeld).
export function cutBelow(mesh, c) {
  const P = mesh.positions, I = mesh.indices, out = Array.from(P), tri = [], cache = new Map();
  const cut = (a, b) => {
    const k = a < b ? a + ',' + b : b + ',' + a; if (cache.has(k)) return cache.get(k);
    const ya = P[a * 3 + 1], yb = P[b * 3 + 1], t = (c - ya) / (yb - ya), id = out.length / 3;
    out.push(P[a * 3] + t * (P[b * 3] - P[a * 3]), c, P[a * 3 + 2] + t * (P[b * 3 + 2] - P[a * 3 + 2]));
    cache.set(k, id); return id;
  };
  for (let f = 0; f < I.length; f += 3) {
    const v = [I[f], I[f + 1], I[f + 2]], up = v.map(i => P[i * 3 + 1] >= c), n = up.filter(Boolean).length;
    if (n === 3) { tri.push(...v); continue; }
    if (n === 0) continue;
    // roteer zodat het patroon begint bij de afwijkende hoek
    let r = 0; while (up[r] === (n === 1 ? false : true)) r++;
    const a = v[r], b = v[(r + 1) % 3], d = v[(r + 2) % 3];
    if (n === 1) tri.push(a, cut(a, b), cut(a, d));               // alleen a boven
    else { const ab = cut(b, a), ad = cut(d, a); tri.push(b, d, ad, b, ad, ab); } // a onder, b en d boven
  }
  // ongebruikte hoekpunten opruimen
  const used = new Int32Array(out.length / 3).fill(-1), pos = [];
  const idx = tri.map(i => { if (used[i] < 0) { used[i] = pos.length / 3; pos.push(out[i * 3], out[i * 3 + 1], out[i * 3 + 2]); } return used[i]; });
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

export function crownFor(set, jaw, type) {
  const key = setKey(set.name) + '|' + jaw + '|' + type;
  if (!crownCache.has(key)) {
    const raw = set.teeth[jaw]?.[type];
    if (!raw) return null;
    crownCache.set(key, prepareCrown(raw, (jaw === 'upper' ? 10 : 30) + type));
  }
  return crownCache.get(key);
}

export function hasTooth(set, fdi) { const q = Math.floor(fdi / 10); return !!set.teeth[q <= 2 ? 'upper' : 'lower']?.[fdi % 10]; }

// Gesloten element: kroon + korte, iets taps toelopende wortelstomp voor verankering in de basis.
// mirror = true spiegelt mesiodistaal (andere kaakhelft). Geeft geïndexeerde mesh + soup.
export function libraryTooth(set, fdi, { scale = 1, rootLength = 4, mirror = false } = {}) {
  const q = Math.floor(fdi / 10), jaw = q <= 2 ? 'upper' : 'lower';
  const c = crownFor(set, jaw, fdi % 10);
  if (!c) return null;
  const P = c.mesh.positions, I = c.mesh.indices, nv = P.length / 3, L = c.loop, m = L.length;
  const root = Math.max(0.6, rootLength);
  let minLoopY = Infinity; for (const v of L) minLoopY = Math.min(minLoopY, P[v * 3 + 1]);
  const pos = new Float32Array((nv + 2 * m + 1) * 3); pos.set(P);
  for (let k = 0; k < m; k++) {
    const v = L[k] * 3, x = P[v], y = P[v + 1], z = P[v + 2];
    pos.set([x * 0.96, y - 0.6, z * 0.96], (nv + k) * 3);
    pos.set([x * 0.72, minLoopY - root, z * 0.72], (nv + m + k) * 3);
  }
  pos.set([0, minLoopY - root, 0], (nv + 2 * m) * 3);
  const idx = new Uint32Array(I.length + m * 3 * 5); idx.set(I);
  let o = I.length;
  // De rand loopt in de mesh als a→b; de aansluitende vlakken gebruiken b→a.
  for (let k = 0; k < m; k++) {
    const a = L[k], b = L[(k + 1) % m], a1 = nv + k, b1 = nv + (k + 1) % m, a2 = nv + m + k, b2 = nv + m + (k + 1) % m, c0 = nv + 2 * m;
    idx[o++] = b; idx[o++] = a; idx[o++] = a1; idx[o++] = b; idx[o++] = a1; idx[o++] = b1;
    idx[o++] = b1; idx[o++] = a1; idx[o++] = a2; idx[o++] = b1; idx[o++] = a2; idx[o++] = b2;
    idx[o++] = b2; idx[o++] = a2; idx[o++] = c0;
  }
  // schaal en spiegel
  for (let i = 0; i < pos.length; i += 3) { pos[i] *= mirror ? -scale : scale; pos[i + 1] *= scale; pos[i + 2] *= scale; }
  if (mirror) for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  // buitenwaarts gericht (positief volume)
  if (signedVolume(pos, idx) < 0) for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  const soup = new Float32Array(idx.length * 3);
  for (let i = 0; i < idx.length; i++) { const v = idx[i] * 3; soup[i * 3] = pos[v]; soup[i * 3 + 1] = pos[v + 1]; soup[i * 3 + 2] = pos[v + 2]; }
  return { soup, mesh: { positions: pos, indices: idx }, occlusalY: c.occlusalY * scale, cervicalY: 0, md: c.md * scale, bl: c.bl * scale, height: c.occlusalY * scale, root };
}

export function signedVolume(p, f) {
  let v = 0;
  for (let i = 0; i < f.length; i += 3) {
    const a = f[i] * 3, b = f[i + 1] * 3, c = f[i + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

// ---------- ideale opstelling uit de bibliotheek (ToothBow) ----------
// Per element: tip (mesiodistale angulatie, + = kroon naar mesiaal), torque (+ = kroon naar buccaal) en
// niveau (occlusaal hoogste punt t.o.v. het gemiddelde vlak, + = voorbij het vlak). Zo neemt de app de
// door de bibliotheekmaker gekozen standen, curve van Spee en compensatiecurve over op de eigen kamlijn.
export function bowIdeal(set, jaw) {
  const bow = set.bow?.[jaw];
  if (!bow || bow.length < 4) return null;
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => { const l = Math.hypot(...a) || 1; return a.map(x => x / l); };
  // vlak: kleinste-kwadraten via de gemiddelde occlusale as (stabiel genoeg voor een tandboog)
  const C = [0, 1, 2].map(i => bow.reduce((s, t) => s + t.pos[i], 0) / bow.length);
  let n = norm([0, 1, 2].map(i => bow.reduce((s, t) => s + t.occ[i], 0)));
  // verfijn: normaal van het vlak door de posities (covariantie, kleinste eigenwaarde ~ n)
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const t of bow) { const d = sub(t.pos, C); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += d[i] * d[j]; }
  let v = n.slice();
  for (let it = 0; it < 30; it++) { // inverse iteratie op (cov + εI)
    const A = cov.map((r, i) => r.map((x, j) => x + (i === j ? 1e-6 : 0)));
    v = norm(solve3(A, v));
  }
  if (dot(v, n) < 0) v = v.map(x => -x);
  n = v;
  const out = {}, levels = [];
  for (const t of bow) {
    const type = t.fdi % 10, crown = crownFor(set, jaw, type);
    let mes = norm(sub(t.mes, n.map(x => x * dot(t.mes, n))));
    let buc = norm(cross(n, mes));
    const toCenter = sub(C, t.pos);
    if (dot(buc, toCenter) > 0) buc = buc.map(x => -x);
    const o = norm(t.occ);
    const tip = Math.atan2(dot(o, mes), dot(o, n)) * 180 / Math.PI;
    const torque = Math.atan2(dot(o, buc), dot(o, n)) * 180 / Math.PI;
    // hoogste punt langs n van de geplaatste kroon (exocad-lokaal: x = mesiale as, y = buccaal, z = occlusaal)
    let level = dot(sub(t.pos, C), n);
    if (crown) {
      const e = set.teeth[jaw][type].positions, M = norm(t.mes), O = o;
      let Bx = norm(cross(O, M)); // lokale +y
      const right = dot(Bx, buc) > 0 ? 1 : -1; Bx = Bx.map(x => x * right);
      let best = -Infinity;
      for (let i = 0; i < e.length; i += 9) {
        const w = [0, 1, 2].map(k => t.pos[k] + M[k] * e[i] + Bx[k] * e[i + 1] + O[k] * e[i + 2]);
        best = Math.max(best, dot(sub(w, C), n));
      }
      level = best;
    }
    out[t.fdi] = { tip, torque, level };
    levels.push(level);
  }
  const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
  for (const k in out) out[k].level -= mean;
  return out;
}

function solve3(A, b) {
  const [a, c, d] = A, det = a[0] * (c[1] * d[2] - c[2] * d[1]) - a[1] * (c[0] * d[2] - c[2] * d[0]) + a[2] * (c[0] * d[1] - c[1] * d[0]);
  if (Math.abs(det) < 1e-18) return b;
  const r = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const M = (col) => { const m = [a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]]; m[col] = b[0]; m[3 + col] = b[1]; m[6 + col] = b[2]; return m; };
  return [r(M(0)) / det, r(M(1)) / det, r(M(2)) / det];
}

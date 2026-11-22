// Booleaanse bewerkingen (vereniging/aftrekking) met de Manifold-bibliotheek (WebAssembly).
import { weld, clean, quality, repair, toSoup, edgeMap, compact, fillHoles } from './mesh.js';

let wasmPromise = null;
export function loadManifold() {
  wasmPromise ??= import('../vendor/manifold.js').then(async m => { const w = await m.default(); w.setup(); return w; });
  return wasmPromise;
}

export async function toManifold(soup) {
  const w = await loadManifold();
  const m = clean(weld(soup, 1e-5)).mesh;
  const mesh = new w.Mesh({ numProp: 3, vertProperties: m.positions, triVerts: m.indices });
  mesh.merge();
  const man = new w.Manifold(mesh);
  const status = man.status();
  if (status !== 'NoError') { man.delete(); throw Error('Geometrie is niet gesloten/manifold (' + status + ').'); }
  return man;
}

// Na een booleaanse bewerking: microscopische splinters samenvoegen zodat de STL na float32-export gesloten blijft.
// Probeert oplopende toleranties (max. 0,01 mm) tot de STL na float32-export gesloten en manifold is.
export function fromManifold(man, tolerance = 2e-4, opts = {}) {
  let out = null;
  for (const tol of [tolerance, 2e-3, 1e-2]) {
    out = fromManifoldOnce(man, tol, opts);
    const q = quality(weld(out, 1e-5));
    if (q.open === 0 && q.nonManifold === 0) return out;
  }
  return out;
}
function fromManifoldOnce(man, tolerance, { minVolume = 2 } = {}) {
  let clean = man, own = false;
  try { clean = man.simplify(tolerance); own = clean !== man; } catch { clean = man; }
  // Splinters (losse mini-stukjes waar delen elkaar net raken) weglaten.
  let pieces = null;
  try { pieces = clean.decompose(); } catch { pieces = null; }
  let out;
  if (pieces && pieces.length > 1) {
    const vols = pieces.map(p => Math.abs(p.volume())), big = Math.max(...vols);
    const keep = pieces.filter((p, i) => vols[i] >= Math.max(minVolume, big * 1e-3));
    out = concat(keep.map(p => meshToSoup(p)));
    for (const p of pieces) p.delete();
  } else {
    if (pieces) for (const p of pieces) p.delete();
    out = meshToSoup(clean);
  }
  if (own) clean.delete();
  return out;
}

function meshToSoup(man, snap = 1e-5) {
  const mesh = man.getMesh(), src = mesh.vertProperties, f = mesh.triVerts, n = mesh.numProp, count = src.length / n;
  // Punten die vrijwel samenvallen (na float32-afronding) worden samengevoegd; naaldfacetten vervallen.
  const rep = new Int32Array(count), pos = new Float32Array(count * 3), grid = new Map(), inv = 1 / snap;
  for (let v = 0; v < count; v++) {
    const x = Math.fround(src[v * n]), y = Math.fround(src[v * n + 1]), z = Math.fround(src[v * n + 2]);
    const key = Math.round(x * inv) + ',' + Math.round(y * inv) + ',' + Math.round(z * inv);
    let r = grid.get(key);
    if (r === undefined) { r = v; grid.set(key, v); }
    rep[v] = r; pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
  }
  const out = [];
  for (let i = 0; i < f.length; i += 3) {
    const a = rep[f[i]], b = rep[f[i + 1]], c = rep[f[i + 2]];
    if (a === b || b === c || a === c) continue;
    out.push(pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2], pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2], pos[c * 3], pos[c * 3 + 1], pos[c * 3 + 2]);
  }
  return Float32Array.from(out);
}

// Verenigt alle delen; delen die niet manifold zijn worden als losse lichamen toegevoegd.
export async function unionSoups(soups, report = {}) {
  const w = await loadManifold();
  const parts = [], loose = [];
  for (const s of soups) { if (!s?.length) continue; try { parts.push(await toManifold(s)); } catch { try { parts.push(await toManifold(heal(s))); report.healed = (report.healed || 0) + 1; } catch { loose.push(s); } } }
  report.loose = loose.length;
  if (!parts.length) return { soup: concat(loose), merged: false };
  const u = parts.length === 1 ? parts[0] : w.Manifold.union(parts);
  const soup = fromManifold(u);
  for (const p of parts) p.delete();
  if (u !== parts[0]) u.delete();
  return { soup: loose.length ? concat([soup, ...loose]) : soup, merged: true };
}

export async function subtractSoups(base, cutters, report = {}) {
  const w = await loadManifold();
  const b = await toManifold(base), cs = [];
  report.skipped = 0;
  for (const s of cutters) { try { cs.push(await toManifold(s)); } catch { report.skipped++; } }
  if (!cs.length) { const r = fromManifold(b); b.delete(); return r; }
  const c = cs.length === 1 ? cs[0] : w.Manifold.union(cs);
  const r = b.subtract(c), out = fromManifold(r);
  b.delete(); r.delete(); for (const x of cs) x.delete(); if (c !== cs[0]) c.delete();
  return out;
}

function concat(list) { const n = list.reduce((s, a) => s + a.length, 0), o = new Float32Array(n); let k = 0; for (const a of list) { o.set(a, k); k += a.length; } return o; }

// Herstel voor een gesloten onderdeel dat net niet manifold is (bijv. samenvallende punten na aansluiten op de scan):
// facetten op niet-manifold randen weg, platte facetten weg, gaten dichten, oriënteren.
export function heal(soup) {
  let m = clean(weld(soup, 1e-4)).mesh;
  for (let pass = 0; pass < 3; pass++) {
    const bad = new Set(); for (const e of edgeMap(m).values()) if (e.count > 2) e.faces.forEach(f => bad.add(f));
    if (!bad.size) break;
    const f = m.indices, keep = []; for (let i = 0; i < f.length / 3; i++) if (!bad.has(i)) keep.push(f[i * 3], f[i * 3 + 1], f[i * 3 + 2]);
    m = fillHoles(compact({ positions: m.positions, indices: Uint32Array.from(keep) })).mesh;
  }
  return toSoup(repair(toSoup(m), { fill: true, tolerance: 1e-5 }).mesh);
}

// Booleaanse bewerkingen (vereniging/aftrekking) met de Manifold-bibliotheek (WebAssembly).
import { weld, clean, quality, repair, toSoup, edgeMap, compact, fillHoles } from './mesh.js';
import { axisBasis, outlinePolygon } from './trim.js';

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
// v68: stopt zodra een grotere tolerantie niets meer verbetert (raken twee delen elkaar echt, dan helpt samenvoegen
// niet en kostte elke extra poging op een grote plaat seconden).
export function fromManifold(man, tolerance = 2e-4, opts = {}) {
  let best = null, bestBad = Infinity;
  for (const tol of [tolerance, 2e-3, 1e-2]) {
    const out = fromManifoldOnce(man, tol, opts), q = quality(weld(out, 1e-5)), bad = q.open + q.nonManifold;
    if (bad === 0) return out;
    if (bad >= bestBad) break;
    best = out; bestBad = bad;
  }
  return best;
}
function fromManifoldOnce(man, tolerance, { minVolume = 2 } = {}) {
  let clean = man, own = false;
  try { clean = man.simplify(tolerance); own = clean !== man; } catch { clean = man; }
  // Splinters (losse mini-stukjes waar delen elkaar net raken) weglaten. v68: in JS op de eigen punten van Manifold
  // (zelfde regel als vroeger met decompose(), maar dat kostte op een grote plaat 4–9 s).
  const out = meshToSoup(clean, 1e-5, minVolume);
  if (own) clean.delete();
  return out;
}

function meshToSoup(man, snap = 1e-5, minVolume = null) {
  const mesh = man.getMesh(), src = mesh.vertProperties, f = mesh.triVerts, n = mesh.numProp, count = src.length / n, nf = f.length / 3;
  // samenhangende delen (Manifold-mesh is manifold: verbonden via punten = verbonden via randen)
  let keepRoot = null, parent = null;
  if (minVolume != null && nf) {
    parent = new Int32Array(count); for (let v = 0; v < count; v++) parent[v] = v;
    const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (let i = 0; i < f.length; i += 3) { const a = find(f[i]), b = find(f[i + 1]), c = find(f[i + 2]); parent[b] = a; parent[find(c)] = a; }
    for (let v = 0; v < count; v++) parent[v] = find(v);
    const vol = new Map();
    for (let i = 0; i < f.length; i += 3) {
      const a = f[i] * n, b = f[i + 1] * n, c = f[i + 2] * n, ax = src[a], ay = src[a + 1], az = src[a + 2], bx = src[b], by = src[b + 1], bz = src[b + 2], cx = src[c], cy = src[c + 1], cz = src[c + 2];
      const r = parent[f[i]]; vol.set(r, (vol.get(r) || 0) + (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6);
    }
    if (vol.size > 1) { const big = Math.max(...[...vol.values()].map(Math.abs)); keepRoot = new Set([...vol].filter(([, v]) => Math.abs(v) >= Math.max(minVolume, big * 1e-3)).map(([r]) => r)); }
  }
  // Punten die vrijwel samenvallen (na float32-afronding) worden samengevoegd; naaldfacetten vervallen.
  const rep = new Int32Array(count), pos = new Float32Array(count * 3), inv = 1 / snap;
  let size = 16; while (size < count * 1.5 + 16) size *= 2;
  const mask = size - 1, table = new Int32Array(size).fill(-1), K = new Float64Array(count * 3);
  for (let v = 0; v < count; v++) {
    const x = Math.fround(src[v * n]), y = Math.fround(src[v * n + 1]), z = Math.fround(src[v * n + 2]);
    const kx = Math.round(x * inv), ky = Math.round(y * inv), kz = Math.round(z * inv);
    let h = (Math.imul(kx | 0, 73856093) ^ Math.imul(ky | 0, 19349663) ^ Math.imul(kz | 0, 83492791)) & mask, r = -1;
    for (;;) { const id = table[h]; if (id < 0) { table[h] = v; r = v; K[v * 3] = kx; K[v * 3 + 1] = ky; K[v * 3 + 2] = kz; break; } if (K[id * 3] === kx && K[id * 3 + 1] === ky && K[id * 3 + 2] === kz) { r = id; break; } h = (h + 1) & mask; }
    rep[v] = r; pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
  }
  const out = new Float32Array(f.length * 3); let o = 0;
  for (let i = 0; i < f.length; i += 3) {
    if (keepRoot && !keepRoot.has(parent[f[i]])) continue;
    const a = rep[f[i]], b = rep[f[i + 1]], c = rep[f[i + 2]];
    if (a === b || b === c || a === c) continue;
    out[o++] = pos[a * 3]; out[o++] = pos[a * 3 + 1]; out[o++] = pos[a * 3 + 2]; out[o++] = pos[b * 3]; out[o++] = pos[b * 3 + 1]; out[o++] = pos[b * 3 + 2]; out[o++] = pos[c * 3]; out[o++] = pos[c * 3 + 1]; out[o++] = pos[c * 3 + 2];
  }
  return out.slice(0, o);
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

// v70: alleen het deel binnen een omtrek houden (prisma langs de insteekas N, 'inset' mm binnen de lijn). Zo loopt de
// gingivaband nooit voorbij de basisrand of in een frenulum-uitsparing; daar raakte hij eerst de rand van het
// weefselblok (niet-manifold randen), waardoor het anatomische tandvlees altijd werd vervangen door het eenvoudige.
export async function clipToOutline(soup, outline, N, { inset = 0.4, step = 0.5 } = {}) {
  const w = await loadManifold();
  const basis = axisBasis(N), U = basis.U, V = basis.V, n = basis.N;
  const poly = outlinePolygon(outline, basis, { step });
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < soup.length; i += 3) { const d = soup[i] * n[0] + soup[i + 1] * n[1] + soup[i + 2] * n[2]; if (d < lo) lo = d; if (d > hi) hi = d; }
  for (const p of outline) { const d = p[0] * n[0] + p[1] * n[1] + p[2] * n[2]; if (d < lo) lo = d; if (d > hi) hi = d; }
  lo -= 5; hi += 5;
  let cs = new w.CrossSection([poly], 'Positive');
  if (inset > 0) { const c2 = cs.offset(-inset, 'Round', 2, 24); cs.delete(); cs = c2; }
  const local = cs.extrude(hi - lo); cs.delete();
  const prism = local.warp(v => { const x = v[0], y = v[1], z = v[2] + lo; v[0] = x * U[0] + y * V[0] + z * n[0]; v[1] = x * U[1] + y * V[1] + z * n[1]; v[2] = x * U[2] + y * V[2] + z * n[2]; });
  local.delete();
  const m = await toManifold(soup), r = m.intersect(prism), out = fromManifold(r);
  m.delete(); prism.delete(); r.delete();
  return out;
}

// v72: samenvoegen en daarna aftrekken in één keer (zonder tussentijdse STL): de tussenstap na float32-export kon
// net niet-manifold zijn (twee delen die elkaar raken), waarna het aftrekken weigerde.
export async function unionSubtract(soups, cutters, report = {}) {
  const w = await loadManifold();
  const parts = [], loose = [];
  for (const s of soups) { if (!s?.length) continue; try { parts.push(await toManifold(s)); } catch { try { parts.push(await toManifold(heal(s))); report.healed = (report.healed || 0) + 1; } catch { loose.push(s); } } }
  report.loose = loose.length;
  if (!parts.length) return concat(loose);
  const cs = []; report.skipped = 0;
  for (const s of cutters) { if (!s?.length) continue; try { cs.push(await toManifold(s)); } catch { report.skipped++; } }
  const u = parts.length === 1 ? parts[0] : w.Manifold.union(parts);
  let r = u;
  if (cs.length) { const c = cs.length === 1 ? cs[0] : w.Manifold.union(cs); r = u.subtract(c); if (c !== cs[0]) c.delete(); }
  const out = fromManifold(r);
  if (r !== u) r.delete(); if (u !== parts[0]) u.delete();
  for (const x of [...parts, ...cs]) x.delete();
  return loose.length ? concat([out, ...loose]) : out;
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

// Aftrekken met kandidaat-snijders (v68): de basis wordt één keer omgezet (zo nodig hersteld) en de snijders worden pas
// gemaakt als ze nodig zijn; de eerste die lukt telt. Lukt de basis niet, dan direct stoppen (geen nutteloze pogingen).
// Geeft { soup, used: index van de gebruikte snijder of -1, error }.
export async function subtractFirst(base, makers, report = {}) {
  await loadManifold();
  let b;
  try { b = await toManifold(base); }
  catch { try { b = await toManifold(heal(base)); report.healedBase = true; } catch (e) { return { soup: base, used: -1, error: 'plaat niet manifold: ' + (e?.message ?? e) }; } }
  let lastErr = null;
  try {
    for (let i = 0; i < makers.length; i++) {
      let c = null;
      try { const s = await makers[i](); try { c = await toManifold(s); } catch { c = await toManifold(heal(s)); } }
      catch (e) { lastErr = e?.message ?? String(e); continue; }
      try { const r = b.subtract(c), out = fromManifold(r); r.delete(); if (out?.length) return { soup: out, used: i }; }
      catch (e) { lastErr = e?.message ?? String(e); }
      finally { c.delete(); }
    }
  } finally { b.delete(); }
  return { soup: base, used: -1, error: lastErr };
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

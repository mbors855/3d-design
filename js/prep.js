// Scan voorbereiden: analyseren, repareren, artefacten verwijderen en ontbrekende randdelen aanvullen.
// Uitgangspunt: punten van de scan worden nooit verschoven (nauwkeurigheid); er wordt alleen verwijderd of toegevoegd.
// Toegevoegde (ontworpen) facetten staan achteraan in de soup; report.designedFrom geeft de eerste index.
import { weld, clean, edgeMap, boundaryLoops, fillHoles, toSoup, compact, quality, loopLength } from './mesh.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dt = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const nrm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function faceComponents(mesh, edges = edgeMap(mesh)) {
  const n = mesh.indices.length / 3, parent = new Int32Array(n).map((_, i) => i);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (const e of edges.values()) for (let k = 1; k < e.faces.length; k++) parent[find(e.faces[0])] = find(e.faces[k]);
  const comp = new Int32Array(n); for (let i = 0; i < n; i++) comp[i] = find(i);
  return comp;
}
function faceArea(p, f, i) { const a = f[i * 3] * 3, b = f[i * 3 + 1] * 3, c = f[i * 3 + 2] * 3; const u = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]], v = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]]; return Math.hypot(...crs(u, v)) / 2; }

/** Spikes: punten die ver buiten het vlak van hun buren steken (scanruis, 'naalden'). */
function findSpikes(mesh, { factor = 3, minHeight = 0.25 } = {}) {
  const p = mesh.positions, f = mesh.indices, nv = p.length / 3, nb = Array.from({ length: nv }, () => []);
  const lens = [];
  for (let i = 0; i < f.length; i += 3) for (let k = 0; k < 3; k++) { const a = f[i + k], b = f[i + (k + 1) % 3]; nb[a].push(b); if (lens.length < 20000) lens.push(Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2])); }
  lens.sort((x, y) => x - y); const med = lens[lens.length >> 1] || 0.3;
  const spikes = [];
  for (let v = 0; v < nv; v++) {
    const ring = [...new Set(nb[v])]; if (ring.length < 3) continue;
    const c = [0, 0, 0]; for (const w of ring) { c[0] += p[w * 3] / ring.length; c[1] += p[w * 3 + 1] / ring.length; c[2] += p[w * 3 + 2] / ring.length; }
    // vlak door de buren: kleinste hoofdas van hun spreiding (PCA)
    const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const w of ring) { const d = [p[w * 3] - c[0], p[w * 3 + 1] - c[1], p[w * 3 + 2] - c[2]]; for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) C[r * 3 + k] += d[r] * d[k]; }
    const mul = x => [C[0] * x[0] + C[1] * x[1] + C[2] * x[2], C[3] * x[0] + C[4] * x[1] + C[5] * x[2], C[6] * x[0] + C[7] * x[1] + C[8] * x[2]];
    let e1 = [1, 0.3, 0.2]; for (let it = 0; it < 25; it++) e1 = nrm(mul(e1));
    let e2 = nrm(crs(e1, [0.2, 1, 0.4])); for (let it = 0; it < 25; it++) { const y = mul(e2); const pr = dt(y, e1); e2 = nrm([y[0] - pr * e1[0], y[1] - pr * e1[1], y[2] - pr * e1[2]]); }
    const n = nrm(crs(e1, e2));
    const h = Math.abs(dt(sub([p[v * 3], p[v * 3 + 1], p[v * 3 + 2]], c), n));
    let spread = 0; for (const w of ring) spread = Math.max(spread, Math.hypot(p[w * 3] - c[0], p[w * 3 + 1] - c[1], p[w * 3 + 2] - c[2]));
    if (h > Math.max(minHeight, factor * med) && h > 1.5 * spread) spikes.push(v);
  }
  return { spikes, medianEdge: med };
}

/** Analyse van een (ruwe) scan: wat is er mis en wat zal de reparatie doen. */
export function analyzeScan(soup) {
  const mesh = weld(soup, 1e-5), q = quality(mesh), edges = edgeMap(mesh), comp = faceComponents(mesh, edges);
  const area = new Map(); let total = 0;
  for (let i = 0; i < comp.length; i++) { const a = faceArea(mesh.positions, mesh.indices, i); area.set(comp[i], (area.get(comp[i]) || 0) + a); total += a; }
  const sizes = [...area.values()].sort((a, b) => b - a);
  const { spikes, medianEdge } = findSpikes(mesh);
  const { loops } = boundaryLoops(mesh, edges);
  return { faces: q.faces, vertices: q.vertices, components: sizes.length, smallComponents: sizes.slice(1).filter(s => s < total * 0.05).length, mainShare: sizes[0] / (total || 1), open: q.open, holes: loops.length, nonManifold: q.nonManifold, degenerate: q.degenerate, spikes: spikes.length, medianEdge, closed: q.open === 0, area: total };
}

/**
 * Reparatie zonder punten te verplaatsen: ongeldige/platte/dubbele facetten, kleine losse delen (< minShare van het
 * grootste deel), spikes en niet-manifold facetten weg; kleine gaten (≤ maxHoleEdges randen) dichten.
 */
export function repairScan(soup, { minShare = 0.05, maxHoleEdges = 60, spikes = true } = {}) {
  const report = { before: soup.length / 9 };
  let finite = soup;
  for (let i = 0; i < soup.length; i++) if (!Number.isFinite(soup[i])) { const out = []; for (let j = 0; j < soup.length; j += 9) { let ok = true; for (let k = 0; k < 9; k++) if (!Number.isFinite(soup[j + k])) ok = false; if (ok) for (let k = 0; k < 9; k++) out.push(soup[j + k]); } finite = Float32Array.from(out); break; }
  report.invalid = (soup.length - finite.length) / 9;
  const c = clean(weld(finite, 1e-5)); let mesh = c.mesh; report.flat = c.flat; report.duplicate = c.duplicate;
  // spikes: facetten rond het punt weg (het gat wordt hieronder gedicht)
  report.spikes = 0;
  if (spikes) for (let pass = 0; pass < 2; pass++) {
    const { spikes: sp } = findSpikes(mesh); if (!sp.length) break;
    const bad = new Set(sp), f = mesh.indices, keep = [];
    for (let i = 0; i < f.length; i += 3) if (!bad.has(f[i]) && !bad.has(f[i + 1]) && !bad.has(f[i + 2])) keep.push(f[i], f[i + 1], f[i + 2]);
    mesh = compact({ positions: mesh.positions, indices: Uint32Array.from(keep) }); report.spikes += sp.length;
  }
  // niet-manifold randen: kleinste betrokken facetten weg tot elke rand ≤ 2 facetten heeft
  let edges = edgeMap(mesh); report.nonManifold = 0;
  { const drop = new Set(); for (const e of edges.values()) if (e.count > 2) { const fs = e.faces.slice().sort((a, b) => faceArea(mesh.positions, mesh.indices, a) - faceArea(mesh.positions, mesh.indices, b)); for (const x of fs.slice(0, e.count - 2)) drop.add(x); }
    if (drop.size) { const f = mesh.indices, keep = []; for (let i = 0; i < f.length / 3; i++) if (!drop.has(i)) keep.push(f[i * 3], f[i * 3 + 1], f[i * 3 + 2]); mesh = compact({ positions: mesh.positions, indices: Uint32Array.from(keep) }); report.nonManifold = drop.size; edges = edgeMap(mesh); } }
  // kleine losse delen
  const comp = faceComponents(mesh, edges), area = new Map();
  for (let i = 0; i < comp.length; i++) area.set(comp[i], (area.get(comp[i]) || 0) + faceArea(mesh.positions, mesh.indices, i));
  const biggest = Math.max(...area.values());
  { const f = mesh.indices, keep = []; let removed = 0; for (let i = 0; i < comp.length; i++) { if (area.get(comp[i]) >= biggest * minShare) keep.push(f[i * 3], f[i * 3 + 1], f[i * 3 + 2]); else removed++; }
    mesh = compact({ positions: mesh.positions, indices: Uint32Array.from(keep) }); report.islandFaces = removed; report.islands = [...area.values()].filter(a => a < biggest * minShare).length; }
  // kleine gaten dichten (de grootste rand blijft open: dat is de scanrand)
  const repaired = toSoup(mesh), nOrig = repaired.length / 9;
  const loops = boundaryLoops(mesh).loops;
  let filledMesh = mesh, filled = 0;
  if (loops.length > 1) { const h = fillHoles(mesh, { keepLargest: true, maxEdges: maxHoleEdges }); filledMesh = h.mesh; filled = h.filled; }
  report.holesFilled = filled;
  const out = toSoup(filledMesh);
  report.after = out.length / 9; report.designedFrom = nOrig; // fillHoles voegt facetten achteraan toe
  return { soup: out, report };
}

/**
 * Ontbrekende randzone aanvullen: de open scanrand wordt met 'length' mm verlengd, in de richting waarin het
 * oppervlak liep (G1-aansluiting), licht gladgestreken zodat de nieuwe ringen elkaar niet kruisen.
 * onlyWhere(punt) kan beperken tot randdelen waar het nodig is (bijv. waar de plooi niet gescand is).
 * Nieuwe facetten komen achteraan; report.designedFrom = eerste nieuwe facet.
 */
export function extendBorder(soup, { length = 6, step = 0.6, bend = null, onlyWhere = null } = {}) {
  const mesh = weld(soup, 1e-6), p = mesh.positions, f = mesh.indices, edges = edgeMap(mesh);
  const { loops } = boundaryLoops(mesh, edges);
  if (!loops.length) return { soup, report: { extended: 0, designedFrom: soup.length / 9 } };
  const lens = loops.map(l => loopLength(mesh, l)), loop = loops[lens.indexOf(Math.max(...lens))];
  const P = v => [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]], m = loop.length;
  // per randpunt: richting naar buiten in het raakvlak (loodrecht op de rand, weg van het oppervlak)
  const faceOfEdge = new Map(); for (const e of edges.values()) if (e.count === 1) faceOfEdge.set(e.from + ',' + e.to, e.faces[0]);
  const dirs = loop.map((v, i) => {
    const a = P(loop[(i - 1 + m) % m]), b = P(loop[(i + 1) % m]), t = nrm(sub(b, a));
    const fi = faceOfEdge.get(v + ',' + loop[(i + 1) % m]) ?? faceOfEdge.get(loop[(i - 1 + m) % m] + ',' + v);
    let n = [0, 0, 1];
    if (fi !== undefined) { const A = P(f[fi * 3]), B = P(f[fi * 3 + 1]), C = P(f[fi * 3 + 2]); n = nrm(crs(sub(B, A), sub(C, A))); }
    let d = nrm(crs(t, n)); // in het vlak, loodrecht op de rand
    // naar buiten: weg van het binnenpunt van het randfacet
    if (fi !== undefined) { const c = [0, 1, 2].map(k => (p[f[fi * 3] * 3 + k] + p[f[fi * 3 + 1] * 3 + k] + p[f[fi * 3 + 2] * 3 + k]) / 3); if (dt(d, sub(P(v), c)) < 0) d = d.map(x => -x); }
    return d;
  });
  // richtingen gladstrijken langs de rand (geen kruisende ringen bij een grillige scanrand)
  let D = dirs;
  for (let it = 0; it < 6; it++) D = D.map((d, i) => nrm([0, 1, 2].map(k => D[(i - 1 + m) % m][k] + 2 * d[k] + D[(i + 1) % m][k])));
  const active = loop.map(v => onlyWhere ? onlyWhere(P(v)) : true);
  const rings = [loop.map(P)], steps = Math.max(1, Math.round(length / step));
  for (let s = 1; s <= steps; s++) {
    const prev = rings[s - 1];
    rings.push(prev.map((q, i) => {
      if (!active[i]) return q;
      let d = D[i]; if (bend) d = nrm([0, 1, 2].map(k => d[k] + bend[k] * 0.06 * s)); // optioneel buigen (richting plooi)
      return [q[0] + d[0] * step, q[1] + d[1] * step, q[2] + d[2] * step];
    }));
    // ring ontspannen: punten gelijkmatig tussen hun buren (geen plooien of kruisingen bij hoeken in de scanrand)
    const R = rings[s];
    for (let it = 0; it < 2; it++) { const c = R.map(q => q.slice()); for (let i = 0; i < m; i++) if (active[i]) for (let k = 0; k < 3; k++) R[i][k] = 0.25 * c[(i - 1 + m) % m][k] + 0.5 * c[i][k] + 0.25 * c[(i + 1) % m][k]; }
  }
  const out = Array.from(soup), designedFrom = soup.length / 9;
  // oriëntatie: randrand a→b behoort bij een bestaand facet; nieuwe facetten gebruiken b→a
  for (let s = 0; s < steps; s++) for (let i = 0; i < m; i++) {
    const j = (i + 1) % m; if (!active[i] && !active[j]) continue;
    const a0 = rings[s][i], b0 = rings[s][j], a1 = rings[s + 1][i], b1 = rings[s + 1][j];
    const tri = (x, y, z) => { const ar = Math.hypot(...crs(sub(y, x), sub(z, x))); if (ar > 1e-9) out.push(...x, ...y, ...z); };
    tri(b0, a0, a1); tri(b0, a1, b1);
  }
  return { soup: Float32Array.from(out), report: { extended: active.filter(Boolean).length, rings: steps, designedFrom } };
}

/** Alleen het samenhangende deel dat het punt bevat (bijv. de kamtop) houden: sokkel/tafel onder de kaak valt weg. */
export function keepComponentNear(soup, point) {
  const mesh = weld(soup, 1e-6), comp = faceComponents(mesh), p = mesh.positions, f = mesh.indices;
  let best = -1, bd = Infinity;
  for (let i = 0; i < f.length; i++) { const v = f[i] * 3, d = (p[v] - point[0]) ** 2 + (p[v + 1] - point[1]) ** 2 + (p[v + 2] - point[2]) ** 2; if (d < bd) { bd = d; best = comp[Math.floor(i / 3)]; } }
  const out = []; let removed = 0;
  for (let i = 0; i < comp.length; i++) { if (comp[i] === best) for (let k = 0; k < 9; k++) out.push(soup[i * 9 + k]); else removed++; }
  return { soup: Float32Array.from(out), removed };
}

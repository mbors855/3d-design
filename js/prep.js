// Scan voorbereiden: analyseren, repareren, artefacten verwijderen en ontbrekende randdelen aanvullen.
// Uitgangspunt: punten van de scan worden nooit verschoven (nauwkeurigheid); er wordt alleen verwijderd of toegevoegd.
// Toegevoegde (ontworpen) facetten staan achteraan in de soup; report.designedFrom geeft de eerste index.
import { weld, clean, edgeMap, boundaryLoops, fillHoles, toSoup, compact, quality, loopLength } from './mesh.js';
import { nearNormals } from './border.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dt = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const nrm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function faceComponents(mesh, edges = edgeMap(mesh)) {
  const n = mesh.indices.length / 3, parent = new Int32Array(n).map((_, i) => i);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let e = 0; e < edges.n; e++) { const c = edges.count[e]; if (c < 2) continue; const fs = c === 2 ? null : edges.faces(e), f0 = edges.f0[e]; for (let k = 1; k < c; k++) parent[find(f0)] = find(k === 1 ? edges.f1[e] : fs[k]); }
  const comp = new Int32Array(n); for (let i = 0; i < n; i++) comp[i] = find(i);
  return comp;
}
function faceArea(p, f, i) { const a = f[i * 3] * 3, b = f[i * 3 + 1] * 3, c = f[i * 3 + 2] * 3; const u = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]], v = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]]; return Math.hypot(...crs(u, v)) / 2; }

/** Spikes: punten die ver buiten het vlak van hun buren steken (scanruis, 'naalden').
 * v68: zonder tijdelijke arrays per punt (zelfde rekenvolgorde en uitkomst als v67, ±6× sneller). */
function findSpikes(mesh, { factor = 3, minHeight = 0.25 } = {}) {
  const p = mesh.positions, f = mesh.indices, nv = p.length / 3;
  // buren (opvolger in elk facet), per punt in volgorde van eerste voorkomen, zonder dubbele
  const deg = new Int32Array(nv + 1);
  for (let i = 0; i < f.length; i++) deg[f[i] + 1]++;
  for (let v = 0; v < nv; v++) deg[v + 1] += deg[v];
  const nb = new Int32Array(f.length), fill = deg.slice(0, nv);
  const lens = [];
  for (let i = 0; i < f.length; i += 3) for (let k = 0; k < 3; k++) {
    const a = f[i + k], b = f[i + (k + 1) % 3]; nb[fill[a]++] = b;
    if (lens.length < 20000) lens.push(Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]));
  }
  lens.sort((x, y) => x - y); const med = lens[lens.length >> 1] || 0.3;
  let maxDeg = 0; for (let v = 0; v < nv; v++) maxDeg = Math.max(maxDeg, deg[v + 1] - deg[v]);
  const spikes = [], ring = new Int32Array(maxDeg + 1), lim = Math.max(minHeight, factor * med);
  for (let v = 0; v < nv; v++) {
    let m = 0;
    for (let j = deg[v]; j < deg[v + 1]; j++) { const w = nb[j]; let dup = false; for (let r = 0; r < m; r++) if (ring[r] === w) { dup = true; break; } if (!dup) ring[m++] = w; }
    if (m < 3) continue;
    let cx = 0, cy = 0, cz = 0;
    for (let r = 0; r < m; r++) { const w = ring[r]; cx += p[w * 3] / m; cy += p[w * 3 + 1] / m; cz += p[w * 3 + 2] / m; }
    // vlak door de buren: kleinste hoofdas van hun spreiding (PCA)
    let c0 = 0, c1 = 0, c2 = 0, c3 = 0, c4 = 0, c5 = 0, c6 = 0, c7 = 0, c8 = 0;
    for (let r = 0; r < m; r++) {
      const w = ring[r], d0 = p[w * 3] - cx, d1 = p[w * 3 + 1] - cy, d2 = p[w * 3 + 2] - cz;
      c0 += d0 * d0; c1 += d0 * d1; c2 += d0 * d2; c3 += d1 * d0; c4 += d1 * d1; c5 += d1 * d2; c6 += d2 * d0; c7 += d2 * d1; c8 += d2 * d2;
    }
    let ex = 1, ey = 0.3, ez = 0.2;
    for (let it = 0; it < 25; it++) { const x = c0 * ex + c1 * ey + c2 * ez, y = c3 * ex + c4 * ey + c5 * ez, z = c6 * ex + c7 * ey + c8 * ez, l = Math.hypot(x, y, z) || 1; ex = x / l; ey = y / l; ez = z / l; }
    // e2 = nrm(e1 × [0.2, 1, 0.4])
    let fx = ey * 0.4 - ez * 1, fy = ez * 0.2 - ex * 0.4, fz = ex * 1 - ey * 0.2;
    { const l = Math.hypot(fx, fy, fz) || 1; fx /= l; fy /= l; fz /= l; }
    for (let it = 0; it < 25; it++) {
      const x = c0 * fx + c1 * fy + c2 * fz, y = c3 * fx + c4 * fy + c5 * fz, z = c6 * fx + c7 * fy + c8 * fz;
      const pr = x * ex + y * ey + z * ez, qx = x - pr * ex, qy = y - pr * ey, qz = z - pr * ez, l = Math.hypot(qx, qy, qz) || 1;
      fx = qx / l; fy = qy / l; fz = qz / l;
    }
    let nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
    { const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l; }
    const h = Math.abs((p[v * 3] - cx) * nx + (p[v * 3 + 1] - cy) * ny + (p[v * 3 + 2] - cz) * nz);
    if (!(h > lim)) continue;
    let spread = 0; for (let r = 0; r < m; r++) { const w = ring[r]; spread = Math.max(spread, Math.hypot(p[w * 3] - cx, p[w * 3 + 1] - cy, p[w * 3 + 2] - cz)); }
    if (h > 1.5 * spread) spikes.push(v);
  }
  return { spikes, medianEdge: med };
}

/** Analyse van een (ruwe) scan: wat is er mis en wat zal de reparatie doen. */
export function analyzeScan(soup, { spikes: withSpikes = true } = {}) {
  const mesh = weld(soup, 1e-5), q = quality(mesh), edges = edgeMap(mesh), comp = faceComponents(mesh, edges);
  const area = new Map(); let total = 0;
  for (let i = 0; i < comp.length; i++) { const a = faceArea(mesh.positions, mesh.indices, i); area.set(comp[i], (area.get(comp[i]) || 0) + a); total += a; }
  const sizes = [...area.values()].sort((a, b) => b - a);
  const { spikes, medianEdge } = withSpikes ? findSpikes(mesh) : { spikes: [], medianEdge: null };
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
  // v72: raaklijn over ±1,5 mm en normaal van het oppervlak binnen 2 mm, daarna gladgestreken over ±3 mm langs de rand.
  // Vroeger telde alleen het laatste randfacet: bij een grillige rand liepen de richtingen alle kanten op en werd
  // de aanvulling een verfrommelde rok.
  const faceOfEdge = new Map(); for (const e of edges.values()) if (e.count === 1) faceOfEdge.set(e.from + ',' + e.to, e.faces[0]);
  const cum = new Float64Array(m + 1); for (let i = 0; i < m; i++) cum[i + 1] = cum[i] + Math.hypot(...sub(P(loop[(i + 1) % m]), P(loop[i])));
  const total = cum[m], at = (i, ds) => { // index op booglengte ds van i (± richting)
    let j = i, s = 0; const dir = Math.sign(ds);
    while (s < Math.abs(ds) && Math.abs(j - i) < m) { const a = ((j % m) + m) % m, b = (((j + dir) % m) + m) % m; s += Math.hypot(...sub(P(loop[b]), P(loop[a]))); j += dir; }
    return ((j % m) + m) % m;
  };
  const normalNear = nearNormals(mesh, 2);
  const dirs = loop.map((v, i) => {
    const t = nrm(sub(P(loop[at(i, 1.5)]), P(loop[at(i, -1.5)])));
    const fi = faceOfEdge.get(v + ',' + loop[(i + 1) % m]) ?? faceOfEdge.get(loop[(i - 1 + m) % m] + ',' + v);
    let n = normalNear(P(v));
    if (!(Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]) > 0.1) && fi !== undefined) { const A = P(f[fi * 3]), B = P(f[fi * 3 + 1]), C = P(f[fi * 3 + 2]); n = nrm(crs(sub(B, A), sub(C, A))); }
    let d = nrm(crs(t, n)); // in het vlak, loodrecht op de rand
    // naar buiten: weg van het binnenpunt van het randfacet
    if (fi !== undefined) { const c = [0, 1, 2].map(k => (p[f[fi * 3] * 3 + k] + p[f[fi * 3 + 1] * 3 + k] + p[f[fi * 3 + 2] * 3 + k]) / 3); if (dt(d, sub(P(v), c)) < 0) d = d.map(x => -x); }
    return d;
  });
  // richtingen gladstrijken langs de rand (Gauss, σ = 3 mm over de booglengte): geen kruisende ringen
  const sigma = Math.min(3, total / 12), D = dirs.map((_, i) => {
    const acc = [0, 0, 0];
    for (const sgn of [1, -1]) { let j = i, s = 0; for (let k = 0; k < m && s <= sigma * 3; k++) { const w = Math.exp(-(s * s) / (2 * sigma * sigma)) * (k === 0 && sgn < 0 ? 0 : 1); for (let q = 0; q < 3; q++) acc[q] += dirs[j][q] * w; const nj = (j + sgn + m) % m; s += Math.hypot(...sub(P(loop[nj]), P(loop[j]))); j = nj; } }
    return nrm(acc);
  });
  const active = loop.map(v => onlyWhere ? onlyWhere(P(v)) : true);
  const rings = [loop.map(P)], steps = Math.max(1, Math.round(length / step));
  for (let s = 1; s <= steps; s++) {
    const prev = rings[s - 1];
    rings.push(prev.map((q, i) => {
      if (!active[i]) return q;
      let d = D[i]; if (bend) d = nrm([0, 1, 2].map(k => d[k] + bend[k] * 0.06 * s)); // optioneel buigen (richting plooi)
      return [q[0] + d[0] * step, q[1] + d[1] * step, q[2] + d[2] * step];
    }));
    // ring ontspannen: punten gelijkmatig tussen hun buren (geen plooien of kruisingen bij hoeken in de scanrand);
    // hoe verder van de scan, hoe gladder (de buitenrand van de aanvulling wordt een vloeiende lijn)
    const R = rings[s];
    for (let it = 0; it < 2 + Math.floor(s / 3); it++) { const c = R.map(q => q.slice()); for (let i = 0; i < m; i++) if (active[i]) for (let k = 0; k < 3; k++) R[i][k] = 0.25 * c[(i - 1 + m) % m][k] + 0.5 * c[i][k] + 0.25 * c[(i + 1) % m][k]; }
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

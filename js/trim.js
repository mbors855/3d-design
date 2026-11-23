// Exact uitsnijden van een scan langs een omtreklijn, geprojecteerd langs de insteekas (occlusale as).
//
// Werkwijze (zoals bij exocad/3Shape: de rand is een lijn op het model, de plaat volgt het model exact):
//  1. De omtrekpunten (3D, op de scan) worden langs de as N in een vlak geprojecteerd en met een
//     Catmull-Rom-spline tot een gladde, gesloten 2D-lijn verfijnd (desgewenst naar buiten verschoven: marge).
//  2. Per scanpunt wordt de signed afstand tot die lijn bepaald (negatief = binnen).
//  3. Vanaf het bovenste (zichtbare) oppervlak binnen de lijn wordt via gedeelde randen uitgebreid; zo komen
//     sokkel, onderkant en losse delen er niet bij, ook als ze binnen de lijn geprojecteerd liggen.
//  4. Facetten die geheel binnen liggen worden ongewijzigd overgenomen (exact, 0,000 mm afwijking); facetten
//     die de lijn kruisen worden langs het nulniveau gesneden (punten op de originele facetranden).
// Zo is de uitsnede onafhankelijk van het camerastandpunt en blijft het pasvlak bit-voor-bit gelijk aan de scan.
import { weld, boundaryLoops, rimDistances, loopLength } from './mesh.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export function axisBasis(N) {
  const n = norm(N), helper = Math.abs(n[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
  const U = norm(cross(helper, n)), V = cross(n, U);
  return { U, V, N: n, project: p => [dot(p, U), dot(p, V)], depth: p => dot(p, n) };
}

const area2 = P => { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };

/** Gesloten, gladde 2D-lijn (tegen de klok in) door de geprojecteerde omtrekpunten. step in mm, offset > 0 = naar buiten. */
export function outlinePolygon(points3D, basis, { step = 0.3, offset = 0 } = {}) {
  let P = points3D.map(basis.project);
  // dubbele punten weg
  P = P.filter((p, i) => Math.hypot(p[0] - P[(i + P.length - 1) % P.length][0], p[1] - P[(i + P.length - 1) % P.length][1]) > 1e-3);
  if (P.length < 3) throw Error('Te weinig omtrekpunten.');
  if (area2(P) < 0) P.reverse();
  // centripetale Catmull-Rom (geen lussen of overshoot bij ongelijke puntafstanden)
  const n = P.length, out = [];
  for (let i = 0; i < n; i++) {
    const p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n], p3 = P[(i + 2) % n];
    const d = (a, b) => Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), 0.5) || 1e-4;
    const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
    const seg = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), k = Math.max(1, Math.ceil(seg / step));
    for (let j = 0; j < k; j++) {
      const t = t1 + (t2 - t1) * j / k;
      const lerp = (a, b, ta, tb) => [0, 1].map(c => (tb - t) / (tb - ta) * a[c] + (t - ta) / (tb - ta) * b[c]);
      const A1 = lerp(p0, p1, t0, t1), A2 = lerp(p1, p2, t1, t2), A3 = lerp(p2, p3, t2, t3);
      const B1 = lerp(A1, A2, t0, t2), B2 = lerp(A2, A3, t1, t3);
      out.push(lerp(B1, B2, t1, t2));
    }
  }
  if (!offset) return out;
  // verschuiven langs de gemiddelde buitennormaal, daarna één gladstrijkronde tegen knikken
  const m = out.length, off = out.map((p, i) => {
    const a = out[(i - 1 + m) % m], b = out[(i + 1) % m], tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1;
    return [p[0] + ty / l * offset, p[1] - tx / l * offset]; // tegen de klok in: rechts van de raaklijn = buiten
  });
  return off.map((p, i) => { const a = off[(i - 1 + m) % m], b = off[(i + 1) % m]; return [(a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4]; });
}

/** Snelle punt-in-polygoon en afstand tot de lijn (rasterversnelling). */
export class PolygonField {
  constructor(poly, cell = 1) {
    this.poly = poly; this.cell = cell;
    const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
    this.x0 = Math.min(...xs) - 50; this.y0 = Math.min(...ys) - 50;
    this.rows = new Map(); this.grid = new Map();
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const r0 = Math.floor(Math.min(a[1], b[1]) / cell), r1 = Math.floor(Math.max(a[1], b[1]) / cell);
      for (let r = r0; r <= r1; r++) { if (!this.rows.has(r)) this.rows.set(r, []); this.rows.get(r).push(i); }
      const c0 = Math.floor(Math.min(a[0], b[0]) / cell), c1 = Math.floor(Math.max(a[0], b[0]) / cell);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const k = r * 100003 + c; if (!this.grid.has(k)) this.grid.set(k, []); this.grid.get(k).push(i); }
    }
  }
  inside(x, y) {
    const segs = this.rows.get(Math.floor(y / this.cell)) || [];
    let w = false;
    for (const i of segs) {
      const a = this.poly[i], b = this.poly[(i + 1) % this.poly.length];
      if ((a[1] > y) !== (b[1] > y) && x < a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0])) w = !w;
    }
    return w;
  }
  distance(x, y, maxR = 6) {
    const c = this.cell, r0 = Math.floor(y / c), c0 = Math.floor(x / c);
    let best = Infinity;
    for (let ring = 0; ring <= Math.ceil(maxR / c); ring++) {
      for (let r = r0 - ring; r <= r0 + ring; r++) for (let cc = c0 - ring; cc <= c0 + ring; cc++) {
        if (Math.max(Math.abs(r - r0), Math.abs(cc - c0)) !== ring) continue;
        for (const i of this.grid.get(r * 100003 + cc) || []) {
          const a = this.poly[i], b = this.poly[(i + 1) % this.poly.length], dx = b[0] - a[0], dy = b[1] - a[1];
          const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
          best = Math.min(best, Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy));
        }
      }
      if (best <= ring * c) break; // dichterbij kan niet meer
    }
    return best;
  }
  signed(x, y) { const d = Math.min(this.distance(x, y), 50); return this.inside(x, y) ? -d : d; }
  /** Alleen de kant: −1 binnen, +1 buiten of precies op de lijn (zelfde als het teken van signed(), zonder afstandszoektocht). */
  side(x, y) {
    if (!this.inside(x, y)) return 1;
    const c = this.cell;
    for (const i of this.grid.get(Math.floor(y / c) * 100003 + Math.floor(x / c)) || []) {
      const a = this.poly[i], b = this.poly[(i + 1) % this.poly.length], dx = b[0] - a[0], dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      if (Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy) === 0) return 1;
    }
    return -1;
  }
}

// Topologie per scan (zelfde Float32Array = zelfde scan) één keer opbouwen: gelaste punten, punt→facet-lijsten en
// per insteekas de projectie en een raster voor de zaadstralen. Zo kost een omtrekwijziging op een grote scan
// (1–2 miljoen facetten) geen seconden meer.
const TOPO = new WeakMap();
export function scanTopology(soup) {
  let t = TOPO.get(soup);
  if (!t) {
    const mesh = weld(soup, 1e-6), f = mesh.indices, nv = mesh.positions.length / 3;
    const start = new Int32Array(nv + 1);
    for (let i = 0; i < f.length; i++) start[f[i] + 1]++;
    for (let v = 0; v < nv; v++) start[v + 1] += start[v];
    const vf = new Int32Array(f.length), fill = start.slice(0, nv);
    for (let i = 0; i < f.length; i++) vf[fill[f[i]]++] = (i / 3) | 0;
    t = { mesh, start, vf, axes: new Map() };
    TOPO.set(soup, t);
  }
  return t;
}
function axisCache(t, basis, cell) {
  const key = basis.N.map(v => v.toFixed(6)).join(',');
  let a = t.axes.get(key);
  if (a) return a;
  const p = t.mesh.positions, f = t.mesh.indices, nv = p.length / 3, nf = f.length / 3, { U, V, N } = basis;
  const uv = new Float32Array(nv * 2), w = new Float32Array(nv);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let v = 0; v < nv; v++) {
    const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2], u = x * U[0] + y * U[1] + z * U[2], vv = x * V[0] + y * V[1] + z * V[2];
    uv[v * 2] = u; uv[v * 2 + 1] = vv; w[v] = x * N[0] + y * N[1] + z * N[2];
    if (u < u0) u0 = u; if (u > u1) u1 = u; if (vv < v0) v0 = vv; if (vv > v1) v1 = vv;
  }
  const gx0 = Math.floor(u0 / cell), gy0 = Math.floor(v0 / cell), nx = Math.max(1, Math.floor(u1 / cell) - gx0 + 1), ny = Math.max(1, Math.floor(v1 / cell) - gy0 + 1);
  const count = new Int32Array(nx * ny + 1);
  const each = (i, fn) => {
    const a = f[i * 3], b = f[i * 3 + 1], c = f[i * 3 + 2];
    const xa = uv[a * 2], xb = uv[b * 2], xc = uv[c * 2], ya = uv[a * 2 + 1], yb = uv[b * 2 + 1], yc = uv[c * 2 + 1];
    const cx0 = Math.floor(Math.min(xa, xb, xc) / cell) - gx0, cx1 = Math.floor(Math.max(xa, xb, xc) / cell) - gx0;
    const cy0 = Math.floor(Math.min(ya, yb, yc) / cell) - gy0, cy1 = Math.floor(Math.max(ya, yb, yc) / cell) - gy0;
    for (let gx = cx0; gx <= cx1; gx++) for (let gy = cy0; gy <= cy1; gy++) fn(gx * ny + gy);
  };
  for (let i = 0; i < nf; i++) each(i, k => { count[k + 1]++; });
  for (let k = 0; k < nx * ny; k++) count[k + 1] += count[k];
  const list = new Int32Array(count[nx * ny]), fill = count.slice(0, nx * ny);
  for (let i = 0; i < nf; i++) each(i, k => { list[fill[k]++] = i; });
  a = { uv, w, gx0, gy0, nx, ny, start: count, list };
  if (t.axes.size > 6) t.axes.clear();
  t.axes.set(key, a);
  return a;
}

/**
 * Snijdt de scan uit langs de omtrek. outline: 3D-punten (gesloten). N: insteekas (wijst naar de kijker/occlusaal).
 * opts.margin: mm naar buiten (bijv. 4 mm bij het bijsnijden van de scan, 0 voor het werkstuk).
 * Geeft { soup, faces: originele facetindices die (deels) behouden zijn, report }.
 */
export function trimByOutline(soup, outline, N, { margin = 0, step = 0.3, splitAt = null } = {}) {
  const basis = axisBasis(N), poly = outlinePolygon(outline, basis, { step, offset: margin });
  const field = new PolygonField(poly);
  const topo = scanTopology(soup), mesh = topo.mesh, p = mesh.positions, f = mesh.indices, nf = f.length / 3, nv = p.length / 3;
  const cell = 1, ax = axisCache(topo, basis, cell), uv = ax.uv, w = ax.w;
  const sd = new Float32Array(nv).fill(NaN);
  const S = v => { let d = sd[v]; if (d !== d) { d = field.side(uv[v * 2], uv[v * 2 + 1]); sd[v] = d; } return d; }; // alleen het teken telt
  // zaadfacetten: bovenste laag binnen de lijn (stralen langs -N op een raster van 0,8 mm)
  let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
  for (const q of poly) { if (q[0] < bx0) bx0 = q[0]; if (q[0] > bx1) bx1 = q[0]; if (q[1] < by0) by0 = q[1]; if (q[1] > by1) by1 = q[1]; }
  const seedFaces = new Set();
  for (let x = bx0; x <= bx1; x += 0.8) for (let y = by0; y <= by1; y += 0.8) {
    if (!field.inside(x, y)) continue;
    const gx = Math.floor(x / cell) - ax.gx0, gy = Math.floor(y / cell) - ax.gy0;
    if (gx < 0 || gy < 0 || gx >= ax.nx || gy >= ax.ny) continue;
    const k = gx * ax.ny + gy;
    let best = -1, bestW = -Infinity;
    for (let s = ax.start[k], e = ax.start[k + 1]; s < e; s++) {
      const i = ax.list[s], a = f[i * 3], b = f[i * 3 + 1], c = f[i * 3 + 2];
      const ax_ = uv[a * 2], ay = uv[a * 2 + 1], bx = uv[b * 2], by = uv[b * 2 + 1], cx = uv[c * 2], cy = uv[c * 2 + 1];
      const det = (by - cy) * (ax_ - cx) + (cx - bx) * (ay - cy); if (Math.abs(det) < 1e-12) continue;
      const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det, l2 = ((cy - ay) * (x - cx) + (ax_ - cx) * (y - cy)) / det, l3 = 1 - l1 - l2;
      if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
      const ww = l1 * w[a] + l2 * w[b] + l3 * w[c];
      if (ww > bestW) { bestW = ww; best = i; }
    }
    if (best >= 0) seedFaces.add(best);
  }
  if (!seedFaces.size) throw Error('Geen scanoppervlak binnen de omtrek.');
  // uitbreiden via gedeelde randen zolang een facet (deels) binnen de lijn ligt
  const inc = new Uint8Array(nf), queue = [], vs = topo.start, vf = topo.vf;
  const partlyInside = i => S(f[i * 3]) < 0 || S(f[i * 3 + 1]) < 0 || S(f[i * 3 + 2]) < 0;
  for (const i of seedFaces) if (partlyInside(i)) { inc[i] = 1; queue.push(i); }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    for (let k = 0; k < 3; k++) {
      const a = f[i * 3 + k], b = f[i * 3 + (k + 1) % 3];
      for (let s = vs[a], e = vs[a + 1]; s < e; s++) {
        const j = vf[s];
        if (inc[j] || (f[j * 3] !== b && f[j * 3 + 1] !== b && f[j * 3 + 2] !== b) || !partlyInside(j)) continue;
        inc[j] = 1; queue.push(j);
      }
    }
  }
  // snijden langs het nulniveau (gedeelde snijpunten per rand → geen naden)
  const ek = (a, b) => a < b ? a * 4294967296 + b : b * 4294967296 + a;
  const out = new Float32Array(queue.length * 18), cut = new Map();
  let o = 0;
  const P3 = v => [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]];
  const cutPoint = (a, b) => {
    const key = ek(a, b); let c = cut.get(key);
    if (!c) {
      // nulpunt op de rand exact zoeken (bisectie op de echte lijn; lineair interpoleren is bij knikken onnauwkeurig)
      const lo = Math.min(a, b), hi = Math.max(a, b), A = P3(lo), B = P3(hi);
      let t0 = 0, t1 = 1; const s0 = S(lo);
      for (let it = 0; it < 24; it++) {
        const t = (t0 + t1) / 2, st = field.side(uv[lo * 2] + t * (uv[hi * 2] - uv[lo * 2]), uv[lo * 2 + 1] + t * (uv[hi * 2 + 1] - uv[lo * 2 + 1]));
        if ((st < 0) === (s0 < 0)) t0 = t; else t1 = t;
      }
      const t = (t0 + t1) / 2; c = [A[0] + t * (B[0] - A[0]), A[1] + t * (B[1] - A[1]), A[2] + t * (B[2] - A[2])]; cut.set(key, c);
    }
    return c;
  };
  let kept = 0, clipped = 0, splitIndex = null;
  queue.sort((a, b) => a - b); // originele volgorde behouden (ontworpen facetten blijven achteraan)
  const faces = Int32Array.from(queue);
  for (const i of queue) {
    if (splitAt != null && splitIndex == null && i >= splitAt) splitIndex = o / 9;
    const v0 = f[i * 3], v1 = f[i * 3 + 1], v2 = f[i * 3 + 2], i0 = S(v0) < 0, i1 = S(v1) < 0, i2 = S(v2) < 0;
    if (i0 && i1 && i2) { for (let k = 0; k < 9; k++) out[o++] = soup[i * 9 + k]; kept++; continue; } // origineel, exact
    clipped++;
    const vv = [v0, v1, v2], ins = [i0, i1, i2], poly3 = [];
    for (let k = 0; k < 3; k++) {
      const a = vv[k], b = vv[(k + 1) % 3];
      if (ins[k]) poly3.push(P3(a));
      if (ins[k] !== ins[(k + 1) % 3]) poly3.push(cutPoint(a, b));
    }
    for (let k = 1; k < poly3.length - 1; k++) {
      const A = poly3[0], B = poly3[k], C = poly3[k + 1], u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], q = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      if (Math.hypot(u[1] * q[2] - u[2] * q[1], u[2] * q[0] - u[0] * q[2], u[0] * q[1] - u[1] * q[0]) > 1e-9) { // geen platte snippers
        out[o++] = A[0]; out[o++] = A[1]; out[o++] = A[2]; out[o++] = B[0]; out[o++] = B[1]; out[o++] = B[2]; out[o++] = C[0]; out[o++] = C[1]; out[o++] = C[2];
      }
    }
  }
  return { soup: out.slice(0, o), faces, polygon: poly, splitIndex: splitIndex ?? (splitAt != null ? o / 9 : null), report: { kept, clipped, removed: nf - kept - clipped, seeds: seedFaces.size } };
}

/**
 * Rand langs de scanrand (v68): het werkstuk loopt tot de rand van de scan (inset = 0: de hele scan, plaatrand =
 * scanrand, exact) of tot 'inset' mm binnen die rand, langs het oppervlak gemeten. Er wordt niet langs de as
 * geprojecteerd: ondersnijdingen (bolling van een kroon boven de rand) blijven dus heel.
 * Geeft hetzelfde als trimByOutline ({ soup, faces, splitIndex, report }) plus outline: de randlijn (3D-punten).
 */
export function trimByEdge(soup, { inset = 0, splitAt = null, step = 0.6 } = {}) {
  // alleen de echte scan: een aangevuld (ontworpen) deel hoort niet bij de scanrand
  if (splitAt != null && splitAt * 9 < soup.length) { soup = realPart(soup, splitAt); splitAt = null; }
  const topo = scanTopology(soup), mesh = topo.mesh, p = mesh.positions, f = mesh.indices, nf = f.length / 3;
  const { loops } = boundaryLoops(mesh);
  if (!loops.length) throw Error('Deze scan heeft geen open rand (gesloten model). Kies "Volgens de anatomie" of teken de omtrek.');
  const lens = loops.map(l => loopLength(mesh, l)), outer = loops[lens.indexOf(Math.max(...lens))];
  const P3 = v => [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]];
  if (!(inset > 0)) {
    const faces = new Int32Array(nf); for (let i = 0; i < nf; i++) faces[i] = i;
    return { soup, faces, splitIndex: splitAt != null ? Math.min(splitAt, nf) : null, outline: resampleLoop(outer.map(P3), step), report: { kept: nf, clipped: 0, removed: 0, edge: true, inset: 0 } };
  }
  const d = rimDistances(mesh, [outer], inset + 2), inside = v => !(d[v] < inset);
  const cut = new Map(), seg = new Map(), out = [], faces = [];
  const cutPoint = (a, b) => {
    const lo = Math.min(a, b), hi = Math.max(a, b), key = lo * 4294967296 + hi;
    let c = cut.get(key);
    if (!c) { const da = d[lo], db = d[hi], t = Math.max(0, Math.min(1, (inset - da) / ((db - da) || 1e-12))); c = [0, 1, 2].map(k => p[lo * 3 + k] + t * (p[hi * 3 + k] - p[lo * 3 + k])); c.key = key; cut.set(key, c); }
    return c;
  };
  let kept = 0, clipped = 0, splitIndex = null;
  for (let i = 0; i < nf; i++) {
    const vv = [f[i * 3], f[i * 3 + 1], f[i * 3 + 2]], ins = vv.map(inside);
    if (!ins[0] && !ins[1] && !ins[2]) continue;
    if (splitAt != null && splitIndex == null && i >= splitAt) splitIndex = out.length / 9;
    faces.push(i);
    if (ins[0] && ins[1] && ins[2]) { for (let k = 0; k < 9; k++) out.push(soup[i * 9 + k]); kept++; continue; } // origineel, exact
    clipped++;
    const poly = [], cuts = [];
    for (let k = 0; k < 3; k++) {
      const a = vv[k], b = vv[(k + 1) % 3];
      if (ins[k]) poly.push(P3(a));
      if (ins[k] !== ins[(k + 1) % 3]) { const c = cutPoint(a, b); poly.push(c); cuts.push(c); }
    }
    if (cuts.length === 2) { seg.set(cuts[0].key, [...(seg.get(cuts[0].key) || []), cuts[1].key]); seg.set(cuts[1].key, [...(seg.get(cuts[1].key) || []), cuts[0].key]); }
    for (let k = 1; k < poly.length - 1; k++) {
      const A = poly[0], B = poly[k], C = poly[k + 1], u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], q = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      if (Math.hypot(u[1] * q[2] - u[2] * q[1], u[2] * q[0] - u[0] * q[2], u[0] * q[1] - u[1] * q[0]) > 1e-9) out.push(...A, ...B, ...C);
    }
  }
  if (!out.length) throw Error(`Binnen ${inset} mm van de scanrand blijft geen oppervlak over. Kies een kleinere afstand.`);
  // randlijn: de langste keten van snijpunten
  let best = [];
  const used = new Set();
  for (const start of seg.keys()) {
    if (used.has(start)) continue;
    const chain = [start]; used.add(start);
    let cur = start;
    for (;;) { const nx = (seg.get(cur) || []).find(k => !used.has(k)); if (nx === undefined) break; used.add(nx); chain.push(nx); cur = nx; }
    if (chain.length > best.length) best = chain;
  }
  const outline = best.length >= 3 ? resampleLoop(best.map(k => cut.get(k)), step) : resampleLoop(outer.map(P3), step);
  return { soup: Float32Array.from(out), faces: Int32Array.from(faces), splitIndex: splitIndex ?? (splitAt != null ? out.length / 9 : null), outline, report: { kept, clipped, removed: nf - kept - clipped, edge: true, inset } };
}

const REAL = new WeakMap();
function realPart(soup, splitAt) { let r = REAL.get(soup); if (!r || r.splitAt !== splitAt) { r = { splitAt, sub: soup.slice(0, splitAt * 9) }; REAL.set(soup, r); } return r.sub; }

/** Gesloten 3D-lijn op gelijke afstanden (mm) herbemonsteren, hooguit maxPoints punten. */
export function resampleLoop(pts, step = 0.6, maxPoints = 600) {
  const n = pts.length; if (n < 3) return pts.map(q => q.slice());
  let total = 0; const seg = [];
  for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); seg.push(l); total += l; }
  const h = Math.max(step, total / maxPoints), m = Math.max(3, Math.round(total / h)), out = [];
  let i = 0, acc = 0;
  for (let k = 0; k < m; k++) {
    const target = k * total / m;
    while (i < n - 1 && acc + seg[i] < target) { acc += seg[i]; i++; }
    const t = seg[i] > 0 ? (target - acc) / seg[i] : 0, a = pts[i], b = pts[(i + 1) % n];
    out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]);
  }
  return out;
}

/** Omtrekpunten in het projectievlak (loodrecht op N) 'offset' mm naar buiten schuiven (hoogte blijft gelijk). */
export function pushOutline(points, N, offset) {
  const basis = axisBasis(N), P = points.map(basis.project), n = P.length;
  const sgn = area2(P) >= 0 ? 1 : -1; // tegen de klok in: rechts van de raaklijn = buiten
  return points.map((q, i) => {
    const a = P[(i - 1 + n) % n], b = P[(i + 1) % n], tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1;
    const ou = sgn * ty / l * offset, ov = -sgn * tx / l * offset;
    return [0, 1, 2].map(k => q[k] + basis.U[k] * ou + basis.V[k] * ov);
  });
}

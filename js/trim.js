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
import { weld } from './mesh.js';

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
}

/**
 * Snijdt de scan uit langs de omtrek. outline: 3D-punten (gesloten). N: insteekas (wijst naar de kijker/occlusaal).
 * opts.margin: mm naar buiten (bijv. 4 mm bij het bijsnijden van de scan, 0 voor het werkstuk).
 * Geeft { soup, faces: originele facetindices die (deels) behouden zijn, report }.
 */
export function trimByOutline(soup, outline, N, { margin = 0, step = 0.3, splitAt = null } = {}) {
  const basis = axisBasis(N), poly = outlinePolygon(outline, basis, { step, offset: margin });
  const field = new PolygonField(poly);
  const mesh = weld(soup, 1e-6), p = mesh.positions, f = mesh.indices, nf = f.length / 3, nv = p.length / 3;
  const uv = new Float32Array(nv * 2), w = new Float32Array(nv);
  for (let v = 0; v < nv; v++) { const q = [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]], [u, vv] = basis.project(q); uv[v * 2] = u; uv[v * 2 + 1] = vv; w[v] = basis.depth(q); }
  const sd = new Float32Array(nv).fill(NaN);
  const S = v => { if (Number.isNaN(sd[v])) { let d = field.signed(uv[v * 2], uv[v * 2 + 1]); if (d === 0) d = 1e-7; sd[v] = d; } return sd[v]; };
  // zaadfacetten: bovenste laag binnen de lijn (stralen langs -N op een raster van 0,8 mm)
  const cell = 1, buckets = new Map();
  const xs = poly.map(q => q[0]), ys = poly.map(q => q[1]), bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
  for (let i = 0; i < nf; i++) {
    const a = f[i * 3], b = f[i * 3 + 1], c = f[i * 3 + 2];
    const ux = [uv[a * 2], uv[b * 2], uv[c * 2]], uy = [uv[a * 2 + 1], uv[b * 2 + 1], uv[c * 2 + 1]];
    if (Math.max(...ux) < bx0 || Math.min(...ux) > bx1 || Math.max(...uy) < by0 || Math.min(...uy) > by1) continue;
    for (let gx = Math.floor(Math.min(...ux) / cell); gx <= Math.floor(Math.max(...ux) / cell); gx++) for (let gy = Math.floor(Math.min(...uy) / cell); gy <= Math.floor(Math.max(...uy) / cell); gy++) {
      const k = gx * 100003 + gy; let l = buckets.get(k); if (!l) buckets.set(k, l = []); l.push(i);
    }
  }
  const seedFaces = new Set();
  for (let x = bx0; x <= bx1; x += 0.8) for (let y = by0; y <= by1; y += 0.8) {
    if (!field.inside(x, y)) continue;
    let best = -1, bestW = -Infinity;
    for (const i of buckets.get(Math.floor(x / cell) * 100003 + Math.floor(y / cell)) || []) {
      const a = f[i * 3], b = f[i * 3 + 1], c = f[i * 3 + 2];
      const ax = uv[a * 2], ay = uv[a * 2 + 1], bx = uv[b * 2], by = uv[b * 2 + 1], cx = uv[c * 2], cy = uv[c * 2 + 1];
      const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy); if (Math.abs(det) < 1e-12) continue;
      const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det, l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det, l3 = 1 - l1 - l2;
      if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
      const ww = l1 * w[a] + l2 * w[b] + l3 * w[c];
      if (ww > bestW) { bestW = ww; best = i; }
    }
    if (best >= 0) seedFaces.add(best);
  }
  if (!seedFaces.size) throw Error('Geen scanoppervlak binnen de omtrek.');
  // uitbreiden via gedeelde randen zolang een facet (deels) binnen de lijn ligt
  const edgeFaces = new Map(), ek = (a, b) => a < b ? a * 4294967296 + b : b * 4294967296 + a;
  for (let i = 0; i < nf; i++) for (let k = 0; k < 3; k++) { const key = ek(f[i * 3 + k], f[i * 3 + (k + 1) % 3]); const l = edgeFaces.get(key); if (l) l.push(i); else edgeFaces.set(key, [i]); }
  const inc = new Uint8Array(nf), queue = [];
  const partlyInside = i => S(f[i * 3]) < 0 || S(f[i * 3 + 1]) < 0 || S(f[i * 3 + 2]) < 0;
  for (const i of seedFaces) if (partlyInside(i)) { inc[i] = 1; queue.push(i); }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    for (let k = 0; k < 3; k++) for (const j of edgeFaces.get(ek(f[i * 3 + k], f[i * 3 + (k + 1) % 3])) || []) if (!inc[j] && partlyInside(j)) { inc[j] = 1; queue.push(j); }
  }
  // snijden langs het nulniveau (gedeelde snijpunten per rand → geen naden)
  const out = [], cut = new Map();
  const P3 = v => [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]];
  const cutPoint = (a, b) => {
    const key = ek(a, b); let c = cut.get(key);
    if (!c) {
      // nulpunt op de rand exact zoeken (bisectie op de echte lijn; lineair interpoleren is bij knikken onnauwkeurig)
      const lo = Math.min(a, b), hi = Math.max(a, b), A = P3(lo), B = P3(hi);
      let t0 = 0, t1 = 1, s0 = S(lo);
      for (let it = 0; it < 24; it++) {
        const t = (t0 + t1) / 2, st = field.signed(uv[lo * 2] + t * (uv[hi * 2] - uv[lo * 2]), uv[lo * 2 + 1] + t * (uv[hi * 2 + 1] - uv[lo * 2 + 1]));
        if ((st < 0) === (s0 < 0)) t0 = t; else t1 = t;
      }
      const t = (t0 + t1) / 2; c = [A[0] + t * (B[0] - A[0]), A[1] + t * (B[1] - A[1]), A[2] + t * (B[2] - A[2])]; cut.set(key, c);
    }
    return c;
  };
  let kept = 0, clipped = 0, splitIndex = null;
  const faces = [];
  queue.sort((a, b) => a - b); // originele volgorde behouden (ontworpen facetten blijven achteraan)
  for (const i of queue) {
    if (splitAt != null && splitIndex == null && i >= splitAt) splitIndex = out.length / 9;
    const vs = [f[i * 3], f[i * 3 + 1], f[i * 3 + 2]], ins = vs.map(v => S(v) < 0);
    faces.push(i);
    if (ins[0] && ins[1] && ins[2]) { for (let k = 0; k < 9; k++) out.push(soup[i * 9 + k]); kept++; continue; } // origineel, exact
    clipped++;
    const poly3 = [];
    for (let k = 0; k < 3; k++) {
      const a = vs[k], b = vs[(k + 1) % 3];
      if (ins[k]) poly3.push(P3(a));
      if (ins[k] !== ins[(k + 1) % 3]) poly3.push(cutPoint(a, b));
    }
    for (let k = 1; k < poly3.length - 1; k++) {
      const A = poly3[0], B = poly3[k], C = poly3[k + 1], u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], w = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      if (Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) > 1e-9) out.push(...A, ...B, ...C); // geen platte snippers
    }
  }
  return { soup: Float32Array.from(out), faces, polygon: poly, splitIndex: splitIndex ?? (splitAt != null ? out.length / 9 : null), report: { kept, clipped, removed: nf - kept - clipped, seeds: seedFaces.size } };
}

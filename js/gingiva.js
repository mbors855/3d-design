// v74: anatomisch tandvlees voor een prothese, gemodelleerd zoals in was en als één gesloten lichaam berekend.
//
// Het tandvlees is het iso-oppervlak van een veld (negatief = tandvlees):
//  - kraag: rond elke tandhals tot op de festoenlijn. Boven de lijn ligt het oppervlak ín de kroon (onzichtbaar),
//    eronder komt het vrij van de tand en wordt het binnen ± 2 mm 1,5 mm dik (een afgeronde, 'gerolde' rand). De
//    festoenlijn volgt per element de hals (laag in het midden, het zenit iets distaal) en loopt tussen de elementen op
//    tot een spitse papil. Onder de hals loopt de kraag langs de halsdoorsnede door naar de basis (zoals de wortel),
//    zodat het tandvlees vol blijft en niet de taps toelopende wortelstomp volgt.
//  - wortelreliëf (juga): labiaal/buccaal een langgerekte welving boven elke wortel (hoektand het sterkst), met
//    vanzelf een holte ertussen.
//  - basis: het buitenoppervlak van de basis (afstand 'level' tot de scan), labiaal iets voller. Kraag en basis gaan
//    met een afronding (smooth minimum) in elkaar over: geen trede, geen scherpe hoek.
// Het lichaam stopt 1,6 mm binnen de basisrand, halverwege de basiswand en een paar mm voorbij de elementen; daar ligt
// het binnen de basis, dus na het samenvoegen is van die snijvlakken niets te zien.
import { TriBVH } from './bvh.js';
import { weld, vertexNormals } from './mesh.js';
import { isoField, taubin } from './isofield.js';

const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
const smax = (a, b, k) => -smin(-a, -b, k);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// papilhoogte (mm boven het zenit) en wortelreliëf (mm) per elementtype
export const GINGIVA_TYPES = {
  1: { pap: 3.0, juga: 0.75, zen: 0.08 }, 2: { pap: 2.7, juga: 0.55, zen: 0.0 }, 3: { pap: 2.9, juga: 1.15, zen: 0.08 },
  4: { pap: 2.3, juga: 0.55, zen: 0.04 }, 5: { pap: 2.1, juga: 0.45, zen: 0.03 }, 6: { pap: 1.8, juga: 0.3, zen: 0.0 },
  7: { pap: 1.6, juga: 0.2, zen: 0.0 }, 8: { pap: 1.4, juga: 0.1, zen: 0.0 },
};

/** Getekende afstand tot een gesloten mesh (negatief binnen): BVH + barycentrisch geïnterpoleerde puntnormalen. */
export function signedDistanceTo(soup) {
  const m = weld(soup, 1e-5), Nv = vertexNormals(m), F = m.indices, bvh = new TriBVH(soup), q = bvh.point;
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < soup.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], soup[i + k]); hi[k] = Math.max(hi[k], soup[i + k]); }
  const fn = (x, y, z, bound = Infinity) => {
    const d = bvh.closest(x, y, z, bound);
    if (d === Infinity) return Infinity;
    return sideOf(soup, F, Nv, bvh.face, q, x, y, z) >= 0 ? d : -d;
  };
  fn.box = [lo, hi];
  return fn;
}
// kant van punt (x,y,z) t.o.v. facet 'face' met voetpunt q: geïnterpoleerde puntnormaal
function sideOf(soup, F, N, face, q, x, y, z) {
  const o = face * 9, ax = soup[o], ay = soup[o + 1], az = soup[o + 2];
  const v0x = soup[o + 3] - ax, v0y = soup[o + 4] - ay, v0z = soup[o + 5] - az, v1x = soup[o + 6] - ax, v1y = soup[o + 7] - ay, v1z = soup[o + 8] - az;
  const v2x = q[0] - ax, v2y = q[1] - ay, v2z = q[2] - az;
  const d00 = v0x * v0x + v0y * v0y + v0z * v0z, d01 = v0x * v1x + v0y * v1y + v0z * v1z, d11 = v1x * v1x + v1y * v1y + v1z * v1z;
  const d20 = v2x * v0x + v2y * v0y + v2z * v0z, d21 = v2x * v1x + v2y * v1y + v2z * v1z, den = d00 * d11 - d01 * d01;
  let nx, ny, nz;
  if (den > 1e-24) {
    let vb = (d11 * d20 - d01 * d21) / den, wb = (d00 * d21 - d01 * d20) / den;
    vb = Math.min(1, Math.max(0, vb)); wb = Math.min(1 - vb, Math.max(0, wb)); const ub = 1 - vb - wb;
    const ia = F[face * 3] * 3, ib = F[face * 3 + 1] * 3, ic = F[face * 3 + 2] * 3;
    nx = ub * N[ia] + vb * N[ib] + wb * N[ic]; ny = ub * N[ia + 1] + vb * N[ib + 1] + wb * N[ic + 1]; nz = ub * N[ia + 2] + vb * N[ib + 2] + wb * N[ic + 2];
  } else { nx = v0y * v1z - v0z * v1y; ny = v0z * v1x - v0x * v1z; nz = v0x * v1y - v0y * v1x; }
  return (x - q[0]) * nx + (y - q[1]) * ny + (z - q[2]) * nz;
}

/** Getekende afstand tot een open oppervlak (scan), positief aan de kant van de normalen. normals: puntnormalen van
 *  de gelaste mesh (zelfde volgorde als de soup-hoeken via weld). */
export function signedDistanceToSheet(soup, normalsOf = null) {
  const m = weld(soup, 1e-5), Nv = normalsOf ? normalsOf(m) : vertexNormals(m), F = m.indices, bvh = new TriBVH(soup), q = bvh.point;
  return (x, y, z, bound = Infinity) => {
    let d = bvh.closest(x, y, z, bound);
    if (d === Infinity) return Infinity;
    return sideOf(soup, F, Nv, bvh.face, q, x, y, z) >= 0 ? d : -d;
  };
}

// Doorsnede van een gesloten soup met het vlak (p − o)·a = hc → lijnstukken in (u, v) = ((p − o)·me, (p − o)·bu).
function sectionSegments(soup, o, a, me, bu, hc) {
  const segs = [];
  for (let i = 0; i < soup.length; i += 9) {
    const P = [0, 1, 2].map(k => [soup[i + k * 3] - o[0], soup[i + k * 3 + 1] - o[1], soup[i + k * 3 + 2] - o[2]]);
    const s = P.map(p => dot(p, a) - hc);
    const pts = [];
    for (const [x, y] of [[0, 1], [1, 2], [2, 0]]) {
      if ((s[x] < 0) === (s[y] < 0)) continue;
      const t = s[x] / (s[x] - s[y]), p = [P[x][0] + (P[y][0] - P[x][0]) * t, P[x][1] + (P[y][1] - P[x][1]) * t, P[x][2] + (P[y][2] - P[x][2]) * t];
      pts.push([dot(p, me), dot(p, bu)]);
    }
    if (pts.length === 2) segs.push(pts[0][0], pts[0][1], pts[1][0], pts[1][1]);
  }
  return Float64Array.from(segs);
}

// Getekende 2D-afstand (negatief binnen) tot een stelsel gesloten lijnstukken, op een raster (cel g, half-breedte R).
function sectionGrid(segs, R, g) {
  const n = Math.ceil(2 * R / g) + 1, grid = new Float32Array(n * n), ns = segs.length / 4;
  for (let j = 0; j < n; j++) {
    const v = -R + j * g;
    // binnen/buiten per rij: snijpunten van de horizontale lijn met de lijnstukken
    const xs = [];
    for (let s = 0; s < ns; s++) {
      const y0 = segs[s * 4 + 1], y1 = segs[s * 4 + 3];
      if ((y0 <= v) === (y1 <= v)) continue;
      const x0 = segs[s * 4], x1 = segs[s * 4 + 2]; xs.push(x0 + (x1 - x0) * (v - y0) / (y1 - y0));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i < n; i++) {
      const u = -R + i * g;
      let best = Infinity;
      for (let s = 0; s < ns; s++) {
        const ax = segs[s * 4], ay = segs[s * 4 + 1], bx = segs[s * 4 + 2], by = segs[s * 4 + 3];
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        let t = l2 > 0 ? ((u - ax) * dx + (v - ay) * dy) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = ax + dx * t - u, ey = ay + dy * t - v, d = ex * ex + ey * ey; if (d < best) best = d;
      }
      let inside = false; for (const x of xs) { if (x > u) break; inside = !inside; }
      grid[j * n + i] = inside ? -Math.sqrt(best) : Math.sqrt(best);
    }
  }
  return { grid, n, R, g };
}
function sampleGrid(G, u, v) {
  const { grid, n, R, g } = G, fx = (u + R) / g, fy = (v + R) / g;
  if (fx < 0 || fy < 0 || fx > n - 1 || fy > n - 1) return Infinity;
  const i = Math.min(n - 2, Math.floor(fx)), j = Math.min(n - 2, Math.floor(fy)), tx = fx - i, ty = fy - j, o = j * n + i;
  return (grid[o] * (1 - tx) + grid[o + 1] * tx) * (1 - ty) + (grid[o + n] * (1 - tx) + grid[o + n + 1] * tx) * ty;
}

/** Voetafdruk van de basis langs N (frame-vlak): getekende afstand tot de rand (positief binnen, gladgestreken) en de
 *  hoogte van de basisrand langs N bij het dichtstbijzijnde randpunt. Geeft { fp(x, y), rimN(x, y) }. */
export function footprintFields(soup, frame, g = 0.25) {
  const { O, X, Y, N } = frame;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const n = soup.length / 3, XY = new Float32Array(n * 2), Hn = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dx = soup[i * 3] - O[0], dy = soup[i * 3 + 1] - O[1], dz = soup[i * 3 + 2] - O[2], x = dx * X[0] + dy * X[1] + dz * X[2], y = dx * Y[0] + dy * Y[1] + dz * Y[2];
    XY[i * 2] = x; XY[i * 2 + 1] = y; Hn[i] = dx * N[0] + dy * N[1] + dz * N[2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  x0 -= 12; y0 -= 12; x1 += 12; y1 += 12;
  const W = Math.ceil((x1 - x0) / g) + 1, H = Math.ceil((y1 - y0) / g) + 1, m = new Uint8Array(W * H), low = new Float32Array(W * H).fill(Infinity);
  for (let t = 0; t < n; t += 3) {
    const a = [XY[t * 2], XY[t * 2 + 1]], b = [XY[t * 2 + 2], XY[t * 2 + 3]], c = [XY[t * 2 + 4], XY[t * 2 + 5]];
    for (let k = 0; k < 3; k++) { const p = [a, b, c][k], o = Math.floor((p[1] - y0) / g) * W + Math.floor((p[0] - x0) / g); m[o] = 1; if (Hn[t + k] < low[o]) low[o] = Hn[t + k]; }
    const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]); if (Math.abs(d) < 1e-12) continue;
    const ia = Math.floor((Math.min(a[0], b[0], c[0]) - x0) / g), ib = Math.floor((Math.max(a[0], b[0], c[0]) - x0) / g), ja = Math.floor((Math.min(a[1], b[1], c[1]) - y0) / g), jb = Math.floor((Math.max(a[1], b[1], c[1]) - y0) / g);
    for (let j = ja; j <= jb; j++) for (let i = ia; i <= ib; i++) {
      const u = x0 + (i + 0.5) * g, v = y0 + (j + 0.5) * g, l1 = ((b[1] - c[1]) * (u - c[0]) + (c[0] - b[0]) * (v - c[1])) / d, l2 = ((c[1] - a[1]) * (u - c[0]) + (a[0] - c[0]) * (v - c[1])) / d;
      if (l1 >= -1e-9 && l2 >= -1e-9 && 1 - l1 - l2 >= -1e-9) { const o = j * W + i; m[o] = 1; const hz = l1 * Hn[t] + l2 * Hn[t + 1] + (1 - l1 - l2) * Hn[t + 2]; if (hz < low[o]) low[o] = hz; }
    }
  }
  // buiten = bereikbaar vanaf de rand van het raster zonder bedekte cellen; de rest is binnen (gaatjes dicht)
  const outside = new Uint8Array(W * H), st = [];
  for (let i = 0; i < W; i++) st.push(i, (H - 1) * W + i); for (let j = 0; j < H; j++) st.push(j * W, j * W + W - 1);
  while (st.length) { const c = st.pop(); if (outside[c] || m[c]) continue; outside[c] = 1; const i = c % W, j = (c - i) / W; if (i > 0) st.push(c - 1); if (i < W - 1) st.push(c + 1); if (j > 0) st.push(c - W); if (j < H - 1) st.push(c + W); }
  const inside = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) inside[i] = outside[i] ? 0 : 1;
  const Din = edt2(outside, W, H), Dout = edt2(inside, W, H), S = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) S[i] = inside[i] ? Math.sqrt(Din[i]) * g - 0.5 * g : -(Math.sqrt(Dout[i]) * g - 0.5 * g);
  // randhoogte: laagste punt van de basis in de randcellen, naar alle cellen doorgegeven (dichtstbijzijnde randcel)
  const R = new Float32Array(W * H).fill(NaN), q = [];
  for (let j = 1; j < H - 1; j++) for (let i = 1; i < W - 1; i++) {
    const o = j * W + i; if (!inside[o]) continue;
    if (!(outside[o - 1] || outside[o + 1] || outside[o - W] || outside[o + W])) continue;
    let v = Infinity; for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) { const oo = (j + b) * W + i + a; if (oo >= 0 && oo < W * H && low[oo] < v) v = low[oo]; }
    if (v < Infinity) { R[o] = v; q.push(o); }
  }
  for (let head = 0; head < q.length; head++) { const c = q[head], i = c % W, j = (c - i) / W; for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue; const o = jj * W + ii; if (R[o] === R[o]) continue; R[o] = R[c]; q.push(o); } }
  if (!q.length) R.fill(0);
  const Sb = blur2(S, W, H, 0.6 / g), Rb = blur2(R, W, H, 1.5 / g);
  const at = (A, x, y, outside) => {
    const fx = (x - x0) / g - 0.5, fy = (y - y0) / g - 0.5;
    if (fx < 0 || fy < 0 || fx > W - 1 || fy > H - 1) return outside;
    const i = Math.min(W - 2, Math.floor(fx)), j = Math.min(H - 2, Math.floor(fy)), tx = fx - i, ty = fy - j, o = j * W + i;
    return (A[o] * (1 - tx) + A[o + 1] * tx) * (1 - ty) + (A[o + W] * (1 - tx) + A[o + W + 1] * tx) * ty;
  };
  return { fp: (x, y) => at(Sb, x, y, -20), rimN: (x, y) => at(Rb, x, y, 0) };
}
/** Alleen de afstand tot de rand (positief binnen, 0 buiten). */
export function footprintDistance(soup, frame, g = 0.25) { const f = footprintFields(soup, frame, g).fp; return (x, y) => Math.max(0, f(x, y)); }
// gescheiden Gauss-filter (sigma in cellen)
function blur2(A, W, H, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 2.5)), k = []; let ks = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); ks += v; }
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const T = new Float32Array(W * H), O = new Float32Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { let s = 0; for (let a = -r; a <= r; a++) { const ii = Math.min(W - 1, Math.max(0, i + a)); s += A[j * W + ii] * k[a + r]; } T[j * W + i] = s; }
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { let s = 0; for (let a = -r; a <= r; a++) { const jj = Math.min(H - 1, Math.max(0, j + a)); s += T[jj * W + i] * k[a + r]; } O[j * W + i] = s; }
  return O;
}
// exacte gekwadrateerde afstandstransformatie (Felzenszwalb–Huttenlocher) tot de cellen met src = 1, in cellen²
function edt2(src, W, H) {
  const INF = 1e20, D = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) D[i] = src[i] ? 0 : INF;
  const f = new Float64Array(Math.max(W, H)), d = new Float64Array(Math.max(W, H)), v = new Int32Array(Math.max(W, H)), z = new Float64Array(Math.max(W, H) + 1);
  const dt = (n) => {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0; for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
  };
  for (let x = 0; x < W; x++) { for (let y = 0; y < H; y++) f[y] = D[y * W + x]; dt(H); for (let y = 0; y < H; y++) D[y * W + x] = d[y]; }
  for (let y = 0; y < H; y++) { for (let x = 0; x < W; x++) f[x] = D[y * W + x]; dt(W); for (let x = 0; x < W; x++) D[y * W + x] = d[x]; }
  return D;
}

/**
 * Tandvlees als gesloten lichaam (generator: pauzeert met yield).
 * frame: { O, X, Y, N } · teeth: [{ fdi, soup (wereld), o (halscentrum), ax (kroonas), bu (buccaal) }]
 * baseSd(x, y, z, bound): getekende afstand tot het plaatoppervlak (positief aan de basiskant) · level: ruimte + dikte
 * footprint: { fp(x, y), rimN(x, y) } uit footprintFields (basisrand in het boogvlak)
 * opts: over (mm tandvlees over de hals bij het zenit), papilla (factor), juga (factor), fullness (mm labiaal voller),
 *       h (celgrootte), blend (afronding naar de basis, mm)
 * Geeft { positions, indices, stats }.
 */
export function* gingivaSteps({ frame, teeth, baseSd, level, footprint = null, opts = {} }, report = {}) {
  const { over = 1, papilla = 1, juga = 1, fullness = 0.45, h = 0.25, blend = 1.8, thick = 1.5, due = () => false,
    skirt = { md: 0.55, lab: 0.22, pal: 1.1, mdMax: 3, labMax: 2.2, palMax: 4.2 } } = opts;
  const t0 = performance.now();
  if (!teeth.length) throw Error('Geen elementen.');
  const { O, X, Y, N } = frame;
  // per element: assen, halsdoorsnede (raster), festoen
  const T = teeth.map(t => {
    const ax = unit(t.ax); let bu = unit(sub(t.bu, ax.map(v => v * dot(t.bu, ax))));
    const me0 = unit(cross(ax, bu));
    return { ...t, ax, bu, me: me0, type: t.fdi % 10, x: dot(sub(t.o, O), X), y: dot(sub(t.o, O), Y) };
  });
  // mesiaal = naar de buur met het lagere typenummer aan dezelfde kant (of naar de andere centraal)
  const side = f => Math.floor(f / 10) === 1 || Math.floor(f / 10) === 4 ? 'R' : 'L';
  for (const t of T) {
    const want = t.type === 1 ? T.find(q => q.type === 1 && side(q.fdi) !== side(t.fdi)) : T.find(q => q.type === t.type - 1 && side(q.fdi) === side(t.fdi));
    let dir = want ? sub(want.o, t.o) : [-(t.x) * X[0], -(t.x) * X[1], -(t.x) * X[2]];
    if (dot(dir, t.me) < 0) t.me = t.me.map(v => -v);
    t.mesialN = !!want;
    t.distalN = !!T.find(q => q.type === t.type + 1 && side(q.fdi) === side(t.fdi));
  }
  const hc = 0.15;
  for (const t of T) {
    const segs = sectionSegments(t.soup, t.o, t.ax, t.me, t.bu, hc);
    let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
    for (let i = 0; i < segs.length; i += 2) { umin = Math.min(umin, segs[i]); umax = Math.max(umax, segs[i]); vmin = Math.min(vmin, segs[i + 1]); vmax = Math.max(vmax, segs[i + 1]); }
    if (!(segs.length >= 24) || !(umax - umin > 1) || !(vmax - vmin > 1)) throw Error(`Halsdoorsnede van element ${t.fdi} niet gevonden.`);
    t.umin = umin; t.umax = umax; t.vmin = vmin; t.vmax = vmax; t.uc = (umin + umax) / 2; t.vc = (vmin + vmax) / 2;
    const R = Math.max(-umin, umax, -vmin, vmax) + 13;
    t.sec = sectionGrid(segs, R, 0.2);
    const ty = GINGIVA_TYPES[t.type] ?? GINGIVA_TYPES[6];
    t.u0 = t.uc - ty.zen * (umax - umin); // zenit iets distaal (−u)
    t.papM = ty.pap * papilla * (t.mesialN ? 1 : 0.45); t.papD = ty.pap * papilla * (t.distalN ? 1 : 0.35);
    t.juga = ty.juga * juga; t.w = (umax - umin) / 2;
    t.sd = signedDistanceTo(t.soup);
    t.nNeck = dot(sub(t.o, O), N);
    if (footprint) { // labiaalste halspunt: hoe ver staat het buiten de basisrand (mm)?
      const q = [0, 1, 2].map(k => t.o[k] + t.bu[k] * t.vmax + t.me[k] * t.uc), d = sub(q, O);
      t.over = Math.max(0, -footprint.fp(dot(d, X), dot(d, Y)));
    } else t.over = 0;
  }
  report.sections = performance.now() - t0;
  if (opts.debug) opts.debug(T);
  const lam = 1.25, kb = blend, eps = 0.15;
  const field = (x, y, z) => {
    // tandvlees rond de hals (kraag) en festoendiepte, gewogen over de dichtstbijzijnde elementen
    let eMin = Infinity, eS = Infinity, best = null;
    const near = [];
    let jugaSum = 0, reg = Infinity, labial = 0;
    for (let k = 0; k < T.length; k++) {
      const t = T[k], dx = x - t.o[0], dy = y - t.o[1], dz = z - t.o[2];
      const u = dx * t.me[0] + dy * t.me[1] + dz * t.me[2], v = dx * t.bu[0] + dy * t.bu[1] + dz * t.bu[2], hh = dx * t.ax[0] + dy * t.ax[1] + dz * t.ax[2];
      // gebied: doos rond het element (mesiodistaal + 4,5 mm, linguaal 5 mm, apicaal 18 mm), labiaal open
      const r = Math.max(Math.abs(u - t.uc) - (t.w + 6), (t.vmin - 8) - v, -hh - 18, hh - 14);
      if (r < reg) { reg = r; labial = v - t.vmax; }
      const s2 = sampleGrid(t.sec, u, v);
      if (s2 === Infinity) continue;
      // onder de hals: de halsdoorsnede loopt door naar de basis en wordt met de diepte breder (een 'rok'): palatinaal
      // een glooiing, mesiodistaal sluiten de buren aan (geen tussenruimtes), labiaal bijna recht (de flens)
      let e;
      if (hh <= hc) {
        const depth = hc - hh, du = u - t.uc, dv = v - t.vc, cvv = dv / (Math.hypot(du, dv) || 1);
        // helling (mm per mm diepte) en hoogstens zo breed (mm): palatinaal een glooiing van ± 4 mm die daarna steil
        // naar het verhemelte gaat (anders vulde de glooiing het hele verhemelte), mesiodistaal genoeg om de buren te raken
        const c2 = cvv * cvv, tn = cvv > 0 ? skirt.md + (skirt.lab - skirt.md) * c2 : skirt.md + (skirt.pal - skirt.md) * c2;
        const cap = cvv > 0 ? skirt.mdMax + (skirt.labMax - skirt.mdMax) * c2 : skirt.mdMax + (skirt.palMax - skirt.mdMax) * c2;
        e = s2 - cap * (1 - Math.exp(-depth * tn / cap));
      } else e = s2 > 0 ? Math.hypot(s2, hh - hc) : hh - hc;
      // kroon: exacte getekende afstand (binnen 6 mm; de doos-test is exact, dus geen sprong in het veld)
      const bl = t.sd.box[0], bh = t.sd.box[1], bx = Math.max(bl[0] - x, 0, x - bh[0]), by = Math.max(bl[1] - y, 0, y - bh[1]), bz = Math.max(bl[2] - z, 0, z - bh[2]);
      if (bx * bx + by * by + bz * bz < 36) { const sc = t.sd(x, y, z, 6); if (sc < e) e = sc; }
      if (e > 6) e = 6;
      // festoen: hoogte boven het halsvlak waar het tandvlees eindigt
      const rel = u >= t.u0 ? Math.min(1, (u - t.u0) / Math.max(0.5, t.umax - t.u0)) : Math.min(1, (t.u0 - u) / Math.max(0.5, t.u0 - t.umin));
      const f = over + (u >= t.u0 ? t.papM : t.papD) * Math.pow(rel, 2.4);
      near.push(e, f - hh, t.nNeck, t.over);
      if (e < eMin) { eMin = e; best = t; }
      eS = eS === Infinity ? e : smin(eS, e, 1.1); // tussen de elementen vloeiend (geen naad op de glooiing)
      // wortelreliëf: labiaal boven de wortel, vanaf ± 1 mm onder de rand, uitlopend naar de omslag
      if (t.juga > 0 && v > t.vc) {
        const depth = -hh;
        if (depth > 0.3 && depth < 18) {
          const g = sstep(0.6, 3.2, depth) * (1 - 0.65 * sstep(4.5, 11, depth) - 0.35 * sstep(11, 17.5, depth)), du = (u - (t.uc - 0.12 * t.w)) / (0.55 * t.w);
          jugaSum += t.juga * Math.exp(-du * du) * g * sstep(t.vc, t.vc + 0.45 * (t.vmax - t.vc), v);
        }
      }
    }
    if (!best) return 1;
    let wsum = 0, dsum = 0, nsum = 0, osum = 0;
    for (let i = 0; i < near.length; i += 4) { const e = near[i]; if (e > eMin + 2.5) continue; const w = Math.exp(-(e - eMin) / 0.6); wsum += w; dsum += w * near[i + 1]; nsum += w * near[i + 2]; osum += w * near[i + 3]; }
    const D = dsum / wsum, nNeck = nsum / wsum, overhang = osum / wsum;
    const Tk = D >= 0 ? thick * (1 - Math.exp(-D / lam)) : 0.45 * D;
    const P2x = x - O[0], P2y = y - O[1], P2z = z - O[2], fx = P2x * X[0] + P2y * X[1] + P2z * X[2], fy = P2x * Y[0] + P2y * Y[1] + P2z * Y[2];
    // basisrand: vlak bij de rand blijft het tandvlees 1,6 mm binnen de rand (daar is de basis). Staan de elementen
    // over de rand, dan loopt de flens vanaf de hals bol en vloeiend terug naar de rand (geen richel eronder).
    let fp = 50, allowed = 50;
    if (footprint) {
      fp = footprint.fp(fx, fy);
      const nn = P2x * N[0] + P2y * N[1] + P2z * N[2], rimTop = footprint.rimN(fx, fy) + level + 0.5;
      const tt = Math.max(0, Math.min(1, (nn - rimTop) / Math.max(1, nNeck - rimTop))), need = overhang + thick + 1.2;
      const ext = -1.6 + (need + 1.6) * (1 - (1 - tt) * (1 - tt));
      allowed = fp + ext;
    }
    const bf = sstep(0.4, 3.5, allowed) * sstep(-0.5, 3, fp + 1.5);
    let collar = eS - Tk - jugaSum * bf;
    collar = Math.max(collar, -(D + 1.0)); // boven de festoenlijn: alleen ín de kroon
    // basis: buitenkant op 'level' van de scan, labiaal iets voller; net onder het echte oppervlak (eps)
    const sd = baseSd(x, y, z, level + 8);
    if (sd === Infinity) return 1;
    const base = sd - level - fullness * sstep(-0.5, 2.5, labial) * bf + eps;
    let F = smin(collar, base, kb);
    F = Math.max(F, 0.45 * level - sd);  // onderkant: halverwege de basiswand
    if (footprint) F = smax(F, -allowed, 0.8);
    F = Math.max(F, reg);                 // rond de elementen
    if (opts.trace) opts.trace({ eS, eMin, D, Tk, jugaSum, collar, base, sd, reg, allowed, F });
    return F;
  };
  report.field = field;
  // doos: alle elementen + ruimte
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const t of T) { const [a, b] = t.sd.box; for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], a[k]); hi[k] = Math.max(hi[k], b[k]); } }
  for (let k = 0; k < 3; k++) { lo[k] -= 20; hi[k] += 20; }
  const starts = [];
  for (const t of T) for (const s of [1, -1]) starts.push({ p: [0, 1, 2].map(k => t.o[k] + t.ax[k] * (over * 0.3) + t.bu[k] * t.vc), d: t.bu.map(v => v * s), len: 14 });
  const r = yield* isoField({ field, h, lo, hi, starts, due, label: 'tandvlees' });
  taubin(r.positions, r.indices, { iterations: 2 }); // v75: rastertrapje weg (verplaatsing < 0,05 mm)
  report.stats = r.stats; report.ms = performance.now() - t0; report.teeth = T.map(t => ({ fdi: t.fdi, over: t.over }));
  return r;
}

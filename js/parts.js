// v72: losse onderdelen in een scan, zoals een steg op implantaten of een attachment. In een STL uit exocad of 3Shape
// zit zo'n onderdeel als een apart, gesloten deel naast het (open) kaakoppervlak. Vroeger verdween het bij
// 'losse delen weg' of, erger, hield 'Scan voorbereiden' het onderdeel over en gooide de kaak weg.
// Nu wordt het bij het openen apart gezet. Per onderdeel kies je:
//   'scan'  = bij de scan: lepel, beetplaat en basis gaan eroverheen: plaat op het tandvlees ∪ kap over de steg −
//             uitsparing (de steg met alles eronder langs de insteekas), zoals een technicus onder een steg uitblokt.
//   'apart' = het werkstuk ligt alleen op de kaak (zonder steg); het onderdeel blijft zichtbaar en los te downloaden.
import { weld, compact, toSoup } from './mesh.js';
import { axisBasis } from './trim.js';
import { TriBVH } from './bvh.js';

const EDGE_KEY = (a, b) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);

/** Splitst een scan in het kaakoppervlak (grootste deel, met de losse stukjes scan) en gesloten onderdelen.
 *  Geeft { scan, parts: [{ name, soup, faces, volume, size }] }; zonder onderdelen is scan === soup. */
export function splitParts(soup, { minFaces = 400, minVolume = 4 } = {}) {
  const m = weld(soup, 1e-5), f = m.indices, P = m.positions, n = P.length / 3, nt = f.length / 3;
  const parent = new Int32Array(n).map((_, i) => i), find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < f.length; t += 3) { const a = find(f[t]), b = find(f[t + 1]); parent[b] = a; parent[find(f[t + 2])] = a; }
  const comps = new Map();
  for (let t = 0; t < nt; t++) {
    const r = find(f[t * 3]); let c = comps.get(r); if (!c) comps.set(r, c = { faces: [], area: 0, volume: 0, edges: new Map() });
    c.faces.push(t);
    const a = f[t * 3] * 3, b = f[t * 3 + 1] * 3, d = f[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[d] - P[a], vy = P[d + 1] - P[a + 1], vz = P[d + 2] - P[a + 2];
    c.area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    c.volume += (P[a] * (P[b + 1] * P[d + 2] - P[b + 2] * P[d + 1]) - P[a + 1] * (P[b] * P[d + 2] - P[b + 2] * P[d]) + P[a + 2] * (P[b] * P[d + 1] - P[b + 1] * P[d])) / 6;
  }
  if (comps.size < 2) return { scan: soup, parts: [] };
  const list = [...comps.values()].sort((x, y) => y.area - x.area), main = list[0];
  const parts = [], keep = [];
  for (const c of list) {
    let closed = false;
    if (c !== main && c.faces.length >= minFaces) {
      const e = c.edges; for (const t of c.faces) for (let k = 0; k < 3; k++) { const key = EDGE_KEY(f[t * 3 + k], f[t * 3 + (k + 1) % 3]); e.set(key, (e.get(key) || 0) + 1); }
      let open = 0; for (const v of e.values()) if (v === 1) open++;
      closed = open <= e.size * 0.002 && Math.abs(c.volume) >= minVolume; // een paar open randjes van de export: nog steeds een onderdeel
    }
    c.edges = null;
    if (!closed) { for (const t of c.faces) keep.push(t); continue; }
    const idx = new Uint32Array(c.faces.length * 3);
    c.faces.forEach((t, i) => { const flip = c.volume < 0; idx[i * 3] = f[t * 3]; idx[i * 3 + 1] = f[t * 3 + (flip ? 2 : 1)]; idx[i * 3 + 2] = f[t * 3 + (flip ? 1 : 2)]; });
    const ps = toSoup(compact({ positions: P, indices: idx }));
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < ps.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], ps[i + k]); mx[k] = Math.max(mx[k], ps[i + k]); }
    const size = mx.map((v, k) => v - mn[k]).sort((a, b) => b - a);
    // een langwerpig deel (lengte ≥ 2,5 × de op één na grootste maat, of gewoon lang) noemen we een steg
    parts.push({ kind: size[0] >= 18 && size[0] >= 1.6 * size[1] ? 'steg' : 'onderdeel', soup: ps, faces: c.faces.length, volume: Math.abs(c.volume), size });
  }
  if (!parts.length) return { scan: soup, parts: [] };
  keep.sort((a, b) => a - b); // oorspronkelijke facetvolgorde
  const out = new Float32Array(keep.length * 9);
  keep.forEach((t, i) => { for (let k = 0; k < 9; k++) out[i * 9 + k] = soup[t * 9 + k]; });
  return { scan: out, parts };
}

// scheidbaar max/min-filter (vierkant venster, straal R cellen) over een raster met -Infinity = leeg
function filter2(a, W, H, R, op) {
  const tmp = new Float32Array(a.length), out = new Float32Array(a.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let v = a[y * W + x]; for (let k = Math.max(0, x - R); k <= Math.min(W - 1, x + R); k++) v = op(v, a[y * W + k]); if (x - R < 0 || x + R > W - 1) v = op === Math.min ? -Infinity : v; tmp[y * W + x] = v; }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let v = tmp[y * W + x]; for (let k = Math.max(0, y - R); k <= Math.min(H - 1, y + R); k++) v = op(v, tmp[k * W + x]); if (y - R < 0 || y + R > H - 1) v = op === Math.min ? -Infinity : v; out[y * W + x] = v; }
  return out;
}

/** Zone rond de onderdelen (projectie langs de as, margin mm erbij): (x, y, z) → true als het punt eronder/ernaast ligt.
 *  Voor 'rand strak maken': daar geen franjes weghalen (het tandvlees naast een steg is vaak rafelig gescand). */
export function partZone(partSoups, axis, margin = 2.5) {
  const b = axisBasis(axis), g = 0.25, cells = new Map(), key = (x, y) => x * 1000003 + y, r = Math.ceil(margin / g);
  const mark = (u, w) => { const x = Math.floor(u / g), y = Math.floor(w / g); cells.set(key(x, y), [x, y]); };
  for (const ps of partSoups) for (let i = 0; i < ps.length; i += 9) {
    const t = [0, 1, 2].map(k => b.project([ps[i + k * 3], ps[i + k * 3 + 1], ps[i + k * 3 + 2]])); for (const q of t) mark(q[0], q[1]);
    const [a, c, e] = t, d = (c[1] - e[1]) * (a[0] - e[0]) + (e[0] - c[0]) * (a[1] - e[1]); if (Math.abs(d) < 1e-12) continue;
    for (let x = Math.floor(Math.min(a[0], c[0], e[0]) / g); x <= Math.floor(Math.max(a[0], c[0], e[0]) / g); x++) for (let y = Math.floor(Math.min(a[1], c[1], e[1]) / g); y <= Math.floor(Math.max(a[1], c[1], e[1]) / g); y++) {
      const u = (x + 0.5) * g, w = (y + 0.5) * g, l1 = ((c[1] - e[1]) * (u - e[0]) + (e[0] - c[0]) * (w - e[1])) / d, l2 = ((e[1] - a[1]) * (u - e[0]) + (a[0] - e[0]) * (w - e[1])) / d;
      if (l1 >= 0 && l2 >= 0 && l1 + l2 <= 1) mark(u, w);
    }
  }
  const grown = new Set();
  for (const [x, y] of cells.values()) for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) if (dx * dx + dy * dy <= r * r) grown.add(key(x + dx, y + dy));
  return p => { const [u, w] = b.project(p); return grown.has(key(Math.floor(u / g), Math.floor(w / g))); };
}

/** Afstand (in de projectie langs de as) tot de voetafdruk van de onderdelen. Raster van 0,25 mm met
 *  afstandstransformatie; geeft (p) → { d, near: [u, w] } (near = dichtstbijzijnd punt van de voetafdruk). */
export function partDistance(partSoups, axis, range = 15) {
  const F = footprintField(partSoups, axis, range);
  return p => { const [u, w] = F.basis.project(p), r = F.at(u, w); return r.near ? { ...r, uv: [u, w], basis: F.basis } : r; };
}

/** Zelfde afstandsveld, maar in vlakcoördinaten (u, w) van axisBasis(axis): { basis, at(u, w) → { d, near } }. */
export function footprintField(partSoups, axis, range = 15) {
  const b = axisBasis(axis), g = 0.25;
  let u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity;
  const pr = []; for (const ps of partSoups) for (let i = 0; i < ps.length; i += 3) { const q = b.project([ps[i], ps[i + 1], ps[i + 2]]); pr.push(q); u0 = Math.min(u0, q[0]); u1 = Math.max(u1, q[0]); w0 = Math.min(w0, q[1]); w1 = Math.max(w1, q[1]); }
  if (!pr.length) return { basis: b, at: () => ({ d: Infinity, near: null }) };
  const x0 = Math.floor((u0 - range) / g), y0 = Math.floor((w0 - range) / g), W = Math.ceil((u1 + range) / g) - x0 + 1, H = Math.ceil((w1 + range) / g) - y0 + 1;
  const nx = new Int32Array(W * H).fill(-1), ny = new Int32Array(W * H).fill(-1);
  const mark = (u, w) => { const x = Math.floor(u / g) - x0, y = Math.floor(w / g) - y0; if (x >= 0 && y >= 0 && x < W && y < H) { nx[y * W + x] = x; ny[y * W + x] = y; } };
  for (const q of pr) mark(q[0], q[1]);
  // driehoeken vullen (grote facetten van de bovenkant hebben anders gaten in de voetafdruk)
  for (let k = 0; k + 2 < pr.length; k += 3) {
    const [a, c, e] = [pr[k], pr[k + 1], pr[k + 2]], d = (c[1] - e[1]) * (a[0] - e[0]) + (e[0] - c[0]) * (a[1] - e[1]); if (Math.abs(d) < 1e-12) continue;
    for (let x = Math.floor(Math.min(a[0], c[0], e[0]) / g); x <= Math.floor(Math.max(a[0], c[0], e[0]) / g); x++) for (let y = Math.floor(Math.min(a[1], c[1], e[1]) / g); y <= Math.floor(Math.max(a[1], c[1], e[1]) / g); y++) {
      const u = (x + 0.5) * g, w = (y + 0.5) * g, l1 = ((c[1] - e[1]) * (u - e[0]) + (e[0] - c[0]) * (w - e[1])) / d, l2 = ((e[1] - a[1]) * (u - e[0]) + (a[0] - e[0]) * (w - e[1])) / d;
      if (l1 >= 0 && l2 >= 0 && l1 + l2 <= 1) mark(u, w);
    }
  }
  // twee doorgangen (8-buren), dichtstbijzijnde voetafdrukcel doorgeven
  const dist = (i, x, y) => nx[i] < 0 ? Infinity : Math.hypot(nx[i] - x, ny[i] - y);
  const relax = (i, j, x, y) => { if (nx[j] >= 0 && Math.hypot(nx[j] - x, ny[j] - y) < dist(i, x, y)) { nx[i] = nx[j]; ny[i] = ny[j]; } };
  // (8SSEDT: per rij ook een veeg terug, anders loopt de dichtstbijzijnde cel scheef)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) { const i = y * W + x; if (x > 0) relax(i, i - 1, x, y); if (y > 0) { relax(i, i - W, x, y); if (x > 0) relax(i, i - W - 1, x, y); if (x < W - 1) relax(i, i - W + 1, x, y); } }
    for (let x = W - 2; x >= 0; x--) relax(y * W + x, y * W + x + 1, x, y);
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) { const i = y * W + x; if (x < W - 1) relax(i, i + 1, x, y); if (y < H - 1) { relax(i, i + W, x, y); if (x < W - 1) relax(i, i + W + 1, x, y); if (x > 0) relax(i, i + W - 1, x, y); } }
    for (let x = 1; x < W; x++) relax(y * W + x, y * W + x - 1, x, y);
  }
  const at = (u, w) => {
    const x = Math.floor(u / g) - x0, y = Math.floor(w / g) - y0;
    if (x < 0 || y < 0 || x >= W || y >= H) return { d: Infinity, near: null };
    const i = y * W + x; if (nx[i] < 0) return { d: Infinity, near: null };
    const nu = (nx[i] + x0 + 0.5) * g, nw = (ny[i] + y0 + 0.5) * g;
    return { d: nx[i] === x && ny[i] === y ? 0 : Math.hypot(nu - u, nw - w), near: [nu, nw] };
  };
  return { basis: b, at, box: [(x0 + 0.5) * g, (y0 + 0.5) * g, (x0 + W - 0.5) * g, (y0 + H - 0.5) * g] };
}

/** v73: omtrek (3D-punten, rond de as) minstens minDist mm van de voetafdruk van de onderdelen af houden.
 *  Het gebied binnen de omtrek wordt verenigd met de voetafdruk, minDist mm verbreed (raster van 0,25 mm). Alleen de
 *  stukken van de omtrek die te dicht bij een onderdeel komen, worden vervangen door de rand van dat verenigde gebied;
 *  de rest blijft punt voor punt gelijk. Zo kruist de nieuwe omtrek zichzelf nooit. (v72 schoof elk punt los opzij:
 *  bij een frenulum-inkeping vlak naast een abutment raakte de volgorde van de punten dan door elkaar en kruiste de
 *  lijn zichzelf, en de automatische omtrek mislukte.) De diepte langs de as van nieuwe punten wordt geïnterpoleerd;
 *  depthAt(u, w) mag een betere waarde geven (bijv. de scanhoogte). Geeft nieuwe punten (of dezelfde array). */
export function keepOutlineClear(points, partSoups, axis, minDist = 3, { depthAt = null, report = null, minClear = minDist } = {}) {
  if (!partSoups.length || points.length < 3) return points;
  const F = footprintField(partSoups, axis, minDist + 3), b = F.basis, n0 = points.length;
  const dAt = (u, w) => F.at(u, w).d;
  let pts = points, P = pts.map(b.project);
  let area = 0; for (let i = 0; i < n0; i++) area += P[i][0] * P[(i + 1) % n0][1] - P[(i + 1) % n0][0] * P[i][1];
  const flip = area < 0; if (flip) { pts = pts.slice().reverse(); P = P.slice().reverse(); }
  const n = n0, D = pts.map(b.depth);
  // per segment i → i+1: komt het binnen 'lim' mm van een onderdeel?
  const segMin = i => { const a = P[i], c = P[(i + 1) % n], k = Math.max(1, Math.ceil(Math.hypot(c[0] - a[0], c[1] - a[1]) / 0.2)); let m = Infinity; for (let s = 0; s <= k; s++) m = Math.min(m, dAt(a[0] + (c[0] - a[0]) * s / k, a[1] + (c[1] - a[1]) * s / k)); return m; };
  const sm = P.map((_, i) => segMin(i));
  if (sm.every(m => m >= minDist - 0.05)) return points;
  // masker: binnen de omtrek ∪ verbrede voetafdruk (iets ruimer, zodat gladstrijken nooit te dicht komt)
  const g = 0.25, lim = minDist + 0.2;
  let u0 = Math.min(F.box[0], ...P.map(p => p[0])), w0 = Math.min(F.box[1], ...P.map(p => p[1])), u1 = Math.max(F.box[2], ...P.map(p => p[0])), w1 = Math.max(F.box[3], ...P.map(p => p[1]));
  const x0 = Math.floor(u0 / g) - 3, y0 = Math.floor(w0 / g) - 3, W = Math.ceil(u1 / g) + 3 - x0, H = Math.ceil(w1 / g) + 3 - y0;
  const M = new Uint8Array(W * H), poly = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) { // even-oneven vullen per rij
    const wc = (y0 + y + 0.5) * g, xs = [];
    for (let i = 0; i < n; i++) { const a = P[i], c = P[(i + 1) % n]; if ((a[1] > wc) !== (c[1] > wc)) xs.push(a[0] + (wc - a[1]) / (c[1] - a[1]) * (c[0] - a[0])); }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.ceil(xs[k] / g - 0.5) - x0); x < W && (x0 + x + 0.5) * g <= xs[k + 1]; x++) poly[y * W + x] = 1;
  }
  const dc = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) dc[y * W + x] = dAt((x0 + x + 0.5) * g, (y0 + y + 0.5) * g);
  // Tot minDist alleen binnen het plaatgebied met dichtgemaakte inkepingen (sluiten, straal rn): een inkeping (frenulum)
  // vlak naast de steg wordt opgevuld, maar de plaat loopt niet verder naar buiten dan de omtrek al ging. Anders liep een
  // lepel over de plooi heen (overextensie), kwam de rand onder in de plooi en kreeg de schaal flapjes. Alleen tot
  // minClear (de kap moet de steg toch omsluiten) mag de omtrek ook daarbuiten komen.
  const rn = 3, hull = closeMask(poly, W, H, rn / g), limMin = Math.min(minClear, minDist) + 0.2;
  for (let i = 0; i < W * H; i++) M[i] = poly[i] || (dc[i] <= lim && hull[i]) || dc[i] <= limMin ? 1 : 0;
  // holle hoeken waar de verbrede voetafdruk de omtrek raakt afronden (sluiten met straal rc), alleen vlak bij wat er
  // werkelijk bij kwam (anders vulde het afronden ook rastertrapjes elders aan de omtrek)
  const grown = new Uint8Array(W * H); let nGrown = 0; for (let i = 0; i < W * H; i++) if (M[i] && !poly[i]) { grown[i] = 1; nGrown++; }
  if (!nGrown) return points; // niets te verbreden: omtrek ongewijzigd
  const rc = 2, closed = closeMask(M, W, H, rc / g), dGrow = edt(grown, W, H);
  for (let i = 0; i < W * H; i++) if (closed[i] && (hull[i] || dc[i] <= limMin + rc) && dGrow[i] * g <= rc + 0.5) M[i] = 1;
  // alleen het deel met het plaatgebied (4-buren), gaten erin dicht, knijppunten (alleen diagonaal) opvullen
  const lab = new Int32Array(W * H).fill(-1), sizes = [], q = new Int32Array(W * H);
  for (let s = 0; s < W * H; s++) {
    if (!M[s] || lab[s] >= 0) continue;
    const id = sizes.length; let h = 0, t = 0, own = 0; q[t++] = s; lab[s] = id;
    while (h < t) { const i = q[h++], x = i % W, y = (i - x) / W; own += poly[i]; for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) if (j >= 0 && M[j] && lab[j] < 0) { lab[j] = id; q[t++] = j; } }
    sizes.push(own);
  }
  const best = sizes.indexOf(Math.max(...sizes));
  for (let i = 0; i < W * H; i++) M[i] = lab[i] === best ? 1 : 0;
  const out = new Uint8Array(W * H); { let h = 0, t = 0; for (let i = 0; i < W * H; i++) { const x = i % W, y = (i - x) / W; if ((x === 0 || y === 0 || x === W - 1 || y === H - 1) && !M[i]) { out[i] = 1; q[t++] = i; } }
    while (h < t) { const i = q[h++], x = i % W, y = (i - x) / W; for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) if (j >= 0 && !M[j] && !out[j]) { out[j] = 1; q[t++] = j; } } }
  for (let i = 0; i < W * H; i++) if (!out[i]) M[i] = 1;
  for (let pass = 0, ch = 1; pass < 6 && ch; pass++) { ch = 0; for (let y = 0; y + 1 < H; y++) for (let x = 0; x + 1 < W; x++) { const a = y * W + x, c = a + 1, d = a + W, e = d + 1; if (M[a] && M[e] && !M[c] && !M[d]) { M[c] = 1; ch = 1; } else if (M[c] && M[d] && !M[a] && !M[e]) { M[a] = 1; ch = 1; } } }
  const added = new Uint8Array(W * H); let nAdded = 0; for (let i = 0; i < W * H; i++) if (M[i] && !poly[i]) { added[i] = 1; nAdded++; }
  if (!nAdded) return points; // het gebied werd niet groter: omtrek ongewijzigd
  // buitenrand volgen (binnen links, dus tegen de klok in), hoekpunten van de cellen
  const CW = W + 1, next = new Map();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!M[y * W + x]) continue; const on = (xx, yy) => xx >= 0 && yy >= 0 && xx < W && yy < H && M[yy * W + xx];
    if (!on(x, y - 1)) next.set(y * CW + x, y * CW + x + 1);
    if (!on(x + 1, y)) next.set(y * CW + x + 1, (y + 1) * CW + x + 1);
    if (!on(x, y + 1)) next.set((y + 1) * CW + x + 1, (y + 1) * CW + x);
    if (!on(x - 1, y)) next.set((y + 1) * CW + x, y * CW + x);
  }
  if (!next.size) return points;
  let B = [], s0 = next.keys().next().value, c = s0;
  do { B.push([(c % CW + x0) * g, (Math.floor(c / CW) + y0) * g]); c = next.get(c); } while (c !== undefined && c !== s0 && B.length <= next.size);
  // trapjes van het raster wegstrijken (rand blijft ~0,1 mm op zijn plek) en herbemonsteren op ± 0,6 mm
  for (let it = 0; it < 6; it++) { const C = B.map(p => p.slice()), m = B.length; for (let i = 0; i < m; i++) for (let k = 0; k < 2; k++) B[i][k] = 0.25 * C[(i - 1 + m) % m][k] + 0.5 * C[i][k] + 0.25 * C[(i + 1) % m][k]; }
  B = resample2(B, 0.6);
  const m = B.length, cum = [0]; for (let i = 1; i <= m; i++) cum.push(cum[i - 1] + Math.hypot(B[i % m][0] - B[i - 1][0], B[i % m][1] - B[i - 1][1]));
  const perim = cum[m], nearestB = p => { let bi = 0, bd = Infinity; for (let i = 0; i < m; i++) { const d = Math.hypot(B[i][0] - p[0], B[i][1] - p[1]); if (d < bd) { bd = d; bi = i; } } return bi; };
  const to3 = (u, w, d) => { const z = depthAt ? depthAt(u, w) ?? d : d; return [b.U[0] * u + b.V[0] * w + b.N[0] * z, b.U[1] * u + b.V[1] * w + b.N[1] * z, b.U[2] * u + b.V[2] * w + b.N[2] * z]; };
  // vrij = punt én beide aangrenzende stukken ver (≥ 0,75 mm) van wat er bij het gebied is gekomen: daar blijft de
  // omtrek punt voor punt gelijk; alleen waar het gebied echt groter werd, komt de nieuwe rand
  const dAdd = edt(added, W, H), cellD = (u, w) => { const x = Math.floor(u / g) - x0, y = Math.floor(w / g) - y0; return x < 0 || y < 0 || x >= W || y >= H ? Infinity : dAdd[y * W + x] * g; };
  const segFree = i => { const a = P[i], c = P[(i + 1) % n], k = Math.max(1, Math.ceil(Math.hypot(c[0] - a[0], c[1] - a[1]) / 0.2)); for (let s2 = 0; s2 <= k; s2++) if (cellD(a[0] + (c[0] - a[0]) * s2 / k, a[1] + (c[1] - a[1]) * s2 / k) < 0.75) return false; return true; };
  const sf = P.map((_, i) => segFree(i)), free = P.map((_, i) => sf[(i - 1 + n) % n] && sf[i]);
  if (report) report.clearance = Math.min(...sm);
  let result;
  if (!free.some(Boolean)) result = B.map(([u, w]) => to3(u, w, D[0]));
  else {
    result = []; const start = free.indexOf(true); let i = start, replaced = 0;
    do {
      if (free[i]) { result.push(pts[i].slice()); i = (i + 1) % n; continue; }
      let j = i; while (!free[j]) j = (j + 1) % n; // stuk i..j-1 vervangen; i-1 en j blijven
      const A = (i - 1 + n) % n, ja = nearestB(P[A]), jc = nearestB(P[j]);
      let len = cum[jc] - cum[ja]; if (len < 0) len += perim;
      if (len > perim * 0.6) { for (let k = i; k !== j; k = (k + 1) % n) result.push(pts[k].slice()); } // onverwacht: laten staan (untangle vangt het op)
      else for (let k = (ja + 1) % m, s = 0; k !== jc; k = (k + 1) % m) {
        s += Math.hypot(B[k][0] - B[(k - 1 + m) % m][0], B[k][1] - B[(k - 1 + m) % m][1]);
        if (s < 0.4 || len - s < 0.4) continue; // niet vlak op de blijvende punten
        result.push(to3(B[k][0], B[k][1], D[A] + (D[j] - D[A]) * Math.min(1, s / len)));
      }
      replaced += (j - i + n) % n; i = j;
    } while (i !== start);
    if (report) report.replaced = replaced;
  }
  return flip ? result.reverse() : result;
}

// Afstand (in cellen) tot de dichtstbijzijnde cel met mask = 1 (8SSEDT, zoals footprintField). Buiten het raster: ver.
function edt(mask, W, H) {
  const nx = new Int32Array(W * H).fill(-1), ny = new Int32Array(W * H).fill(-1);
  for (let i = 0; i < W * H; i++) if (mask[i]) { nx[i] = i % W; ny[i] = (i - i % W) / W; }
  const dist = (i, x, y) => nx[i] < 0 ? Infinity : Math.hypot(nx[i] - x, ny[i] - y);
  const relax = (i, j, x, y) => { if (nx[j] >= 0 && Math.hypot(nx[j] - x, ny[j] - y) < dist(i, x, y)) { nx[i] = nx[j]; ny[i] = ny[j]; } };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) { const i = y * W + x; if (x > 0) relax(i, i - 1, x, y); if (y > 0) { relax(i, i - W, x, y); if (x > 0) relax(i, i - W - 1, x, y); if (x < W - 1) relax(i, i - W + 1, x, y); } }
    for (let x = W - 2; x >= 0; x--) relax(y * W + x, y * W + x + 1, x, y);
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) { const i = y * W + x; if (x < W - 1) relax(i, i + 1, x, y); if (y < H - 1) { relax(i, i + W, x, y); if (x < W - 1) relax(i, i + W + 1, x, y); if (x > 0) relax(i, i + W - 1, x, y); } }
    for (let x = 1; x < W; x++) relax(y * W + x, y * W + x - 1, x, y);
  }
  const d = new Float32Array(W * H); for (let i = 0; i < W * H; i++) d[i] = dist(i, i % W, (i - i % W) / W);
  return d;
}
// morfologisch sluiten (uitzetten en weer krimpen, straal r cellen): inkepingen smaller dan 2r en holle hoeken dicht
function closeMask(mask, W, H, r) {
  const d1 = edt(mask, W, H), grown = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) grown[i] = d1[i] <= r ? 0 : 1; // grown = buiten na uitzetten
  const d2 = edt(grown, W, H), out = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) out[i] = d2[i] > r || mask[i] ? 1 : 0;
  return out;
}

// 2D-polyline (gesloten) herbemonsteren op gelijke afstand
function resample2(P, step) {
  const n = P.length, cum = [0]; for (let i = 1; i <= n; i++) cum.push(cum[i - 1] + Math.hypot(P[i % n][0] - P[i - 1][0], P[i % n][1] - P[i - 1][1]));
  const L = cum[n], k = Math.max(8, Math.round(L / step)), out = []; let j = 0;
  for (let s = 0; s < k; s++) { const t = L * s / k; while (cum[j + 1] < t) j++; const f = (t - cum[j]) / ((cum[j + 1] - cum[j]) || 1), a = P[j], c = P[(j + 1) % n]; out.push([a[0] + (c[0] - a[0]) * f, a[1] + (c[1] - a[1]) * f]); }
  return out;
}

// ---------- v72: kap over de steg (CSG) ----------
// Een werkstuk over een steg = plaat op het tandvlees ∪ kap over de steg − uitsparing. De uitsparing is de steg met
// alles eronder (langs de insteekas, schroefkanalen dicht): zo blijft er nooit plaatmateriaal onder de steg (geen
// ondersnijding) en klemt het werkstuk niet vast. De kap is de bovenkant van de steg, rondom 'gap + wall' groter.
// Beide zijn 'hoogteveld-blokken' op een raster van 0,2 mm langs de as: gesloten en manifold.

/** Bovenkant van de onderdelen als raster langs de as. Geeft { b, g, x0, y0, W, H, top, lo }. */
function topGrid(partSoups, axis, { g = 0.2, margin = 0, channel = 1.5 } = {}) {
  const b = axisBasis(axis), tris = [];
  let u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity, lo = Infinity;
  for (const ps of partSoups) for (let i = 0; i < ps.length; i += 9) {
    const t = [0, 1, 2].map(k => { const q = [ps[i + k * 3], ps[i + k * 3 + 1], ps[i + k * 3 + 2]], [u, w] = b.project(q); return [u, w, b.depth(q)]; });
    tris.push(t);
    for (const q of t) { u0 = Math.min(u0, q[0]); u1 = Math.max(u1, q[0]); w0 = Math.min(w0, q[1]); w1 = Math.max(w1, q[1]); lo = Math.min(lo, q[2]); }
  }
  const pad = Math.ceil((margin + 1) / g), x0 = Math.floor(u0 / g) - pad, y0 = Math.floor(w0 / g) - pad, W = Math.floor(u1 / g) + pad + 1 - x0, H = Math.floor(w1 / g) + pad + 1 - y0;
  const top = new Float32Array(W * H).fill(-Infinity);
  for (const t of tris) {
    for (const q of t) { const i = (Math.floor(q[1] / g) - y0) * W + Math.floor(q[0] / g) - x0; if (q[2] > top[i]) top[i] = q[2]; }
    const [a, c, e] = t, d = (c[1] - e[1]) * (a[0] - e[0]) + (e[0] - c[0]) * (a[1] - e[1]); if (Math.abs(d) < 1e-14) continue;
    for (let x = Math.floor(Math.min(a[0], c[0], e[0]) / g); x <= Math.floor(Math.max(a[0], c[0], e[0]) / g); x++) for (let y = Math.floor(Math.min(a[1], c[1], e[1]) / g); y <= Math.floor(Math.max(a[1], c[1], e[1]) / g); y++) {
      const u = (x + 0.5) * g, w = (y + 0.5) * g, l1 = ((c[1] - e[1]) * (u - e[0]) + (e[0] - c[0]) * (w - e[1])) / d, l2 = ((e[1] - a[1]) * (u - e[0]) + (a[0] - e[0]) * (w - e[1])) / d, l3 = 1 - l1 - l2;
      if (l1 < 0 || l2 < 0 || l3 < 0) continue;
      const h = l1 * a[2] + l2 * c[2] + l3 * e[2], i = (y - y0) * W + (x - x0); if (h > top[i]) top[i] = h;
    }
  }
  if (channel > 0) { const R = Math.round(channel / g), dil = filter2(top, W, H, R, Math.max), clo = filter2(dil, W, H, R, Math.min); for (let i = 0; i < top.length; i++) if (clo[i] > top[i]) top[i] = clo[i]; }
  return { b, g, x0, y0, W, H, top, lo };
}

// lege cellen (-∞) vullen met het gemiddelde van gevulde buren, laag voor laag (iters cellen ver)
function inpaint(a, W, H, iters) {
  let cur = Float32Array.from(a);
  for (let it = 0; it < iters; it++) {
    const nxt = Float32Array.from(cur); let changed = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; if (cur[i] > -Infinity) continue;
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if ((dx || dy) && xx >= 0 && yy >= 0 && xx < W && yy < H && cur[yy * W + xx] > -Infinity) { s += cur[yy * W + xx]; n++; } }
      if (n) { nxt[i] = s / n; changed++; }
    }
    cur = nxt; if (!changed) break;
  }
  return cur;
}

// ellipsoïde-dilatatie van een hoogteveld: out(c) = max over c' binnen rl (zijwaarts) van top(c') + rv·√(1 − (d/rl)²);
// rv = rl is een bol
function ballDilate(G, rl, rv = rl, top = G.top) {
  const { W, H, g } = G, R = Math.ceil(rl / g), out = new Float32Array(W * H).fill(-Infinity), offs = [];
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) { const d = Math.hypot(dx, dy) * g; if (d <= rl) offs.push(dx, dy, rv * Math.sqrt(Math.max(0, 1 - (d / rl) ** 2))); }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const t = top[y * W + x]; if (t === -Infinity) continue;
    for (let k = 0; k < offs.length; k += 3) { const xx = x + offs[k], yy = y + offs[k + 1]; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; const v = t + offs[k + 2], i = yy * W + xx; if (v > out[i]) out[i] = v; }
  }
  return out;
}

// Hoogteveld-blok (masker = top > -∞) met per cel een onderkant → gesloten driehoeksmesh (soup) in wereldcoördinaten.
function prismSoup(G, top, bottom) {
  const { W, H, g, x0, y0, b } = G, m = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) m[i] = top[i] > -Infinity ? 1 : 0;
  // alleen-diagonaal rakende cellen verbinden (anders een knijppunt: niet manifold)
  for (let pass = 0; pass < 3; pass++) for (let y = 0; y + 1 < H; y++) for (let x = 0; x + 1 < W; x++) {
    const a = y * W + x, c = a + 1, d = a + W, e = d + 1;
    if (m[a] && m[e] && !m[c] && !m[d]) { m[c] = 1; top[c] = Math.max(top[a], top[e]); bottom[c] = Math.min(bottom[a], bottom[e]); }
    else if (m[c] && m[d] && !m[a] && !m[e]) { m[a] = 1; top[a] = Math.max(top[c], top[d]); bottom[a] = Math.min(bottom[c], bottom[d]); }
  }
  const CW = W + 1, cTop = new Float64Array(CW * (H + 1)).fill(-Infinity), cBot = new Float64Array(CW * (H + 1)).fill(Infinity);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (!m[i]) continue; for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const c = (y + dy) * CW + x + dx; cTop[c] = Math.max(cTop[c], top[i]); cBot[c] = Math.min(cBot[c], bottom[i]); } }
  // trapjes in de zijwand afschuinen: een bolle hoek (1 cel binnen) schuift 0,3 cel naar binnen, een holle hoek
  // (3 cellen binnen) 0,3 cel naar buiten. Alleen zijwaarts, de topologie blijft gelijk (gesloten en manifold).
  const off = new Float32Array(CW * (H + 1) * 2);
  for (let cy = 0; cy <= H; cy++) for (let cx = 0; cx <= W; cx++) {
    let k = 0, gx = 0, gy = 0, ex = 0, ey = 0;
    for (const [dx, dy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) { const x = cx + dx, y = cy + dy, inside = x >= 0 && y >= 0 && x < W && y < H && m[y * W + x]; const vx = dx + 0.5, vy = dy + 0.5; if (inside) { k++; gx += vx; gy += vy; } else { ex += vx; ey += vy; } }
    const c = (cy * CW + cx) * 2;
    if (k === 1) { const l = Math.hypot(gx, gy) || 1; off[c] = gx / l * 0.3; off[c + 1] = gy / l * 0.3; }
    else if (k === 3) { const l = Math.hypot(ex, ey) || 1; off[c] = ex / l * 0.3; off[c + 1] = ey / l * 0.3; }
  }
  const out = [], U = b.U, V = b.V, N = b.N;
  const P = (cx, cy, h) => { const c = (cy * CW + cx) * 2, u = (cx + off[c] + x0) * g, w = (cy + off[c + 1] + y0) * g; return [U[0] * u + V[0] * w + N[0] * h, U[1] * u + V[1] * w + N[1] * h, U[2] * u + V[2] * w + N[2] * h]; };
  const T = (cx, cy) => P(cx, cy, cTop[cy * CW + cx]), B = (cx, cy) => P(cx, cy, cBot[cy * CW + cx]);
  const tri = (p, q, r) => out.push(...p, ...q, ...r);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!m[y * W + x]) continue;
    tri(T(x, y), T(x + 1, y), T(x + 1, y + 1)); tri(T(x, y), T(x + 1, y + 1), T(x, y + 1)); // boven (normaal +N)
    tri(B(x, y), B(x + 1, y + 1), B(x + 1, y)); tri(B(x, y), B(x, y + 1), B(x + 1, y + 1)); // onder
    const on = (xx, yy) => xx >= 0 && yy >= 0 && xx < W && yy < H && m[yy * W + xx];
    if (!on(x, y - 1)) { tri(B(x, y), B(x + 1, y), T(x + 1, y)); tri(B(x, y), T(x + 1, y), T(x, y)); }
    if (!on(x + 1, y)) { tri(B(x + 1, y), B(x + 1, y + 1), T(x + 1, y + 1)); tri(B(x + 1, y), T(x + 1, y + 1), T(x + 1, y)); }
    if (!on(x, y + 1)) { tri(B(x + 1, y + 1), B(x, y + 1), T(x, y + 1)); tri(B(x + 1, y + 1), T(x, y + 1), T(x + 1, y + 1)); }
    if (!on(x - 1, y)) { tri(B(x, y + 1), B(x, y), T(x, y)); tri(B(x, y + 1), T(x, y), T(x, y + 1)); }
  }
  return Float32Array.from(out);
}

/** Kap en uitsparing voor een werkstuk over de onderdelen.
 *  gap = ruimte tot de steg (afdrukruimte of passpeling), wall = dikte van de kap, scan = plaatoppervlak (de kap
 *  begint 0,8 mm onder het tandvlees, zodat 'wegsnijden onder het pasvlak' hem netjes afsnijdt).
 *  Geeft { cap, relief } (gesloten soups) of null. */
export function barBlocks(partSoups, axis, { gap = 0, wall = 2, scan = null } = {}) {
  if (!partSoups.length) return null;
  const G = topGrid(partSoups, axis, { margin: gap + wall + 1 }), { W, H, g, x0, y0, b } = G;
  // tandvleeshoogte per cel (hoogste punt van het plaatoppervlak), voor de onderkant van de kap
  let gum = new Float32Array(W * H).fill(-Infinity);
  if (scan) {
    for (let i = 0; i < scan.length; i += 9) {
      const t = [0, 1, 2].map(k => { const q = [scan[i + k * 3], scan[i + k * 3 + 1], scan[i + k * 3 + 2]], [u, w] = b.project(q); return [u / g - x0, w / g - y0, b.depth(q)]; });
      const xa = Math.max(0, Math.floor(Math.min(t[0][0], t[1][0], t[2][0]))), xb = Math.min(W - 1, Math.floor(Math.max(t[0][0], t[1][0], t[2][0]))), ya = Math.max(0, Math.floor(Math.min(t[0][1], t[1][1], t[2][1]))), yb = Math.min(H - 1, Math.floor(Math.max(t[0][1], t[1][1], t[2][1])));
      if (xa > xb || ya > yb) continue;
      const [a, c, e] = t, d = (c[1] - e[1]) * (a[0] - e[0]) + (e[0] - c[0]) * (a[1] - e[1]);
      for (const q of t) { const x = Math.floor(q[0]), y = Math.floor(q[1]); if (x >= 0 && y >= 0 && x < W && y < H && q[2] > gum[y * W + x]) gum[y * W + x] = q[2]; }
      if (Math.abs(d) < 1e-12) continue;
      for (let x = xa; x <= xb; x++) for (let y = ya; y <= yb; y++) {
        const u = x + 0.5, w = y + 0.5, l1 = ((c[1] - e[1]) * (u - e[0]) + (e[0] - c[0]) * (w - e[1])) / d, l2 = ((e[1] - a[1]) * (u - e[0]) + (a[0] - e[0]) * (w - e[1])) / d, l3 = 1 - l1 - l2;
        if (l1 < 0 || l2 < 0 || l3 < 0) continue;
        const h = l1 * a[2] + l2 * c[2] + l3 * e[2], k = y * W + x; if (h > gum[k]) gum[k] = h;
      }
    }
    gum = filter2(gum, W, H, 1, Math.max); // kleine gaatjes in het raster dicht
    gum = inpaint(gum, W, H, 40);           // gaten (implantaatopening) en tot 8 mm buiten de rand: van de buren
    // delen van het onderdeel onder het tandvlees (implantaat/abutment) tellen niet mee voor kap en uitsparing
    for (let i = 0; i < W * H; i++) if (G.top[i] > -Infinity && gum[i] > -Infinity && G.top[i] < gum[i] + 0.3) G.top[i] = -Infinity;
  }
  let gumMin = Infinity; for (const v of gum) if (v > -Infinity && v < gumMin) gumMin = v;
  const deep = Math.min(gumMin, G.lo) - 6;
  // uitsparing: de steg met alles eronder; boven 'gap' ruimte, opzij gap + 0,3 mm (passieve pasvorm, en de zijwand van
  // de uitsparing valt dan niet samen met de binnenkant van een lepel die zelf ook 'gap' van het tandvlees ligt)
  const side = gap + 0.3, rTop = ballDilate(G, side, gap), rBot = new Float32Array(W * H).fill(deep);
  const relief = prismSoup(G, Float32Array.from(rTop), rBot);
  // kap: bovenkant + gap + wall; onderkant 1 mm boven het pasvlak (tandvlees + gap): hij loopt midden in de plaatwand
  // over (een schone snijlijn, ook waar de plaatrand dun uitloopt), er hoeft niets onder het pasvlak weggesneden te
  // worden en bij een lepel blijft de afdrukruimte naast de steg. Waar geen plaatoppervlak is: 6 mm onder de steg.
  // v73: onderkant van de kap midden in de plaatwand, ook op een helling: verticaal (ruimte + ½ wand) / cos(helling).
  // Met een vaste 'tandvlees + ruimte + 1 mm' lag de onderkant op een helling van ± 50° precies op het pasvlak van een
  // lepel (2 mm loodrecht = 3 mm verticaal): samenvallende vlakken, niet-manifold randen naast de steg.
  const mid = gap + Math.min(wall * 0.5, 1.25), slope = new Float32Array(W * H).fill(1);
  if (scan) {
    const sm = filter2(filter2(gum, W, H, 2, Math.max), W, H, 2, Math.min); // licht gesloten: geen ruis van losse cellen
    for (let y = 1; y + 1 < H; y++) for (let x = 1; x + 1 < W; x++) {
      const i = y * W + x, a = sm[i - 1], c = sm[i + 1], d = sm[i - W], e = sm[i + W];
      if (a > -Infinity && c > -Infinity && d > -Infinity && e > -Infinity) slope[i] = Math.min(2.5, Math.hypot((c - a) / (2 * g), (e - d) / (2 * g), 1));
    }
  }
  const kTop = ballDilate(G, wall, wall, rTop), kBot = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (kTop[i] === -Infinity) continue; const s = gum[i];
    // ligt de kap hier lager dan het midden van de plaatwand (tandvlees dat naast de steg hoger oploopt dan de steg),
    // dan zit hij helemaal in de plaat of zelfs in het weefsel: daar geen kap (anders stak hij in de afdrukruimte)
    if (s > -Infinity && kTop[i] < s + mid * slope[i]) { kTop[i] = -Infinity; continue; }
    kBot[i] = s > -Infinity ? Math.min(s + mid * slope[i], kTop[i] - 0.5) : Math.max(deep, kTop[i] - (gap + wall) - 6);
  }
  const cap = prismSoup(G, kTop, kBot);
  return { cap, relief };
}

/** v73: hoeveel materiaal zit er rond de uitsparing voor de steg? Voor elk facet van het werkstuk dat op de uitsparing
 *  ligt (de holte rond de steg) een straal recht het materiaal in (tegen de normaal in) tot hij er weer uitkomt: de
 *  wanddikte daar. (De afstand tot het dichtstbijzijnde andere facet gaf 0 mm op elke snijrand.) Alleen de holte boven
 *  het tandvlees (≥ aboveScan mm van de scan); 'top' = plafond (boven de steg), 'side' = zijwanden.
 *  Geeft { top, side } met { min, p5, at } (mm, at = plek van het minimum) of null als er geen holte is. */
export function wallAroundRelief(soup, relief, scan, axis, { onRelief = 0.02, aboveScan = 1 } = {}) {
  const n = soup.length / 9; if (!n || !relief?.length) return null;
  const N = axisBasis(axis).N, rb = new TriBVH(relief), sb = scan?.length ? new TriBVH(scan) : null;
  const cen = t => { const o = t * 9; return [(soup[o] + soup[o + 3] + soup[o + 6]) / 3, (soup[o + 1] + soup[o + 4] + soup[o + 7]) / 3, (soup[o + 2] + soup[o + 5] + soup[o + 8]) / 3]; };
  const on = new Uint8Array(n); let cnt = 0;
  for (let t = 0; t < n; t++) { const c = cen(t); if (rb.closest(c[0], c[1], c[2], onRelief * 2) <= onRelief) { on[t] = 1; cnt++; } }
  if (!cnt || cnt === n) return null;
  const ob = new TriBVH(soup), top = [], side = [];
  for (let t = 0; t < n; t++) {
    if (!on[t]) continue;
    const c = cen(t); if (sb && sb.closest(c[0], c[1], c[2], aboveScan) < aboveScan) continue; // bij het tandvlees: niet meten
    const o = t * 9, ux = soup[o + 3] - soup[o], uy = soup[o + 4] - soup[o + 1], uz = soup[o + 5] - soup[o + 2], vx = soup[o + 6] - soup[o], vy = soup[o + 7] - soup[o + 1], vz = soup[o + 8] - soup[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz); if (l < 1e-12) continue;
    const cosN = (nx * N[0] + ny * N[1] + nz * N[2]) / l, d = ob.ray(c[0], c[1], c[2], -nx / l, -ny / l, -nz / l, 1e-4, 30);
    if (!Number.isFinite(d) || d < 0.02) continue; // geen tegenkant gevonden of een naad: niet meten
    if (cosN < -0.6) top.push([d, c]); else if (Math.abs(cosN) < 0.5) side.push([d, c]);
  }
  const stats = a => { if (!a.length) return null; a.sort((p, q) => p[0] - q[0]); return { min: a[0][0], p5: a[Math.floor(a.length * 0.05)][0], at: a[0][1], n: a.length }; };
  return { top: stats(top), side: stats(side) };
}

// Parametrische constructies langs de tandboog: beetwal, gingivaband, handvat, perforaties, weefselstops.
import { archPoint, toothType, formArch } from './teeth.js';
import { framePoint, frameBuccal } from './setup.js';
import { vec } from './analysis.js';

function signedVolume(soup) {
  let v = 0;
  for (let i = 0; i < soup.length; i += 9) {
    const a = [soup[i], soup[i + 1], soup[i + 2]], b = [soup[i + 3], soup[i + 4], soup[i + 5]], c = [soup[i + 6], soup[i + 7], soup[i + 8]];
    v += vec.dot(a, vec.cross(b, c)) / 6;
  }
  return v;
}
function outward(soup) {
  if (signedVolume(soup) >= 0) return soup;
  for (let i = 0; i < soup.length; i += 9) for (let j = 0; j < 3; j++) { const t = soup[i + 3 + j]; soup[i + 3 + j] = soup[i + 6 + j]; soup[i + 6 + j] = t; }
  return soup;
}

// Onderkant laten aansluiten op de scan, robuust voor echte scans: stralen die missen (buiten de plaatrand) krijgen
// de hoogte van de dichtstbijzijnde treffers, de hoogtes worden langs de boog gladgestreken en de onderkant blijft
// altijd ruim onder de bovenkant. Zo ontstaat geen grillige of zichzelf snijdende onderrand.
function conformRings(rings, N, conform, { minHeight = 1.5, smooth = 3 } = {}) {
  const m = rings[0].length;
  for (let j = 0; j < m; j++) {
    if (!rings[0][j].bottom) continue;
    const d = rings.map(r => { const p = r[j], hit = conform(p.q, N); return hit ? (hit[0] - p.q[0]) * N[0] + (hit[1] - p.q[1]) * N[1] + (hit[2] - p.q[2]) * N[2] : null; });
    const hits = d.map((v, i) => v === null ? -1 : i).filter(i => i >= 0);
    if (!hits.length) continue;
    for (let i = 0; i < d.length; i++) if (d[i] === null) {
      const before = hits.filter(h => h < i).at(-1), after = hits.find(h => h > i);
      d[i] = before === undefined ? d[after] : after === undefined ? d[before] : d[before] + (d[after] - d[before]) * (i - before) / (after - before);
    }
    for (let it = 0; it < smooth; it++) { const c = d.slice(); for (let i = 1; i < d.length - 1; i++) d[i] = (c[i - 1] + 2 * c[i] + c[i + 1]) / 4; }
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i], top = Math.min(...r.filter(p => !p.bottom).map(p => p.n));
      const v = Math.min(d[i], top - r[j].n - minHeight);
      r[j].q = r[j].q.map((x, k) => x + N[k] * v);
    }
  }
}

// Profielring-sweep langs de boog. profile(t) geeft [{b, n}] (buccale offset, hoogte langs N) per hoek.
// conform(punt, N) mag de onderste profielpunten op de scan laten aansluiten (zodat niets door het pasvlak steekt).
function sweep(frame, profileAt, { tStart = -1, tEnd = 1, samples = 80, form = 'oval', conform = null, arch = null } = {}) {
  const rings = [], curve = arch ?? formArch({ width: frame.width, depth: frame.depth, form });
  for (let i = 0; i <= samples; i++) {
    const t = tStart + (tEnd - tStart) * i / samples, dt = 2e-3;
    const [x, y] = curve(t);
    const [x2, y2] = curve(Math.min(1, t + dt)), [x1, y1] = curve(Math.max(-1, t - dt));
    const tan = [x2 - x1, y2 - y1], l = Math.hypot(...tan) || 1;
    const B = frameBuccal(frame, x, y, [tan[0] / l, tan[1] / l]);
    const P = framePoint(frame, x, y);
    rings.push(profileAt(t).map(({ b, n, bottom }) => ({ q: [0, 1, 2].map(k => P[k] + B[k] * b + frame.N[k] * n), n, bottom })));
  }
  if (conform) conformRings(rings, frame.N, conform);
  for (let i = 0; i < rings.length; i++) rings[i] = rings[i].map(p => p.q);
  const out = [], m = rings[0].length;
  const tri = (a, b, c) => out.push(...a, ...b, ...c);
  for (let i = 0; i < rings.length - 1; i++) for (let j = 0; j < m; j++) {
    const k = (j + 1) % m, a = rings[i][j], b = rings[i][k], c = rings[i + 1][k], d = rings[i + 1][j];
    tri(a, b, c); tri(a, c, d);
  }
  for (const [ring, flip] of [[rings[0], true], [rings[rings.length - 1], false]]) {
    const c = ring.reduce((s, p) => s.map((v, i) => v + p[i] / m), [0, 0, 0]);
    for (let j = 0; j < m; j++) flip ? tri(c, ring[(j + 1) % m], ring[j]) : tri(c, ring[j], ring[(j + 1) % m]);
  }
  return outward(Float32Array.from(out));
}

function roundedRect(width, bottom, top, topWidth = width, r = 1) {
  const hw = width / 2, ht = topWidth / 2, rr = Math.min(r, ht * 0.8, (top - bottom) / 3);
  return [{ b: -hw, n: bottom, bottom: true }, { b: hw, n: bottom, bottom: true }, { b: ht, n: top - rr }, { b: ht - rr * 0.3, n: top - rr * 0.3 }, { b: ht - rr, n: top }, { b: -ht + rr, n: top }, { b: -ht + rr * 0.3, n: top - rr * 0.3 }, { b: -ht, n: top - rr }];
}

// Beetwal: wasvormige wal van de kam tot het occlusievlak.
// height: vast getal of functie(t) → hoogte boven het boogvlak (bijv. volgens de plooiregel, voor hoger dan achter).
// arch: eigen boogfunctie (bijv. de gemeten kamlijn, verschoven naar de toekomstige tandpositie).
export function biteRim(frame, { width = 7, height = 10, embed = 1.5, form = 'oval', anteriorWidth = null, conform = null, arch = null, bottomPoints = 7 } = {}) {
  const hAt = typeof height === 'function' ? height : () => height;
  return sweep(frame, t => {
    const w = anteriorWidth ? anteriorWidth + (width - anteriorWidth) * Math.min(1, Math.abs(t) * 1.6) : width;
    const prof = roundedRect(w, -embed, hAt(t), w * 0.85, 1.2);
    // v68: onderkant met tussenpunten die elk op de plaat aansluiten (conform). Met alleen de twee hoeken liep de
    // rechte onderkant over de kam door de plaat heen tot in de afdrukruimte of het weefsel.
    if (conform && bottomPoints > 2) { const hw = w / 2, mid = []; for (let k = 1; k < bottomPoints - 1; k++) mid.push({ b: -hw + w * k / (bottomPoints - 1), n: -embed, bottom: true }); prof.splice(1, 0, ...mid); }
    return prof;
  }, { form, tStart: -0.97, tEnd: 0.97, conform, arch });
}

/** v73: hoe hoog komt een kap (over een steg) onder de beetwal? Per boogpositie t de hoogste kap langs N, gemeten vanaf
 *  het boogvlak (zelfde maat als de walhoogte), binnen de walbreedte + side mm opzij (top) en daarbuiten (beside).
 *  Geeft { ts, top, beside } (Float64Array per t, -Infinity = geen kap). */
export function capUnderRim(frame, capSoup, { width = 8, anteriorWidth = null, form = 'oval', arch = null, tStart = -0.97, tEnd = 0.97, side = 2, samples = 240 } = {}) {
  const curve = arch ?? formArch({ width: frame.width, depth: frame.depth, form });
  const ts = [], C = [];
  for (let i = 0; i <= samples; i++) { const t = tStart + (tEnd - tStart) * i / samples; ts.push(t); C.push(curve(t)); }
  const half = t => (anteriorWidth ? anteriorWidth + (width - anteriorWidth) * Math.min(1, Math.abs(t) * 1.6) : width) / 2;
  const top = new Float64Array(samples + 1).fill(-Infinity), beside = new Float64Array(samples + 1).fill(-Infinity), { O, X, Y, N } = frame;
  const seen = new Set();
  for (let i = 0; i < capSoup.length; i += 3) {
    const key = Math.round(capSoup[i] * 200) + ',' + Math.round(capSoup[i + 1] * 200) + ',' + Math.round(capSoup[i + 2] * 200);
    if (seen.has(key)) continue; seen.add(key);
    const dx = capSoup[i] - O[0], dy = capSoup[i + 1] - O[1], dz = capSoup[i + 2] - O[2];
    const x = dx * X[0] + dy * X[1] + dz * X[2], y = dx * Y[0] + dy * Y[1] + dz * Y[2], n = dx * N[0] + dy * N[1] + dz * N[2];
    let bi = 0, bd = Infinity;
    for (let k = 0; k <= samples; k++) { const d = (C[k][0] - x) ** 2 + (C[k][1] - y) ** 2; if (d < bd) { bd = d; bi = k; } }
    if (Math.sqrt(bd) <= half(ts[bi]) + side) { if (n > top[bi]) top[bi] = n; }
    else if (n > beside[bi]) beside[bi] = n;
  }
  return { ts, top, beside };
}

// Anatomisch gingivaprofiel: labiaal licht bol, vloeiend afgerond naar de halslijn, met wortelreliëf (juga):
// bulge = extra buccale welving (mm) op de plek van een wortel, het sterkst bij de hals en uitlopend naar de flens.
function gingivaProfile(width, bottom, top, topWidth, bulge = 0, flare = 0) {
  // flare: labiaal loopt de gingiva verder naar buiten en omlaag tot op het weefsel, zodat hij vloeiend overgaat
  // in de flens (geen trede tussen gingivaband en basis); de rand wordt later langs de omtrek afgesneden.
  const hw = width / 2, ht = topWidth / 2, H = top - bottom, pts = [{ b: -hw, n: bottom, bottom: true }, { b: hw + flare, n: bottom, bottom: true }];
  const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const K = 12;
  for (let k = 1; k <= K; k++) {
    const u = k / K, n = bottom + u * H;
    const juga = bulge * smooth(0.18, 0.75, u) * (1 - 0.35 * smooth(0.9, 1, u));
    const body = hw * (1 + 0.07 * Math.sin(Math.PI * u)) + juga + flare * (1 - smooth(0, 0.55, u));
    const round = smooth(0.78, 1, u); // afronden naar de tand
    pts.push({ b: body * (1 - round) + (ht + juga * 0.3) * round - 0.35 * round * round, n: n - 0.25 * round * round });
  }
  pts.push({ b: ht * 0.35, n: top }, { b: -ht * 0.35, n: top });
  for (let k = K; k >= 1; k--) { const u = k / K, round = smooth(0.78, 1, u); pts.push({ b: -(hw * (1 - round) + ht * round), n: bottom + u * H - 0.25 * round * round }); }
  return pts;
}
// Gingivaband: verbindt de basis met de halslijn van de tanden. bulge(t) = wortelreliëf langs de boog (mm).
export function gingivaBand(frame, { width = 9, top = 4, embed = 1.5, form = 'oval', conform = null, arch = null, samples = 240, bulge = null, flare = 0, simple = false, fadeFrom = [0.8, 0.8] } = {}) {
  const topAt = typeof top === 'function' ? top : () => top;
  // eenvoudige band (afgeronde rechthoek): altijd robuust, terugval als het anatomische profiel niet sluit
  if (simple) return sweep(frame, t => roundedRect(width * (0.85 + 0.25 * Math.min(1, Math.abs(t) * 1.5)), -embed, topAt(t), width * 0.7, 1.5), { form, tStart: -0.97, tEnd: 0.97, conform, arch, samples: 240 });
  // aan de uiteinden (achter de laatste molaar) loopt de band vloeiend uit in de basis: geen trede
  // pas achter het laatste element (fadeFrom = |t| van de distale rand, per kant) loopt de band uit in de basis
  const fade = t => { const st = Math.min(0.95, t < 0 ? fadeFrom[0] : fadeFrom[1]), x = Math.max(0, Math.min(1, (Math.abs(t) - st) / Math.max(0.02, 0.975 - st))); return x * x * (3 - 2 * x); };
  return sweep(frame, t => { const f = fade(t), tp = topAt(t); return gingivaProfile(width * (0.85 + 0.25 * Math.min(1, Math.abs(t) * 1.5)), -embed, tp - f * Math.max(0, tp + 0.5) * 0.85, width * 0.7, (bulge ? bulge(t) : 0) * (1 - f), flare * (1 - 0.8 * f)); }, { form, tStart: -0.97, tEnd: 0.97, conform, arch, samples });
}

export function box(center, axes, size, conform = null) {
  const [ax, ay, az] = axes, [sx, sy, sz] = size.map(v => v / 2), c = [];
  for (const i of [-1, 1]) for (const j of [-1, 1]) for (const k of [-1, 1]) c.push([0, 1, 2].map(d => center[d] + ax[d] * i * sx + ay[d] * j * sy + az[d] * k * sz));
  if (conform) {
    // onderhoeken (k = -1: index 0, 2, 4, 6) op de scan; missers krijgen het gemiddelde van de treffers
    const bottom = [0, 2, 4, 6], d = bottom.map(b => { const h = conform(c[b], az); return h ? (h[0] - c[b][0]) * az[0] + (h[1] - c[b][1]) * az[1] + (h[2] - c[b][2]) * az[2] : null; });
    const hits = d.filter(v => v !== null), mean = hits.length ? hits.reduce((a, b) => a + b, 0) / hits.length : 0;
    bottom.forEach((b, i) => { const v = Math.min(d[i] ?? mean, 2 * sz - 1.5); c[b] = c[b].map((x, k) => x + az[k] * v); });
  }
  const faces = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]], out = [];
  for (const [a, b, cc, d] of faces) out.push(...c[a], ...c[b], ...c[cc], ...c[a], ...c[cc], ...c[d]);
  return outward(Float32Array.from(out));
}

export function cylinder(start, end, radius, segments = 12) {
  const axis = vec.sub(end, start), n = vec.norm(axis);
  const u = vec.norm(Math.abs(n[0]) < 0.9 ? vec.cross(n, [1, 0, 0]) : vec.cross(n, [0, 1, 0])), w = vec.cross(n, u);
  const ring = (p) => Array.from({ length: segments }, (_, i) => { const a = 2 * Math.PI * i / segments; return [0, 1, 2].map(k => p[k] + (u[k] * Math.cos(a) + w[k] * Math.sin(a)) * radius); });
  const A = ring(start), B = ring(end), out = [];
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    out.push(...A[i], ...A[j], ...B[j], ...A[i], ...B[j], ...B[i]);
    out.push(...start, ...A[j], ...A[i], ...end, ...B[i], ...B[j]);
  }
  return outward(Float32Array.from(out));
}

// Handvat: verticale lip bij het midden, licht labiaal van de kam.
export function trayHandle(frame, { base = 2, height = 14, width = 14, thickness = 3, labial = 2, conform = null } = {}) {
  // Met conform: naar achteren schuiven tot alle vier onderhoeken boven de scan liggen (anders zweeft het handvat voor een smalle plaat).
  if (conform) for (let l = labial; l >= -10; l -= 1) {
    const corners = [-1, 1].flatMap(i => [-1, 1].map(j => framePoint(frame, i * width / 2, frame.depth + l + j * thickness / 2, 0)));
    if (corners.every(q => conform(q, frame.N))) { labial = l; break; }
  }
  const P = framePoint(frame, 0, frame.depth + labial, base + height / 2);
  return box(P, [frame.X, frame.Y, frame.N], [width, thickness, height + base], conform);
}

// v72: vormbaar handvat. Een afgeronde strip langs een kromme (kwadratische Bézier) in het vlak door N en de
// gekozen voorwaartse richting: vanaf de kam omhoog (raakt N) en dan naar de punt. Met de vinger te verslepen:
// de punt bepaalt hoogte, uitsteek naar voren en zijwaartse richting; knijpen = breedte.
// p: { height, reach, yaw (graden, + = naar links/rechts langs X), width, thickness, bend (0,2–1) }
export const HANDLE_DEFAULT = { height: 14, reach: 4, yaw: 0, width: 14, thickness: 3, bend: 0.6 };
export function handlePath(frame, p, { base = 2, conform = null, labial = 2 } = {}) {
  const { X, Y, N } = frame, P = { ...HANDLE_DEFAULT, ...p };
  const yaw = (P.yaw || 0) * Math.PI / 180, fwd = [0, 1, 2].map(i => Y[i] * Math.cos(yaw) + X[i] * Math.sin(yaw));
  const side = vec.norm(vec.cross(fwd, N));
  // voetpunt: midden voor op de kam; zo nodig naar achteren tot de hele voet boven de scan staat
  let foot = null;
  for (let l = labial; l >= -12 && !foot; l -= 1) {
    const c = framePoint(frame, 0, frame.depth + l, 0);
    if (!conform) { foot = framePoint(frame, 0, frame.depth + l, base); break; }
    const hs = [-1, 1].flatMap(i => [-1, 1].map(j => conform([0, 1, 2].map(k => c[k] + side[k] * i * P.width / 2 + fwd[k] * j * P.thickness / 2), N)));
    if (hs.every(Boolean)) { const d = hs.map(h => vec.dot(vec.sub(h, c), N)); foot = [0, 1, 2].map(k => c[k] + N[k] * Math.min(...d)); }
  }
  foot ??= framePoint(frame, 0, frame.depth + labial, base);
  const tip = [0, 1, 2].map(k => foot[k] + N[k] * P.height + fwd[k] * P.reach);
  const ctrl = [0, 1, 2].map(k => foot[k] + N[k] * P.height * Math.min(1, Math.max(0.15, P.bend)));
  return { foot, tip, ctrl, fwd, side, N, P };
}
export function handleGeometry(frame, p, opts = {}) {
  const { foot, tip, ctrl, side, N, P } = handlePath(frame, p, opts);
  const embed = Math.min(1.2, (opts.sink ?? 1.5) * 0.8), m = 28, K = 28, e = 4;
  const bez = t => [0, 1, 2].map(k => (1 - t) ** 2 * foot[k] + 2 * (1 - t) * t * ctrl[k] + t * t * tip[k]);
  const der = t => vec.norm([0, 1, 2].map(k => 2 * (1 - t) * (ctrl[k] - foot[k]) + 2 * t * (tip[k] - ctrl[k])));
  const prof = [];
  for (let k = 0; k < K; k++) { const a = 2 * Math.PI * k / K, c = Math.cos(a), s = Math.sin(a); prof.push([Math.sign(c) * Math.abs(c) ** (2 / e) * P.width / 2, Math.sign(s) * Math.abs(s) ** (2 / e) * P.thickness / 2]); }
  const rings = [], ring = (C, t, sc = 1) => { const n = vec.norm(vec.cross(side, t)); return prof.map(([u, v]) => [0, 1, 2].map(k => C[k] + side[k] * u * sc + n[k] * v * sc)); };
  rings.push(ring(foot.map((v, k) => v - N[k] * embed), N));
  for (let i = 0; i <= m; i++) { const t = i / m; rings.push(ring(bez(t), der(t))); }
  // afgeronde kop: kwartcirkel over de dikte
  const tEnd = der(1), r = P.thickness / 2;
  for (const ph of [0.35, 0.7, 1.05, 1.35]) rings.push(ring(tip.map((v, k) => v + tEnd[k] * r * Math.sin(ph)), tEnd, Math.max(0.08, Math.cos(ph))));
  const out = [], tri = (a, b, c) => out.push(...a, ...b, ...c);
  for (let j = 0; j + 1 < rings.length; j++) for (let k = 0; k < K; k++) { const a = rings[j][k], b = rings[j][(k + 1) % K], c = rings[j + 1][(k + 1) % K], d = rings[j + 1][k]; tri(a, b, c); tri(a, c, d); }
  const cap = (R, flip) => { const c = [0, 1, 2].map(k => R.reduce((s, q) => s + q[k], 0) / R.length); for (let k = 0; k < K; k++) flip ? tri(c, R[(k + 1) % K], R[k]) : tri(c, R[k], R[(k + 1) % K]); };
  cap(rings[0], true); cap(rings[rings.length - 1], false);
  return outward(Float32Array.from(out));
}

// Perforaties: cilinders langs N op en naast de kamlijn.
export function perforations(frame, { spacing = 6, radius = 1, rows = [-4, 0, 4], form = 'oval', length = 40 } = {}) {
  const cutters = [];
  const steps = 300, pts = [];
  for (let i = 0; i <= steps; i++) pts.push(archPoint(-0.92 + 1.84 * i / steps, { width: frame.width, depth: frame.depth, form }));
  let acc = spacing / 2;
  for (let i = 1; i < pts.length; i++) {
    acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc < spacing) continue;
    acc = 0;
    const [x, y] = pts[i], tan = [pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]], l = Math.hypot(...tan) || 1;
    const B = frameBuccal(frame, x, y, [tan[0] / l, tan[1] / l]);
    for (const r of rows) {
      const P = framePoint(frame, x, y);
      const Q = [0, 1, 2].map(k => P[k] + B[k] * r);
      cutters.push(cylinder(Q.map((v, k) => v - frame.N[k] * length / 2), Q.map((v, k) => v + frame.N[k] * length / 2), radius, 10));
    }
  }
  return cutters;
}

// Weefselstops: korte cilinders die de afdrukruimte overbruggen op de referentiepunten.
export function tissueStops(points, normal, { gap = 2, wall = 2.5, radius = 1.6 } = {}) {
  return points.map(p => cylinder(p.map((v, k) => v + normal[k] * 0.02), p.map((v, k) => v + normal[k] * (gap + wall * 0.5)), radius, 14));
}

export { toothType };

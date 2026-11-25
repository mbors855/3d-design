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

// v71: tandvlees als hoogteveld boven de kaak (voor de iso-'huid' van de prothese, shell.js: skin). Geeft per punt de
// gewenste hoogte van het tandvlees (langs frame.N, vanaf frame.O), of −∞ ver van de elementen. Rond elk element tot de
// halslijn + 'over', tussen buren een papil, en daarbuiten met een helling 'slope' (mm hoogte per mm afstand) omlaag:
// de huid loopt dan vanzelf glad over in flens, gehemelte en de kam achter de laatste molaar (geen trede, geen richel).
// Wortelreliëf (juga): buccaal per element een ribbel langs de wortel. Gladde maximum-functie (geen knikken).
// teeth: [{ c: halspunt (wereld), mesial, buccal: richtingen (wereld), md, bl: maten (mm), a: jugum (mm) }]
// v71: tandvlees rond de elementen als impliciet veld G(x, y, z) (± afstand in mm, < 0 = binnen). Per element een
// 'wortelzuil' langs de eigen as: doorsnede = de gemeten halsomtrek van het element + 'bulge', bovenkant = de gingivarand
// ('over' mm boven de halslijn, naar approximaal oplopend tot de papil), afgeronde rand, naar apicaal iets taps, met
// wortelreliëf (juga) aan de buccale kant. Tussen buren een smallere 'papilbrug': vult de interdentale ruimte tot de
// papiltop en laat tussen de wortels een holte. Achter het laatste element een aflopende helling. Alles glad verenigd
// (log-som-exp, straal k). Het veld blijft lokaal: geen plateaus boven de mondbodem of het gehemelte.
// teeth: [{ fdi, c (halsmidden), A (as, occlusaal), M (mesiodistaal), B (buccaal), soup (wereld) }]
// Geeft { field(x, y, z), points() (ankerpunten, o.a. voor de rasteromvang), prepare(dist) (diepte per zuil: tot in de
// scan, dist(x, y, z) = afstand tot de scan) }.
const PAPILLA = { 1: 2.4, 2: 2.2, 3: 2.0, 4: 1.8, 5: 1.7, 6: 1.5, 7: 1.4, 8: 1.3 };
const JUGUM = { 1: 0.7, 2: 0.55, 3: 1.1, 4: 0.5, 5: 0.45, 6: 0.25, 7: 0.15, 8: 0.1 };
export function gingivaField(teeth, { over = 1, juga = 1, bulge = 0.45, round = 0.7, taper = 0.025, k = 0.5, ramp = 1.0, NA = 48 } = {}) {
  const TAU = Math.PI * 2;
  const T = [];
  for (const t of teeth) {
    const { c, A, M, B, soup } = t;
    // halsband: alle punten tussen 0,5 mm onder en 'over + 1' mm boven de halslijn (lokaal: x = M, z = B)
    const xs = [], zs = []; let sx = 0, sz = 0;
    for (let i = 0; i < soup.length; i += 3) {
      const dx = soup[i] - c[0], dy = soup[i + 1] - c[1], dz = soup[i + 2] - c[2], y = dx * A[0] + dy * A[1] + dz * A[2];
      if (y < -0.5 || y > over + 1) continue;
      const x = dx * M[0] + dy * M[1] + dz * M[2], z = dx * B[0] + dy * B[1] + dz * B[2];
      xs.push(x); zs.push(z); sx += x; sz += z;
    }
    if (xs.length < 12) continue;
    const mx = sx / xs.length, mz = sz / xs.length, R = new Float64Array(NA).fill(-1);
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i] - mx, z = zs[i] - mz, r = Math.hypot(x, z), s = Math.round((Math.atan2(z, x) / TAU + 1) * NA) % NA;
      if (r > R[s]) R[s] = r;
    }
    const have = []; for (let s = 0; s < NA; s++) if (R[s] >= 0) have.push(s);
    if (have.length < NA / 4) continue;
    for (let s = 0; s < NA; s++) if (R[s] < 0) { // gaten: circulair lineair tussen de buren
      let p = s, q = s, dp = 0, dq = 0; do { p = (p - 1 + NA) % NA; dp++; } while (R[p] < 0); do { q = (q + 1) % NA; dq++; } while (R[q] < 0);
      R[s] = (R[p] * dq + R[q] * dp) / (dp + dq);
    }
    const Rf = new Float64Array(NA);
    for (let s = 0; s < NA; s++) { let w = 0, v = 0; for (let d = -3; d <= 3; d++) { const g = Math.exp(-d * d / 2); w += g; v += g * R[(s + d + NA) % NA]; } Rf[s] = Math.max(v / w, R[s] - 0.15) + bulge; }
    const type = t.fdi % 10, P = PAPILLA[type] ?? 1.5, a = (JUGUM[type] ?? 0) * juga;
    const cx = [c[0] + M[0] * mx + B[0] * mz, c[1] + M[1] * mx + B[1] * mz, c[2] + M[2] * mx + B[2] * mz];
    T.push({ fdi: t.fdi, c: cx, A, M, B, R: Rf, Rmax: Math.max(...Rf), P, a, depth: 12, dist: null });
  }
  const Rat = (t, th) => { const f = (th / TAU + 1) * NA, i = Math.floor(f), w = f - i, i0 = ((i % NA) + NA) % NA; return t.R[i0] * (1 - w) + t.R[(i0 + 1) % NA] * w; };
  const local = (t, p) => { const dx = p[0] - t.c[0], dy = p[1] - t.c[1], dz = p[2] - t.c[2]; return [dx * t.M[0] + dy * t.M[1] + dz * t.M[2], dx * t.A[0] + dy * t.A[1] + dz * t.A[2], dx * t.B[0] + dy * t.B[1] + dz * t.B[2]]; };
  // buren en papilbruggen
  const Br = [];
  for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) {
    const I = T[i], J = T[j], li = local(I, J.c), lj = local(J, I.c);
    const d = Math.hypot(J.c[0] - I.c[0], J.c[1] - I.c[1], J.c[2] - I.c[2]);
    const ri = Rat(I, Math.atan2(li[2], li[0])), rj = Rat(J, Math.atan2(lj[2], lj[0]));
    if (d > 1.35 * (ri + rj)) continue;
    const ax = [I.A[0] + J.A[0], I.A[1] + J.A[1], I.A[2] + J.A[2]], al = Math.hypot(...ax); ax[0] /= al; ax[1] /= al; ax[2] /= al;
    const dv = [J.c[0] - I.c[0], J.c[1] - I.c[1], J.c[2] - I.c[2]], dh = dv[0] * ax[0] + dv[1] * ax[1] + dv[2] * ax[2];
    const u = [dv[0] - dh * ax[0], dv[1] - dh * ax[1], dv[2] - dh * ax[2]], L = Math.hypot(...u); if (!(L > 0.5)) continue;
    u[0] /= L; u[1] /= L; u[2] /= L;
    const w = [ax[1] * u[2] - ax[2] * u[1], ax[2] * u[0] - ax[0] * u[2], ax[0] * u[1] - ax[1] * u[0]];
    const bl = t => (Rat(t, Math.PI / 2) + Rat(t, -Math.PI / 2)) / 2;
    Br.push({ i, j, o: I.c, ax, u, w, L, dh, T: 0.55 * Math.min(bl(I), bl(J)), P: Math.min(I.P, J.P) });
  }
  // distale helling: per kwadrant het element met het hoogste nummer, richting weg van zijn mesiale buur
  const quads = new Map(); T.forEach((t, i) => { const q = Math.floor(t.fdi / 10); (quads.get(q) ?? quads.set(q, []).get(q)).push(i); });
  for (const list of quads.values()) {
    if (list.length < 2) continue;
    list.sort((p, q) => T[p].fdi - T[q].fdi);
    const D = T[list[list.length - 1]], Mn = T[list[list.length - 2]], l = local(D, [2 * D.c[0] - Mn.c[0], 2 * D.c[1] - Mn.c[1], 2 * D.c[2] - Mn.c[2]]), ll = Math.hypot(l[0], l[2]);
    if (ll > 1e-6) D.dist = [l[0] / ll, l[2] / ll];
  }
  // afgeronde 'doos' in (e = radiaal, t = hoogte t.o.v. de bovenkant): ± afstand
  const rbox = (e, t) => { const qe = e + round, qt = t + round; return Math.hypot(Math.max(qe, 0), Math.max(qt, 0)) + Math.min(Math.max(qe, qt), 0) - round; };
  const jug = h => h > over ? 0 : Math.min(1, (over - h) / 3) * Math.exp(-((Math.max(0, -h - 2) / 7) ** 2));
  const vals = new Float64Array(T.length + Br.length);
  const field = (x, y, z) => {
    let n = 0, g0 = Infinity;
    for (const t of T) {
      const dx = x - t.c[0], dy = y - t.c[1], dz = z - t.c[2];
      const h = dx * t.A[0] + dy * t.A[1] + dz * t.A[2], lx = dx * t.M[0] + dy * t.M[1] + dz * t.M[2], lz = dx * t.B[0] + dy * t.B[1] + dz * t.B[2];
      const r = Math.hypot(lx, lz), below = Math.max(0, -h);
      // ondergrens zonder hoek: ver weg → overslaan
      if (r - t.Rmax - (ramp + 0.2) * below - 1.2 > g0 + 8 * k) continue;
      const cs = r > 1e-9 ? lx / r : 1, sn = r > 1e-9 ? lz / r : 0;
      let Re = Rat(t, Math.atan2(lz, lx)) * (1 - taper * below);
      if (t.a > 0 && sn > 0) Re += t.a * jug(h) * sn ** 4;
      if (t.dist) { const cd = cs * t.dist[0] + sn * t.dist[1]; if (cd > 0) Re += ramp * below * cd * cd; }
      const c2 = cs * cs, top = over + t.P * c2 * c2;
      const G = Math.max(rbox(r - Re, h - top), -(h + t.depth));
      vals[n++] = G; if (G < g0) g0 = G;
    }
    for (const b of Br) {
      const dx = x - b.o[0], dy = y - b.o[1], dz = z - b.o[2];
      const s = dx * b.u[0] + dy * b.u[1] + dz * b.u[2], wv = dx * b.w[0] + dy * b.w[1] + dz * b.w[2];
      const h = dx * b.ax[0] + dy * b.ax[1] + dz * b.ax[2] - b.dh * Math.min(1, Math.max(0, s / b.L));
      let G = rbox(Math.abs(wv) - b.T, h - (over + b.P));
      G = Math.max(G, -s, s - b.L, -(h + Math.min(T[b.i].depth, T[b.j].depth)));
      vals[n++] = G; if (G < g0) g0 = G;
    }
    if (!n) return Infinity;
    let sm = 0; for (let i = 0; i < n; i++) { const e = vals[i] - g0; if (e < 10 * k) sm += Math.exp(-e / k); }
    return g0 - k * Math.log(sm);
  };
  const world = (t, lx, h, lz) => [0, 1, 2].map(i => t.c[i] + t.M[i] * lx + t.A[i] * h + t.B[i] * lz);
  const points = () => {
    const out = [];
    for (const t of T) for (let s = 0; s < 24; s++) {
      const th = s / 24 * TAU, cs = Math.cos(th), sn = Math.sin(th), R = Rat(t, th), c2 = cs * cs;
      out.push(...world(t, cs * R, over + t.P * c2 * c2, sn * R), ...world(t, cs * (R + t.a), -2, sn * (R + t.a)));
    }
    for (const b of Br) for (const sg of [-1, 1]) out.push(...[0, 1, 2].map(i => b.o[i] + b.u[i] * b.L / 2 + b.ax[i] * (over + b.P + b.dh / 2) + b.w[i] * sg * b.T));
    return Float32Array.from(out);
  };
  // diepte per zuil: langs de as omlaag tot (bijna) op de scan, dan nog een stuk erin (wordt later weggesneden)
  const prepare = (dist) => {
    for (const t of T) {
      let d0 = null;
      for (let s = 0; s <= 40; s += 0.5) { const p = world(t, 0, -s, 0); if (dist(p[0], p[1], p[2]) < 0.6) { d0 = s; break; } }
      t.depth = d0 === null ? 12 : d0 + 2 + 0.5 * t.Rmax;
    }
  };
  return { field, points, prepare, teeth: T.length, bridges: Br.length };
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

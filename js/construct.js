// Parametrische constructies langs de tandboog: beetwal, gingivaband, handvat, perforaties, weefselstops.
import { archPoint, toothType } from './teeth.js';
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
function sweep(frame, profileAt, { tStart = -1, tEnd = 1, samples = 80, form = 'oval', conform = null } = {}) {
  const rings = [];
  for (let i = 0; i <= samples; i++) {
    const t = tStart + (tEnd - tStart) * i / samples, dt = 1e-3;
    const [x, y] = archPoint(t, { width: frame.width, depth: frame.depth, form });
    const [x2, y2] = archPoint(Math.min(1, t + dt), { width: frame.width, depth: frame.depth, form }), [x1, y1] = archPoint(Math.max(-1, t - dt), { width: frame.width, depth: frame.depth, form });
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
export function biteRim(frame, { width = 7, height = 10, embed = 1.5, form = 'oval', anteriorWidth = null, conform = null } = {}) {
  return sweep(frame, t => {
    const w = anteriorWidth ? anteriorWidth + (width - anteriorWidth) * Math.min(1, Math.abs(t) * 1.6) : width;
    return roundedRect(w, -embed, height, w * 0.85, 1.2);
  }, { form, tStart: -0.97, tEnd: 0.97, conform });
}

// Gingivaband: verbindt de basis met de halslijn van de tanden.
export function gingivaBand(frame, { width = 9, top = 4, embed = 1.5, form = 'oval', conform = null } = {}) {
  return sweep(frame, t => roundedRect(width * (0.85 + 0.25 * Math.min(1, Math.abs(t) * 1.5)), -embed, top, width * 0.7, 1.5), { form, tStart: -0.97, tEnd: 0.97, conform });
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

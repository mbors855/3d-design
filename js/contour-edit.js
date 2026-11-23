// Rekenkern voor het bewerken van een plaatomtrek: een lijn van 3D-punten op de scan.
// Vrij tekenen, een stuk overtekenen, de lijn op elke plek wegtrekken (met zachte meeneemzone), gladmaken en
// herbemonsteren. Zonder interface; los getest (tests/run.mjs). project(p) zet een punt terug op de scan.

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const onScan = (p, project) => (project ? project(p) : null) ?? p;

export function pathLength(pts, closed = false) {
  let s = 0;
  for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) s += dist(pts[i], pts[(i + 1) % pts.length]);
  return s;
}

/** Punt op parameter u = i + t (segment i, 0 ≤ t ≤ 1). */
export function pointAt(pts, u, closed = true) {
  const n = pts.length;
  if (!closed) { u = Math.max(0, Math.min(n - 1, u)); if (u >= n - 1) return pts[n - 1].slice(); }
  else u = ((u % n) + n) % n;
  const i = Math.floor(u), t = u - i;
  return lerp(pts[i], pts[(i + 1) % n], t);
}

/** Gelijkmatig herbemonsteren met stap 'spacing' (mm). Een open lijn houdt zijn eindpunten. */
export function resample(pts, spacing, { closed = false, project = null } = {}) {
  if (pts.length < 2) return pts.map(p => p.slice());
  const n = pts.length, segs = closed ? n : n - 1, cum = [0];
  for (let i = 0; i < segs; i++) cum.push(cum[i] + dist(pts[i], pts[(i + 1) % n]));
  const total = cum[segs];
  if (total < 1e-9) return [pts[0].slice()];
  const count = Math.max(closed ? 3 : 1, Math.round(total / spacing)), step = total / count, out = [];
  let seg = 0;
  for (let k = 0; k < (closed ? count : count + 1); k++) {
    const s = Math.min(total, k * step);
    while (seg < segs - 1 && cum[seg + 1] < s) seg++;
    const len = cum[seg + 1] - cum[seg], t = len > 1e-12 ? (s - cum[seg]) / len : 0;
    const p = lerp(pts[seg], pts[(seg + 1) % n], t);
    out.push(k === 0 || (!closed && k === count) ? p : onScan(p, project));
  }
  return out;
}

/** Laplace-gladmaken. Open lijn: eindpunten blijven staan. */
export function smooth(pts, { closed = false, iterations = 2, weight = 0.5, project = null } = {}) {
  let cur = pts.map(p => p.slice());
  const n = cur.length;
  if (n < 3) return cur;
  for (let it = 0; it < iterations; it++) {
    const next = cur.map(p => p.slice());
    for (let i = 0; i < n; i++) {
      if (!closed && (i === 0 || i === n - 1)) continue;
      const a = cur[(i - 1 + n) % n], b = cur[(i + 1) % n], p = cur[i];
      next[i] = onScan([0, 1, 2].map(k => p[k] + weight * ((a[k] + b[k]) / 2 - p[k])), project);
    }
    cur = next;
  }
  return cur;
}

/** Voegt punten in waar twee buren verder dan maxGap (mm) uit elkaar liggen. */
export function densify(pts, maxGap, { closed = true, project = null } = {}) {
  const out = [], n = pts.length;
  for (let i = 0; i < n; i++) {
    out.push(pts[i]);
    if (!closed && i === n - 1) break;
    const a = pts[i], b = pts[(i + 1) % n], d = dist(a, b), k = Math.ceil(d / maxGap);
    for (let j = 1; j < k; j++) out.push(onScan(lerp(a, b, j / k), project));
  }
  return out;
}

/**
 * Dichtstbijzijnde plek op een polylijn. q en de punten mogen 2D (scherm) of 3D zijn (dims).
 * valid(i) kan segmenten uitsluiten (bijv. achter de camera). Geeft { i, t, d, u } of null.
 */
export function nearestOnPath(pts, q, { closed = false, dims = 3, valid = null } = {}) {
  let best = null;
  const n = pts.length;
  for (let i = 0; i < n - (closed ? 0 : 1); i++) {
    if (valid && !valid(i)) continue;
    const a = pts[i], b = pts[(i + 1) % n];
    let ab2 = 0, ap = 0;
    for (let k = 0; k < dims; k++) { const e = b[k] - a[k]; ab2 += e * e; ap += (q[k] - a[k]) * e; }
    const t = ab2 > 1e-18 ? Math.max(0, Math.min(1, ap / ab2)) : 0;
    let d2 = 0; for (let k = 0; k < dims; k++) { const e = q[k] - a[k] - t * (b[k] - a[k]); d2 += e * e; }
    if (!best || d2 < best.d) best = { i, t, d: d2 };
  }
  if (best) { best.d = Math.sqrt(best.d); best.u = best.i + best.t; }
  return best;
}

// Indices van de omtrekpunten strikt tussen parameter ua en ub, vooruit lopend (met omloop).
function arcIndices(n, ua, ub) {
  const d = ((ub - ua) % n + n) % n, out = [], f = Math.floor(ua);
  for (let s = 1; s <= n; s++) {
    const off = f + s - ua;
    if (off >= d - 1e-9) break;
    if (off > 1e-9) out.push((f + s) % n);
  }
  return out;
}
// Gemiddelde afstand van de punten van een boog tot een polylijn.
function meanDistance(arc, path) {
  if (!arc.length) return 0;
  let s = 0;
  for (const p of arc) s += nearestOnPath(path, p, { closed: false }).d;
  return s / arc.length;
}

/**
 * Overtekenen: vervangt het stuk van de gesloten omtrek tussen de aanhechtpunten door de getekende lijn.
 * u0/u1: parameters (i + t) op de omtrek waar de streek begint en eindigt. Van de twee bogen daartussen wordt
 * de boog vervangen die het dichtst bij de getekende lijn ligt; begin en eind sluiten precies op de omtrek aan.
 * Geeft { points, replacedLength }.
 */
export function spliceClosed(points, stroke, u0, u1, { minGap = 0.3 } = {}) {
  const n = points.length, P0 = pointAt(points, u0), P1 = pointAt(points, u1);
  const fwd = arcIndices(n, u0, u1), bwd = arcIndices(n, u1, u0);
  const arcA = [P0, ...fwd.map(i => points[i]), P1], arcB = [P1, ...bwd.map(i => points[i]), P0];
  // dicht bemonsterd vergelijken, zodat een lange rechte boog niet 'dichtbij' lijkt door weinig punten
  const dense = a => a.length > 1 ? densify(a, 1, { closed: false }) : a;
  const replaceA = meanDistance(dense(arcA), stroke) <= meanDistance(dense(arcB), stroke);
  const mid = stroke.filter((p, k) => (k > 0 || dist(p, P0) > minGap) && (k < stroke.length - 1 || dist(p, P1) > minGap));
  const kept = replaceA ? bwd.map(i => points[i]) : fwd.map(i => points[i]).reverse();
  return { points: [P0, ...mid, P1, ...kept].map(p => p.slice()), replacedLength: pathLength(replaceA ? arcA : arcB) };
}

/**
 * Verlengt een open omtrek met een getekende lijn. Begint de streek bij het eerste punt, dan wordt de lijn
 * omgedraaid zodat hij aan dat einde verder gaat.
 */
export function extendOpen(points, stroke) {
  if (!points.length) return stroke.map(p => p.slice());
  const head = points[0], tail = points[points.length - 1], s0 = stroke[0];
  const base = points.length > 1 && dist(s0, head) < dist(s0, tail) ? points.slice().reverse() : points.slice();
  const last = base[base.length - 1], add = stroke.filter((p, k) => k > 0 || dist(p, last) > 0.3);
  return [...base, ...add].map(p => p.slice());
}

/**
 * Wegtrekken: de lijn op parameter u (de plek onder de vinger) gaat mee met verplaatsing delta; buren binnen
 * 'radius' mm (gemeten langs de oorspronkelijke lijn) gaan zacht mee: gewicht (1 − (s/R)²)².
 * orig blijft ongewijzigd; geeft de nieuwe punten en per punt het gewicht (voor de weergave).
 */
export function dragPoints(orig, u, delta, radius, { closed = true, project = null } = {}) {
  const n = orig.length, w = arcWeights(orig, u, radius, { closed });
  const out = orig.map((p, i) => {
    if (!w[i]) return p.slice();
    const q = [p[0] + delta[0] * w[i], p[1] + delta[1] * w[i], p[2] + delta[2] * w[i]];
    return w[i] === 1 ? q : onScan(q, project);
  });
  return { points: out, weights: w, count: n };
}

/** Gewicht per punt voor een greep op parameter u (zie dragPoints). Een punt precies op u krijgt 1. */
export function arcWeights(pts, u, radius, { closed = true } = {}) {
  const n = pts.length, w = new Float32Array(n), i0 = Math.floor(u), t = u - i0, at = j => ((j % n) + n) % n;
  const onPoint = t < 1e-6;
  if (onPoint) w[at(i0)] = 1;
  if (!(radius > 0)) { if (!onPoint) { w[at(i0)] = 1 - t; w[at(i0 + 1)] = t; } return w; }
  const g = pointAt(pts, u, closed);
  for (const [dir, first] of [[1, i0 + 1], [-1, onPoint ? i0 - 1 : i0]]) {
    let along = 0, prev = g;
    for (let k = first, step = 0; step < n; step++, k += dir) {
      if (!closed && (k < 0 || k >= n)) break;
      const j = at(k), q = pts[j];
      along += dist(prev, q); prev = q;
      if (along >= radius) break;
      const x = along / radius, wt = (1 - x * x) ** 2;
      if (wt > w[j]) w[j] = wt;
    }
  }
  return w;
}

/**
 * Een vrij getekende streek (rauwe punten op de scan, in tekenvolgorde) netjes maken: dubbele punten weg,
 * gelijkmatig herbemonsterd, licht gladgemaakt en weer op de scan gezet.
 */
export function cleanStroke(raw, { spacing = 1.25, project = null, smoothing = 2 } = {}) {
  const pts = [];
  for (const p of raw) if (!pts.length || dist(p, pts[pts.length - 1]) > 0.15) pts.push(p.slice());
  if (pts.length < 2) return pts;
  let s = resample(pts, Math.min(spacing, 0.8), { closed: false, project });
  s = smooth(s, { closed: false, iterations: smoothing, project });
  return resample(s, spacing, { closed: false, project });
}

/** Is de streek zelf rond (eindigt bij het begin)? */
export function isLoop(stroke, { gap = 4, minLength = 20 } = {}) {
  return stroke.length > 4 && dist(stroke[0], stroke[stroke.length - 1]) <= gap && pathLength(stroke) >= minLength;
}

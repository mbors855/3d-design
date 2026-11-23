// Eigen parametrische tandenbibliotheek (geen gelicentieerde fabrikantvormen).
// Lokaal assenstelsel: x = mesiodistaal (naar mesiaal positief), y = tandas (cervicaal 0 → occlusaal +),
// z = buccaal/labiaal. Elke tand is een gesloten, manifold mesh, inclusief wortelstift voor verankering in de basis.

// [mesiodistaal, buccolinguaal, kroonhoogte] in mm — gemiddelde waarden uit de literatuur.
// Wheeler's Dental Anatomy (9e druk), gemiddelde kroonmaten — dezelfde als de anatomische kronen (crowns.js).
const DIMENSIONS = {
  upper: { 1: [8.5, 7.0, 10.5], 2: [6.5, 6.0, 9.0], 3: [7.5, 8.0, 10.0], 4: [7.0, 9.0, 8.5], 5: [7.0, 9.0, 8.5], 6: [10.0, 11.0, 7.5], 7: [9.0, 11.0, 7.0], 8: [8.5, 10.0, 6.5] },
  lower: { 1: [5.0, 6.0, 9.0], 2: [5.5, 6.5, 9.5], 3: [7.0, 7.5, 11.0], 4: [7.0, 7.5, 8.5], 5: [7.0, 8.0, 8.0], 6: [11.0, 10.5, 7.5], 7: [10.5, 10.0, 7.0], 8: [10.0, 9.5, 7.0] },
};

export const FDI_UPPER = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28];
export const FDI_LOWER = [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38];

export function isUpper(fdi) { const q = Math.floor(fdi / 10); return q === 1 || q === 2; }
export function isRightSide(fdi) { const q = Math.floor(fdi / 10); return q === 1 || q === 4; }
export function toothType(fdi) { return fdi % 10; }
export function validFDI(id) { const n = Number(id), q = Math.floor(n / 10), t = n % 10; return Number.isInteger(n) && q >= 1 && q <= 4 && t >= 1 && t <= 8; }

export function toothDimensions(fdi, scale = 1) {
  const d = DIMENSIONS[isUpper(fdi) ? 'upper' : 'lower'][toothType(fdi)];
  return { md: d[0] * scale, bl: d[1] * scale, height: d[2] * scale };
}

function cuspsFor(type) {
  if (type <= 2) return [];
  if (type === 3) return [[0, 0.05, 1.4]];
  if (type <= 5) return [[0, 0.5, 1], [0, -0.5, 0.8]];
  return [[0.45, 0.5, 1], [-0.45, 0.5, 0.95], [0.45, -0.5, 0.9], [-0.4, -0.5, 0.75]];
}

export function makeTooth(fdi, { scale = 1, shape = 'oval', cuspHeight = 1, rootLength = 4, segments = 24 } = {}) {
  const type = toothType(fdi), { md, bl, height } = toothDimensions(fdi, scale);
  const anterior = type <= 3, incisor = type <= 2;
  const exponent = shape === 'square' ? 3.2 : shape === 'tapered' ? 2.0 : 2.5;
  const a0 = md / 2, b0 = bl / 2;
  // Breedteprofiel over de hoogte (factor op halve breedtes), van wortelpunt naar occlusaal.
  const levels = [];
  const rootSteps = 4;
  for (let k = rootSteps; k >= 1; k--) {
    const t = k / rootSteps;
    levels.push({ y: -rootLength * t, sa: 0.78 - 0.25 * t, sb: 0.78 - 0.25 * t });
  }
  const crownSteps = 8;
  for (let k = 0; k <= crownSteps; k++) {
    const t = k / crownSteps;
    const bulge = Math.sin(Math.min(1, t / 0.75) * Math.PI / 2);
    let sa = 0.8 + 0.2 * bulge, sb = 0.82 + 0.18 * Math.sin(Math.min(1, t / 0.35) * Math.PI / 2);
    if (incisor) {
      sb *= 1 - 0.68 * Math.pow(t, 1.6);
      if (shape === 'tapered') sa *= 1 - 0.18 * t * (1 - t) - 0.1 * t;
      if (shape === 'square') sa *= 1 + 0.04 * t;
    } else if (type === 3) {
      sb *= 1 - 0.35 * Math.pow(t, 2);
      sa *= 1 - 0.25 * Math.pow(t, 3);
    } else {
      sa *= 1 - 0.1 * Math.pow(t, 3); sb *= 1 - 0.14 * Math.pow(t, 3);
    }
    levels.push({ y: height * (anterior ? 0.92 : 0.82) * t, sa, sb });
  }
  const ring = (lvl) => {
    const pts = [];
    for (let j = 0; j < segments; j++) {
      const th = 2 * Math.PI * j / segments, c = Math.cos(th), s = Math.sin(th);
      const x = a0 * lvl.sa * Math.sign(c) * Math.pow(Math.abs(c), 2 / exponent);
      const z = b0 * lvl.sb * Math.sign(s) * Math.pow(Math.abs(s), 2 / exponent);
      pts.push([x, lvl.y, z]);
    }
    return pts;
  };
  const rings = levels.map(ring);
  // Occlusale kap: concentrische ringen met knobbels en fissuren.
  const top = rings[rings.length - 1], topY = levels[levels.length - 1].y;
  const cusps = cuspsFor(type), capRings = 5;
  const relief = (u, v, r) => {
    if (incisor) return height * 0.03 * (1 - r);
    let h = 0;
    for (const [cu, cv, w] of cusps) h += w * Math.exp(-((u - cu) ** 2 + (v - cv) ** 2) / 0.12);
    const base = type === 3 ? height * 0.08 : height * 0.18;
    return (base * h - (type > 3 ? height * 0.07 * (1 - r) : 0)) * cuspHeight + (type > 3 ? height * 0.06 * (1 - cuspHeight) : 0);
  };
  const aTop = a0 * levels[levels.length - 1].sa, bTop = b0 * levels[levels.length - 1].sb;
  for (let k = 1; k <= capRings; k++) {
    const r = 1 - k / (capRings + 1);
    rings.push(top.map(([x, , z]) => { const X = x * r, Z = z * r; return [X, topY + relief(X / aTop, Z / bTop, r) * Math.min(1, (1 - r) * 4), Z]; }));
  }
  const center = [0, topY + relief(0, 0, 0), 0];
  const apex = [0, -rootLength - 0.8, 0];
  const out = [];
  const tri = (a, b, c) => out.push(...a, ...c, ...b); // naar buiten gerichte normalen
  for (let j = 0; j < segments; j++) tri(apex, rings[0][(j + 1) % segments], rings[0][j]);
  for (let i = 0; i < rings.length - 1; i++) for (let j = 0; j < segments; j++) {
    const k = (j + 1) % segments, a = rings[i][j], b = rings[i][k], c = rings[i + 1][k], d = rings[i + 1][j];
    tri(a, b, c); tri(a, c, d);
  }
  const last = rings[rings.length - 1];
  for (let j = 0; j < segments; j++) tri(last[j], last[(j + 1) % segments], center);
  return { soup: Float32Array.from(out), md, bl, height, cervicalY: 0, occlusalY: center[1] };
}

// Tandboog: parabool-achtige curve in het vlak, met x links/rechts en y in de diepte.
export function archPoint(t, { width, depth, form = 'oval' }) {
  // t in [-1, 1]: -1 = rechts distaal, 0 = midden, 1 = links distaal (patiëntzijde).
  const p = form === 'square' ? 3 : form === 'tapered' ? 1.5 : 2;
  const x = t * width / 2, y = depth * (1 - Math.pow(Math.abs(t), p));
  return [x, y];
}

// Boog uit een polylijn (frame-coördinaten [x, y], van patiënt-rechts naar links). Geeft een functie t ∈ [-1, 1] → [x, y]
// met t = 0 op de middellijn (x = 0) en t = ±1 aan de uiteinden; elk deel is naar booglengte geparametriseerd.
// extend: zoveel mm lineair doortrekken langs de eindraaklijn (voor tanden die net voorbij de laatste meting vallen).
export function polylineArch(points, { extend = 0 } = {}) {
  let P = points.map(p => [p[0], p[1]]);
  if (P.length < 3) throw Error('Te weinig punten voor een boog.');
  if (P[0][0] > P.at(-1)[0]) P.reverse();
  if (extend > 0) {
    const e = (a, b) => { const d = [a[0] - b[0], a[1] - b[1]], l = Math.hypot(...d) || 1; return [a[0] + d[0] / l * extend, a[1] + d[1] / l * extend]; };
    P = [e(P[0], P[1]), ...P, e(P.at(-1), P.at(-2))];
  }
  const cum = [0];
  for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  let sMid = cum.at(-1) / 2;
  for (let i = 1; i < P.length; i++) if ((P[i - 1][0] <= 0) !== (P[i][0] <= 0)) { const f = P[i - 1][0] / ((P[i - 1][0] - P[i][0]) || 1); sMid = cum[i - 1] + f * (cum[i] - cum[i - 1]); break; }
  const total = cum.at(-1);
  const atS = s => {
    s = Math.max(0, Math.min(total, s));
    let lo = 1, hi = P.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < s) lo = m + 1; else hi = m; }
    const i = lo, f = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
    return [P[i - 1][0] + f * (P[i][0] - P[i - 1][0]), P[i - 1][1] + f * (P[i][1] - P[i - 1][1])];
  };
  const fn = t => atS(t <= 0 ? sMid * (1 + t) : sMid + t * (total - sMid));
  fn.length_ = total; fn.points = P; fn.sMid = sMid;
  return fn;
}

// Boog verschuiven loodrecht op zichzelf (positief = buccaal/labiaal, weg van het boogmidden).
// offsetAt(s) krijgt de booglengte vanaf de middellijn (mm, altijd ≥ 0) en geeft de verschuiving in mm.
export function offsetArch(arch, offsetAt, { samples = 200 } = {}) {
  const pts = [], tt = [];
  for (let i = 0; i <= samples; i++) { const t = -1 + 2 * i / samples; tt.push(t); pts.push(arch(t)); }
  const ys = pts.map(p => p[1]), c = [0, Math.min(...ys) + 0.35 * (Math.max(...ys) - Math.min(...ys))];
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const mid = cum[samples / 2];
  const out = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(samples, i + 1)], tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1;
    let n = [ty / l, -tx / l]; if (n[0] * (p[0] - c[0]) + n[1] * (p[1] - c[1]) < 0) n = [-n[0], -n[1]];
    const o = offsetAt(Math.abs(cum[i] - mid));
    return [p[0] + n[0] * o, p[1] + n[1] * o];
  });
  return polylineArch(out);
}

// Standaardboog (parabool-achtig) als functie, zodat overal dezelfde boog-interface gebruikt kan worden.
export function formArch({ width, depth, form = 'oval' }) { return t => archPoint(t, { width, depth, form }); }

// Plaatst tanden langs de boog op basis van cumulatieve mesiodistale breedte vanaf de middellijn.
// Geeft per tand de positie in het boogvlak en de mesiale richting. opts.arch: eigen boogfunctie (t → [x, y]).
export function layoutArch(ids, { jaw = 'upper', width = 50, depth = 40, form = 'oval', scale = 1, gap = 0.15, arch = null, widthOf = null } = {}) {
  const N = 400, pts = [], curve = arch ?? formArch({ width, depth, form });
  for (let i = 0; i <= N; i++) pts.push(curve(-1 + 2 * i / N));
  const cum = [0];
  for (let i = 1; i <= N; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const mid = cum[N / 2];
  const at = s => {
    s = Math.max(0, Math.min(cum[N], s));
    let i = 1; while (i < N && cum[i] < s) i++;
    const t = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
    const p = [pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])];
    const tan = [pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]], l = Math.hypot(...tan) || 1;
    return { p, tangent: [tan[0] / l, tan[1] / l] };
  };
  const quadrant = { upper: { right: 1, left: 2 }, lower: { right: 4, left: 3 } }[jaw];
  const result = [];
  for (const right of [true, false]) {
    let s = 0;
    for (let type = 1; type <= 8; type++) {
      const id = (right ? quadrant.right : quadrant.left) * 10 + type;
      const w = widthOf?.(id) ?? toothDimensions(id, scale).md, centerS = s + w / 2;
      if (ids.includes(id)) {
        const { p, tangent } = at(right ? mid - centerS : mid + centerS);
        result.push({ fdi: id, position: p, mesial: right ? tangent : [-tangent[0], -tangent[1]], distance: centerS });
      }
      s += w + gap;
    }
  }
  return result;
}

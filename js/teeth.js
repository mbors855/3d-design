// Eigen parametrische tandenbibliotheek (geen gelicentieerde fabrikantvormen).
// Lokaal assenstelsel: x = mesiodistaal (naar mesiaal positief), y = tandas (cervicaal 0 → occlusaal +),
// z = buccaal/labiaal. Elke tand is een gesloten, manifold mesh, inclusief wortelstift voor verankering in de basis.

// [mesiodistaal, buccolinguaal, kroonhoogte] in mm — gemiddelde waarden uit de literatuur.
const DIMENSIONS = {
  upper: { 1: [8.6, 7.0, 10.5], 2: [6.6, 6.0, 9.0], 3: [7.6, 8.0, 10.0], 4: [7.0, 9.0, 8.5], 5: [6.7, 9.0, 7.8], 6: [10.2, 11.0, 7.5], 7: [9.0, 11.0, 7.0], 8: [8.5, 10.5, 6.5] },
  lower: { 1: [5.3, 5.8, 9.0], 2: [5.9, 6.2, 9.5], 3: [6.9, 7.5, 11.0], 4: [7.0, 7.7, 8.5], 5: [7.2, 8.2, 8.0], 6: [11.2, 10.3, 7.5], 7: [10.5, 10.0, 7.0], 8: [10.0, 9.8, 6.5] },
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

// Plaatst tanden langs de boog op basis van cumulatieve mesiodistale breedte vanaf de middellijn.
// Geeft per tand de positie in het boogvlak en de mesiale richting.
export function layoutArch(ids, { jaw = 'upper', width = 50, depth = 40, form = 'oval', scale = 1, gap = 0.1 } = {}) {
  const N = 400, pts = [];
  for (let i = 0; i <= N; i++) pts.push(archPoint(-1 + 2 * i / N, { width, depth, form }));
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
      const w = toothDimensions(id, scale).md, centerS = s + w / 2;
      if (ids.includes(id)) {
        const { p, tangent } = at(right ? mid - centerS : mid + centerS);
        result.push({ fdi: id, position: p, mesial: right ? tangent : [-tangent[0], -tangent[1]], distance: centerS });
      }
      s += w + gap;
    }
  }
  return result;
}

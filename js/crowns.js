// Anatomische tandkronen volgens het leerboek (Wheeler's Dental Anatomy, 9e druk): knobbels, randlijsten,
// fissuren, fossae, cingulum en incisale rand, met de gepubliceerde gemiddelde afmetingen.
//
// Port naar JavaScript van de parametrische kroonbibliotheek van DentCraft (crates/dentcraft-anatomy:
// shape.rs, library.rs, dimensions.rs), https://github.com/elnajar1/DentCraft
// Copyright (c) 2026 Dr. Mahmoud ElNajar en DentCraft-bijdragers, licentie MIT OF Apache-2.0 (naar keuze).
// Aanpassingen voor Digital Denture CAD: lagere resolutie (prothesetanden, booleaanse bewerkingen), een
// gesloten hals/wortelstift voor verankering in de basis, en het lokale assenstelsel van teeth.js.
//
// Generatieframe (zoals DentCraft): +X mesiaal, +Y faciaal, +Z occlusaal, oorsprong midden van de cervicale lijn.

const TAU = Math.PI * 2;
const softmax = (vals, k) => { let m = -Infinity; for (const v of vals) if (v > m) m = v; if (!Number.isFinite(m)) return m; let s = 0; for (const v of vals) s += Math.exp(k * (v - m)); return m + Math.log(s) / k; };
const softplus = (x, k) => k * x > 30 ? x : Math.log(1 + Math.exp(k * x)) / k;
const softabs = (x, eps) => Math.sqrt(x * x + eps * eps) - eps;
const wrapAngle = x => { let r = ((x + Math.PI) % TAU + TAU) % TAU - Math.PI; return r > Math.PI - 1e-12 ? -Math.PI : r; };
const sideWeights = t => { const c = Math.cos(t), s = Math.sin(t); return [Math.max(c, 0) ** 2, Math.max(-c, 0) ** 2, Math.max(s, 0) ** 2, Math.max(-s, 0) ** 2]; };

// ---------- afmetingen (Wheeler's, gemiddelden in mm) ----------
// kroonlengte, MD, MD cervicaal, BL, BL cervicaal, CEJ-kromming mesiaal, distaal
const UPPER = [[10.5, 8.5, 7.0, 7.0, 6.0, 3.5, 2.5], [9.0, 6.5, 5.0, 6.0, 5.0, 3.0, 2.0], [10.0, 7.5, 5.5, 8.0, 7.0, 2.5, 1.5], [8.5, 7.0, 5.0, 9.0, 8.0, 1.0, 0.0], [8.5, 7.0, 5.0, 9.0, 8.0, 1.0, 0.0], [7.5, 10.0, 8.0, 11.0, 10.0, 1.0, 0.0], [7.0, 9.0, 7.0, 11.0, 10.0, 1.0, 0.0], [6.5, 8.5, 6.5, 10.0, 9.5, 1.0, 0.0]];
const LOWER = [[9.0, 5.0, 3.5, 6.0, 5.3, 3.0, 2.0], [9.5, 5.5, 4.0, 6.5, 5.8, 3.0, 2.0], [11.0, 7.0, 5.5, 7.5, 7.0, 2.5, 1.0], [8.5, 7.0, 5.0, 7.5, 6.5, 1.0, 0.0], [8.0, 7.0, 5.0, 8.0, 7.0, 1.0, 0.0], [7.5, 11.0, 9.0, 10.5, 9.0, 1.0, 0.0], [7.0, 10.5, 8.0, 10.0, 9.0, 1.0, 0.0], [7.0, 10.0, 7.5, 9.5, 9.0, 1.0, 0.0]];
export function crownDimensions(fdi) {
  const q = Math.floor(fdi / 10), r = (q === 1 || q === 2 ? UPPER : LOWER)[fdi % 10 - 1];
  return { length: r[0], md: r[1], mdCervix: r[2], bl: r[3], blCervix: r[4], cejMesial: r[5], cejDistal: r[6] };
}

// ---------- omtrekken ----------
function outlinePolyline(o, tx, ty, samples = 1024) {
  const pts = [];
  for (let k = 0; k < samples; k++) {
    const t = TAU * k / samples, c = Math.cos(t), s = Math.sin(t), n = s >= 0 ? o.n_f : o.n_l, a = c >= 0 ? o.a_m : o.a_d, b = s >= 0 ? o.b_f : o.b_l;
    pts.push([a * Math.sign(c) * Math.abs(c) ** (2 / n), b * Math.sign(s) * Math.abs(s) ** (2 / n)]);
  }
  const shaped = pts.map(([x, y]) => {
    const eta = Math.min(1, Math.max(0, (y + o.b_l) / (o.b_f + o.b_l))), xi = Math.min(1, Math.max(0, (x + o.a_d) / (o.a_m + o.a_d)));
    return [x * (1 - o.taper_x * (1 - eta)) + o.shear * (1 - eta), y * (1 - o.taper_y * (1 - xi))];
  });
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of shaped) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const sx = tx / (x1 - x0), sy = ty / (y1 - y0);
  return shaped.map(([x, y]) => [x * sx, y * sy]);
}
class Outline {
  constructor(o, tx, ty) {
    const pts = outlinePolyline(o, tx, ty);
    this.angles = pts.map(([x, y]) => ((Math.atan2(y, x) % TAU) + TAU) % TAU);
    this.radii = pts.map(([x, y]) => Math.hypot(x, y));
  }
  radial(theta) {
    const t = ((theta % TAU) + TAU) % TAU, A = this.angles, R = this.radii, n = A.length;
    if (t < A[0]) { const a0 = A[n - 1], span = TAU - a0 + A[0]; return R[n - 1] + (R[0] - R[n - 1]) * ((t + TAU - a0) / span); }
    let lo = 0, hi = n; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (A[m] <= t) lo = m; else hi = m; }
    if (lo + 1 === n) return R[lo];
    return R[lo] + (R[lo + 1] - R[lo]) * Math.min(1, Math.max(0, (t - A[lo]) / (A[lo + 1] - A[lo])));
  }
}

// ---------- hoogtevelden ----------
const LSE_K = 4.5, CONE_EXP = 1.6, OCCLUSAL_SPREAD = 1.28, CUSP_DROP = 3.6;
const relief = (fossaZ, span, zf, ctx) => fossaZ + ctx.cusp * (1 - 0.45 * ctx.wear) * (zf * span - fossaZ);
function segT(a, b, x, y, ctx) {
  const A = [a[0] * ctx.hmd, a[1] * ctx.hbl], B = [b[0] * ctx.hmd, b[1] * ctx.hbl], ab = [B[0] - A[0], B[1] - A[1]], l2 = ab[0] ** 2 + ab[1] ** 2;
  if (l2 < 1e-12) return null;
  const t = Math.min(1, Math.max(0, ((x - A[0]) * ab[0] + (y - A[1]) * ab[1]) / l2));
  return { t, dist: Math.hypot(x - A[0] - t * ab[0], y - A[1] - t * ab[1]) };
}
function ridgeHeight(r, x, y, ctx, fossaZ) {
  const s = segT(r.a, r.b, x, y, ctx); if (!s) return -Infinity;
  const za = relief(fossaZ, ctx.height, r.za, ctx), zb = relief(fossaZ, ctx.height, r.zb, ctx), bump = r.bump * ctx.cusp * (1 - 0.45 * ctx.wear);
  return za + (zb - za) * s.t + bump * (0.35 + 0.65 * 4 * s.t * (1 - s.t)) - 1.2 * Math.max(0, s.dist - r.sigma) ** 2;
}
function grooveDepth(g, x, y, ctx) { const s = segT(g.a, g.b, x, y, ctx); if (!s) return 0; return g.depth * (1 - 0.5 * ctx.wear) * Math.exp(-((s.dist / g.sigma) ** 2)) * Math.sin(Math.PI * s.t); }
function blobHeight(b, x, y, ctx) { const scale = b.h >= 0 ? ctx.cusp * (1 - 0.45 * ctx.wear) : 1 - 0.5 * ctx.wear, dx = (x - b.at[0] * ctx.hmd) / b.sx, dy = (y - b.at[1] * ctx.hbl) / b.sy; return b.h * scale * Math.exp(-(dx * dx + dy * dy)); }
function fieldHeight(f, x, y, ctx) {
  if (f.type === 'post') {
    y = ctx.pole[1] + (y - ctx.pole[1]) / OCCLUSAL_SPREAD;
    const fossaZ = f.fossa * ctx.height, hs = [];
    for (const c of f.cusps) {
      const tip = [c.fx * ctx.hmd, c.fy * ctx.hbl], ztip = relief(fossaZ, ctx.height, c.z, ctx);
      let du = ctx.pole[0] - tip[0], dv = ctx.pole[1] - tip[1]; const dl = Math.hypot(du, dv);
      if (dl < 1e-9) { du = 0; dv = 1; } else { du /= dl; dv /= dl; }
      const rx = x - tip[0], ry = y - tip[1], u = rx * du + ry * dv, v = -rx * dv + ry * du;
      const d = ((Math.abs(u) / c.a) ** CONE_EXP + (Math.abs(v) / c.b) ** CONE_EXP) ** (1 / CONE_EXP);
      const round = 0.45 * (1 + 2 * ctx.wear), slope = CUSP_DROP * c.slope * (1 - 0.4 * ctx.wear);
      hs.push(ztip - slope * (Math.sqrt(d * d + round * round) - round));
    }
    for (const r of f.ridges) hs.push(ridgeHeight(r, x, y, ctx, fossaZ));
    hs.push(fossaZ + 0.06 * ctx.height);
    let z = softmax(hs, LSE_K);
    for (const g of f.grooves) z -= grooveDepth(g, x, y, ctx);
    for (const b of f.blobs) z += blobHeight(b, x, y, ctx);
    return z;
  }
  const fossaZ = f.fossa * ctx.height, crestY = f.crest.y0 - f.crest.c * x * x, top = relief(fossaZ, ctx.height, 1, ctx);
  const dx = x - f.crest.tip, eps = 0.35 * (1 + 2 * ctx.wear), slope = (dx >= 0 ? f.crest.sm : f.crest.sd) * ctx.cusp * (1 - 0.45 * ctx.wear);
  const crest = top - slope * softabs(dx, eps), s = y - crestY;
  const lingual = q => f.drop[0] * (1 - Math.exp(-(q / f.drop[1]))) + f.drop[2] * q;
  const K = 4, s0 = Math.LN2 / K;
  const drop = lingual(softplus(s, K)) + f.labial * softplus(-s, K) - lingual(s0) - f.labial * s0;
  let z = crest - drop, rz = -Infinity;
  for (const r of f.ridges) rz = Math.max(rz, ridgeHeight(r, x, y, ctx, fossaZ));
  if (Number.isFinite(rz)) z = Math.max(z, rz - 2 * softabs(s - 1.2, 1));
  for (const b of f.blobs) z += blobHeight(b, x, y, ctx);
  return z;
}

// ---------- specificaties per tand (rechterkant; 2 en 4 worden gespiegeld) ----------
const O = (n_f, n_l, taper_x, taper_y, shear) => ({ a_m: 1, a_d: 1, b_f: 1, b_l: 1, n_f, n_l, taper_x, taper_y, shear });
const cusp = (name, fx, fy, z, a, b, slope) => ({ name, fx, fy, z, a, b, slope });
const ridge = (a, b, bump, sigma) => ({ a: [a[0], a[1]], b: [b[0], b[1]], za: a[2], zb: b[2], bump, sigma });
const groove = (ax, ay, bx, by, depth, sigma) => ({ a: [ax, ay], b: [bx, by], depth, sigma });
const blob = (at, h, sx, sy) => ({ at, h, sx, sy });
const dep = (theta, sigma, depth) => ({ theta, sigma, depth });
const ant = (crest, fossa, drop, labial, ridges, blobs) => ({ type: 'ant', crest, fossa, drop, labial, ridges, blobs });
const post = (fossa, cusps, ridges, grooves, blobs) => ({ type: 'post', fossa, cusps, ridges, grooves, blobs });
const T = (outline, z_hoc, kappa, cejL, pole, shoulder, deps, field) => ({ outline, z_hoc, kappa, cejL, pole, shoulder, deps, field });

const SPEC = {
  u1: T(O(3.2, 2.2, 0.08, 0.02, 0), [0.68, 0.60, 0.24, 0.26], [0.72, 0.66, 0.18, 0.50], -1.35, [0.05, -0.17], [2.3, 1.4], [dep(1.121, 0.16, 0.07), dep(2.020, 0.16, 0.07)],
    ant({ y0: 0.6, c: 0.035, tip: 0, sm: 0.012, sd: 0.06 }, 0.24, [5.0, 1.8, 0.4], 0.9, [ridge([0.50, -0.30, 0.42], [0.71, 0.10, 0.90], 0.30, 0.55), ridge([-0.44, -0.28, 0.42], [-0.65, 0.10, 0.88], 0.28, 0.55)], [blob([0, -0.15], -0.25, 1.3, 0.8), blob([0, -0.36], 0.55, 1.3, 0.75)])),
  u2: T(O(2.6, 2.2, 0.10, 0.02, 0), [0.65, 0.55, 0.24, 0.25], [0.70, 0.62, 0.18, 0.48], -1.15, [0.05, -0.18], [2.3, 1.4], [dep(1.071, 0.15, 0.06), dep(2.071, 0.15, 0.06)],
    ant({ y0: 0.45, c: 0.045, tip: 0.1, sm: 0.04, sd: 0.07 }, 0.24, [4.4, 1.6, 0.4], 0.9, [ridge([0.52, -0.33, 0.40], [0.70, 0.08, 0.88], 0.26, 0.50), ridge([-0.46, -0.30, 0.40], [-0.63, 0.08, 0.86], 0.24, 0.50)], [blob([0.02, -0.15], -0.22, 1.0, 0.7), blob([0, -0.35], 0.45, 1.1, 0.7)])),
  u3: T(O(2.45, 2.2, 0.10, 0.02, 0), [0.55, 0.46, 0.28, 0.27], [0.62, 0.55, 0.22, 0.46], -0.9, [0.09, -0.15], [2.2, 1.35], [dep(1.021, 0.15, 0.10), dep(2.121, 0.15, 0.10)],
    ant({ y0: 0.7, c: 0.03, tip: 0.35, sm: 0.60, sd: 0.45 }, 0.26, [4.6, 1.7, 0.5], 0.85, [ridge([0.09, -0.25, 0.42], [0.09, 0.15, 0.93], 0.40, 0.45)], [blob([0.08, -0.33], 0.6, 1.3, 0.8), blob([0.37, -0.10], -0.28, 0.8, 0.7), blob([-0.35, -0.09], -0.25, 0.8, 0.7)])),
  u4: T(O(2.35, 2.15, 0.14, 0.03, 0.35), [0.65, 0.62, 0.24, 0.45], [0.62, 0.58, 0.74, 0.74], -0.25, [0.02, -0.01], [2.4, 1.6], [],
    post(0.50, [cusp('buccal', 0.08, 0.42, 1.00, 2.2, 1.55, 0.55), cusp('lingual', -0.04, -0.44, 0.80, 2.0, 1.45, 0.50)], [ridge([0.44, 0.16, 0.86], [0.36, -0.14, 0.72], 0.22, 0.50), ridge([-0.44, 0.16, 0.80], [-0.44, -0.14, 0.68], 0.20, 0.50)], [groove(0.60, 0, -0.55, 0, 0.45, 0.40)], [blob([0.42, 0.01], -0.12, 0.6, 0.5), blob([-0.45, 0.01], -0.12, 0.6, 0.5)])),
  u5: T(O(2.35, 2.1, 0.12, 0.03, 0.25), [0.65, 0.62, 0.24, 0.45], [0.62, 0.58, 0.74, 0.74], -0.25, [0, -0.01], [2.4, 1.6], [],
    post(0.52, [cusp('buccal', 0.05, 0.42, 1.00, 2.1, 1.50, 0.50), cusp('lingual', 0, -0.44, 0.86, 2.0, 1.45, 0.45)], [ridge([0.44, 0.15, 0.86], [0.38, -0.13, 0.76], 0.20, 0.50), ridge([-0.44, 0.14, 0.80], [-0.42, -0.13, 0.72], 0.18, 0.50)], [groove(0.55, 0, -0.50, 0, 0.42, 0.40)], [blob([0.40, 0], -0.10, 0.55, 0.5), blob([-0.42, 0], -0.10, 0.55, 0.5)])),
  u6: T(O(3.0, 2.9, 0.16, 0.06, -0.35), [0.62, 0.58, 0.22, 0.46], [0.60, 0.55, 0.74, 0.74], -0.25, [0, -0.02], [2.5, 1.7], [dep(1.40, 0.10, 0.22)],
    post(0.56, [cusp('mesiobuccal', 0.42, 0.36, 0.96, 2.5, 1.8, 0.52), cusp('distobuccal', -0.30, 0.42, 0.93, 2.3, 1.7, 0.52), cusp('mesiolingual', 0.44, -0.48, 1.00, 2.9, 1.9, 0.48), cusp('distolingual', -0.48, -0.40, 0.85, 2.3, 1.7, 0.55)],
      [ridge([0.44, -0.48, 0.96], [-0.30, 0.42, 0.86], 0.40, 0.70), ridge([0.80, 0.34, 0.88], [0.80, -0.46, 0.92], 0.15, 0.75), ridge([-0.80, 0.38, 0.80], [-0.80, -0.42, 0.74], 0.12, 0.75)],
      [groove(0.40, 0.02, 0.12, 0.04, 0.42, 0.42), groove(0.12, 0.04, -0.05, 0.62, 0.40, 0.38), groove(-0.10, 0.05, -0.42, 0.06, 0.40, 0.42)], [blob([0.42, 0.02], -0.18, 0.6, 0.5), blob([0.02, 0.04], -0.20, 0.65, 0.55), blob([-0.44, 0.06], -0.15, 0.5, 0.5)])),
  u7: T(O(3.0, 2.85, 0.19, 0.06, -0.40), [0.62, 0.57, 0.22, 0.46], [0.58, 0.54, 0.74, 0.74], -0.25, [-0.02, -0.02], [2.5, 1.7], [dep(1.53, 0.10, 0.24)],
    post(0.56, [cusp('mesiobuccal', 0.40, 0.40, 0.94, 2.4, 1.7, 0.55), cusp('distobuccal', -0.38, 0.42, 0.86, 2.2, 1.6, 0.55), cusp('mesiolingual', 0.42, -0.48, 1.00, 2.7, 1.8, 0.50), cusp('distolingual', -0.44, -0.42, 0.74, 2.1, 1.6, 0.55)],
      [ridge([0.42, -0.48, 0.95], [-0.38, 0.42, 0.80], 0.42, 0.70), ridge([0.80, 0.36, 0.86], [0.80, -0.46, 0.90], 0.15, 0.75), ridge([-0.80, 0.38, 0.76], [-0.80, -0.42, 0.68], 0.12, 0.75)],
      [groove(0.38, 0.02, 0.10, 0.03, 0.42, 0.42), groove(0.10, 0.03, 0, 0.62, 0.42, 0.40), groove(-0.12, 0.04, -0.40, 0.05, 0.40, 0.42)], [blob([0.40, 0.02], -0.16, 0.6, 0.5), blob([0, 0.03], -0.18, 0.65, 0.55), blob([-0.42, 0.05], -0.16, 0.5, 0.5)])),
  u8: T(O(2.9, 2.75, 0.22, 0.07, -0.45), [0.60, 0.56, 0.22, 0.44], [0.56, 0.52, 0.74, 0.74], -0.25, [0, -0.02], [2.5, 1.7], [dep(1.571, 0.10, 0.20)],
    post(0.55, [cusp('mesiobuccal', 0.38, 0.40, 0.93, 2.2, 1.6, 0.60), cusp('distobuccal', -0.35, 0.40, 0.83, 2.0, 1.5, 0.60), cusp('mesiolingual', 0.40, -0.46, 1.00, 2.5, 1.7, 0.55), cusp('distolingual', -0.40, -0.42, 0.68, 1.9, 1.4, 0.48)],
      [ridge([0.40, -0.46, 0.94], [-0.35, 0.40, 0.78], 0.35, 0.70), ridge([0.80, 0.36, 0.84], [0.80, -0.44, 0.88], 0.14, 0.75), ridge([-0.80, 0.36, 0.74], [-0.80, -0.40, 0.64], 0.10, 0.75)],
      [groove(0.35, 0, -0.35, 0, 0.40, 0.45), groove(0, 0.03, 0, 0.60, 0.38, 0.40)], [blob([0, 0.02], -0.18, 0.6, 0.55)])),
  l1: T(O(2.5, 2.3, 0.06, 0.02, 0), [0.60, 0.50, 0.22, 0.24], [0.70, 0.62, 0.20, 0.46], -1.15, [0, -0.15], [2.3, 1.4], [dep(1.171, 0.16, 0.04), dep(1.971, 0.16, 0.04)],
    ant({ y0: 0.35, c: 0.04, tip: 0, sm: 0.05, sd: 0.07 }, 0.22, [3.4, 1.5, 0.4], 0.95, [ridge([0.56, -0.33, 0.42], [0.70, 0.10, 0.88], 0.20, 0.45), ridge([-0.52, -0.30, 0.42], [-0.64, 0.10, 0.86], 0.20, 0.45)], [blob([0, -0.13], -0.15, 0.8, 0.6), blob([0, -0.33], 0.25, 0.9, 0.6)])),
  l2: T(O(2.5, 2.3, 0.06, 0.02, 0), [0.62, 0.52, 0.22, 0.24], [0.70, 0.62, 0.20, 0.46], -1.15, [0, -0.15], [2.3, 1.4], [dep(1.171, 0.16, 0.04), dep(1.971, 0.16, 0.04)],
    ant({ y0: 0.40, c: 0.04, tip: 0.05, sm: 0.05, sd: 0.06 }, 0.22, [3.6, 1.5, 0.4], 0.95, [ridge([0.55, -0.32, 0.42], [0.68, 0.10, 0.88], 0.20, 0.45), ridge([-0.50, -0.30, 0.42], [-0.62, 0.10, 0.86], 0.20, 0.45)], [blob([0.02, -0.13], -0.16, 0.85, 0.6), blob([0, -0.33], 0.30, 0.95, 0.6)])),
  l3: T(O(2.45, 2.25, 0.08, 0.02, 0), [0.52, 0.44, 0.26, 0.26], [0.62, 0.55, 0.22, 0.45], -0.9, [0.06, -0.15], [2.2, 1.35], [dep(1.071, 0.15, 0.09), dep(2.071, 0.15, 0.09)],
    ant({ y0: 0.55, c: 0.03, tip: 0.20, sm: 0.46, sd: 0.30 }, 0.25, [4.4, 1.6, 0.5], 0.85, [ridge([0.06, -0.23, 0.42], [0.06, 0.13, 0.94], 0.35, 0.45)], [blob([0.04, -0.32], 0.5, 1.2, 0.75), blob([0.37, -0.10], -0.25, 0.8, 0.7), blob([-0.34, -0.09], -0.22, 0.8, 0.7)])),
  l4: T(O(2.35, 2.15, 0.12, 0.03, 0.45), [0.66, 0.62, 0.24, 0.44], [0.62, 0.58, 0.74, 0.74], -0.25, [0.10, -0.02], [2.4, 1.6], [],
    post(0.50, [cusp('buccal', 0.06, 0.42, 1.00, 1.8, 1.30, 0.70), cusp('lingual', 0.18, -0.40, 0.66, 1.5, 1.10, 0.55)], [ridge([0.46, 0.18, 0.84], [0.28, -0.14, 0.66], 0.20, 0.50), ridge([-0.46, 0.16, 0.78], [-0.40, -0.12, 0.62], 0.16, 0.50)], [groove(0.50, 0.02, -0.40, 0, 0.45, 0.40)], [blob([0.40, 0], -0.12, 0.55, 0.5), blob([-0.44, 0.01], -0.12, 0.55, 0.5)])),
  l5: T(O(2.35, 2.1, 0.13, 0.03, 0.20), [0.65, 0.62, 0.24, 0.45], [0.62, 0.58, 0.74, 0.74], -0.25, [0.02, -0.04], [2.4, 1.6], [dep(4.71, 0.09, 0.12)],
    post(0.52, [cusp('buccal', 0.04, 0.42, 1.00, 2.2, 1.5, 0.55), cusp('mesiolingual', 0.32, -0.40, 0.84, 1.9, 1.35, 0.50), cusp('distolingual', -0.33, -0.36, 0.78, 1.8, 1.3, 0.50)], [ridge([0.44, 0.16, 0.86], [0.28, -0.16, 0.74], 0.22, 0.50), ridge([-0.44, 0.14, 0.80], [-0.36, -0.15, 0.70], 0.18, 0.50)], [groove(0.45, 0.04, -0.35, 0.02, 0.45, 0.40), groove(0.03, 0.03, 0, -0.62, 0.40, 0.38)], [blob([0, 0.02], -0.15, 0.6, 0.5)])),
  l6: T(O(2.35, 2.1, 0.34, 0.07, 0.22), [0.62, 0.58, 0.22, 0.50], [0.62, 0.56, 0.74, 0.74], -0.25, [0, -0.05], [2.5, 1.7], [dep(1.75, 0.10, 0.22), dep(4.75, 0.09, 0.15)],
    post(0.55, [cusp('mesiobuccal', 0.56, 0.44, 0.90, 2.5, 1.75, 0.55), cusp('distobuccal', -0.07, 0.48, 0.85, 2.3, 1.7, 0.55), cusp('distal', -0.65, 0.29, 0.78, 2.0, 1.5, 0.60), cusp('mesiolingual', 0.49, -0.55, 1.00, 2.8, 1.85, 0.50), cusp('distolingual', -0.36, -0.55, 0.93, 2.4, 1.7, 0.55)],
      [ridge([0.56, 0.44, 0.82], [0.49, -0.55, 0.89], 0.28, 0.55), ridge([-0.65, 0.29, 0.74], [-0.36, -0.55, 0.87], 0.26, 0.50)],
      [groove(0.50, 0.03, 0, 0, 0.45, 0.42), groove(0, 0, -0.48, 0.04, 0.45, 0.42), groove(0, 0.05, -0.10, 0.66, 0.40, 0.40), groove(0, -0.05, 0.05, -0.68, 0.38, 0.38)], [blob([0.42, 0.02], -0.20, 0.6, 0.5), blob([0, 0], -0.22, 0.6, 0.55), blob([-0.42, 0.05], -0.18, 0.5, 0.5)])),
  l7: T(O(2.35, 2.1, 0.33, 0.06, 0.20), [0.62, 0.58, 0.22, 0.50], [0.60, 0.56, 0.74, 0.74], -0.25, [0, 0], [2.5, 1.7], [dep(1.571, 0.10, 0.24), dep(4.712, 0.09, 0.15)],
    post(0.56, [cusp('mesiobuccal', 0.42, 0.45, 0.90, 2.4, 1.7, 0.55), cusp('distobuccal', -0.42, 0.45, 0.84, 2.2, 1.6, 0.55), cusp('mesiolingual', 0.44, -0.50, 1.00, 2.6, 1.75, 0.50), cusp('distolingual', -0.44, -0.50, 0.92, 2.3, 1.6, 0.55)],
      [ridge([0.42, 0.45, 0.86], [0.44, -0.50, 0.93], 0.30, 0.55), ridge([-0.42, 0.45, 0.80], [-0.44, -0.50, 0.86], 0.26, 0.50)], [groove(0.50, 0, -0.50, 0, 0.45, 0.45), groove(0, 0.04, 0, 0.65, 0.42, 0.40), groove(0, -0.04, 0, -0.65, 0.40, 0.40)], [blob([0, 0], -0.22, 0.7, 0.55)])),
  l8: T(O(2.15, 2.0, 0.33, 0.07, 0.18), [0.60, 0.56, 0.22, 0.48], [0.58, 0.54, 0.74, 0.74], -0.25, [0, -0.02], [2.5, 1.7], [dep(1.571, 0.10, 0.20)],
    post(0.55, [cusp('mesiobuccal', 0.40, 0.42, 0.92, 2.2, 1.6, 0.60), cusp('distobuccal', -0.38, 0.42, 0.84, 2.0, 1.5, 0.60), cusp('mesiolingual', 0.42, -0.48, 1.00, 2.4, 1.65, 0.55), cusp('distolingual', -0.42, -0.46, 0.88, 2.1, 1.5, 0.55)],
      [ridge([0.40, 0.42, 0.86], [0.42, -0.48, 0.92], 0.26, 0.55)], [groove(0.40, 0, -0.40, 0, 0.40, 0.45), groove(0, 0.03, 0, 0.60, 0.38, 0.40)], [blob([0, 0], -0.18, 0.6, 0.55)])),
};

// ---------- opbouw van het kroonoppervlak (raster: kolommen rond, rijen van cervicaal naar occlusaal + poolwaaier) ----------
function arcResample(poly, n) {
  const cum = [0]; for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1], poly[i][2] - poly[i - 1][2]));
  const total = cum.at(-1); if (total <= 1e-12) return Array(n).fill(poly[0]);
  const out = []; let seg = 1;
  for (let k = 0; k < n; k++) {
    const s = total * k / (n - 1); while (seg + 1 < poly.length && cum[seg] < s) seg++;
    const span = cum[seg] - cum[seg - 1], t = span > 1e-12 ? Math.min(1, Math.max(0, (s - cum[seg - 1]) / span)) : 0;
    out.push([0, 1, 2].map(c => poly[seg - 1][c] + (poly[seg][c] - poly[seg - 1][c]) * t));
  }
  return out;
}
const polyLen = p => { let l = 0; for (let i = 1; i < p.length; i++) l += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1], p[i][2] - p[i - 1][2]); return l; };
const guarded = (d, zh, m) => zh + m + softplus(d - zh - m, 8);

function buildSurface({ columns: n, rows, wallWeight, md, bl, height, cmd, cbl, tun, field, wear, cusp }) {
  const ctx = { hmd: md / 2, hbl: bl / 2, height, pole: [tun.pole[0] * md / 2, tun.pole[1] * bl / 2], wear, cusp };
  const o = tun.outline;
  const cervixO = { a_m: cmd / 2, a_d: cmd / 2, b_f: cbl / 2, b_l: cbl / 2, n_f: Math.max(1.9, o.n_f - 0.35), n_l: Math.max(1.9, o.n_l - 0.3), taper_x: o.taper_x * 0.6, taper_y: o.taper_y * 0.6, shear: o.shear * 0.5 };
  const hoc = new Outline(o, md, bl), cervix = new Outline(cervixO, cmd, cbl);
  const [aSh, bSh] = tun.shoulder;
  const th = [], rOc = [], rO = [], rR = [], zCej = [], zHoc = [];
  for (let i = 0; i < n; i++) {
    const theta = Math.PI / 2 + TAU * i / n, w = sideWeights(theta), ro = hoc.radial(theta), rc = Math.min(cervix.radial(theta), 0.985 * ro);
    let rr = (w[0] * tun.kappa[0] + w[1] * tun.kappa[1] + w[2] * tun.kappa[2] + w[3] * tun.kappa[3]) * ro; rr = Math.min(0.97 * ro, Math.max(0.30 * ro, rr));
    const zh = (w[0] * tun.z_hoc[0] + w[1] * tun.z_hoc[1] + w[2] * tun.z_hoc[2] + w[3] * tun.z_hoc[3]) * height, p = tun.cejPower;
    const zc = tun.cej[0] * Math.max(0, Math.cos(theta)) ** p + tun.cej[1] * Math.max(0, -Math.cos(theta)) ** p + tun.cej[2] * Math.max(0, Math.sin(theta)) ** p + tun.cej[3] * Math.max(0, -Math.sin(theta)) ** p;
    th.push(theta); rOc.push(rc); rO.push(ro); rR.push(rr); zCej.push(zc); zHoc.push(zh);
  }
  const dRim = [], sig = [];
  for (let i = 0; i < n; i++) {
    const ct = Math.cos(th[i]), st = Math.sin(th[i]), rx = ct * rR[i], ry = st * rR[i];
    const dr = guarded(fieldHeight(field, rx, ry, ctx), zHoc[i], 0.4); dRim.push(dr);
    let ux = ctx.pole[0] - rx, uy = ctx.pole[1] - ry; const ul = Math.max(1e-9, Math.hypot(ux, uy)); ux /= ul; uy /= ul;
    const step = Math.min(0.4, 0.4 * ul), dIn = guarded(fieldHeight(field, rx + step * ux, ry + step * uy, ctx), zHoc[i], 0.4);
    sig.push(Math.min(3, Math.max(-3, (dIn - dr) / step)));
  }
  const WS = 24, SS = 14, TS = 22, walls = [], shoulders = [], tables = [];
  let poleZ = Infinity; const zFloor = Math.min(...zHoc);
  for (let i = 0; i < n; i++) {
    const ct = Math.cos(th[i]), st = Math.sin(th[i]), rc = rOc[i], ro = rO[i], rr = rR[i];
    const wall = []; for (let k = 0; k < WS; k++) { const t = k / (WS - 1), r = rc + Math.sin(Math.PI / 2 * t) * (ro - rc); wall.push([ct * r, st * r, zCej[i] + t * (zHoc[i] - zCej[i])]); }
    const sh = [];
    for (let k = 0; k < SS; k++) {
      const l = k / (SS - 1), r = ro + l * (rr - ro), phi = (1 - (1 - l) ** aSh) ** (1 / bSh);
      let z = zHoc[i] + phi * (dRim[i] - zHoc[i]) + sig[i] * (ro - rr) * l * l * (l - 1);
      for (const d of tun.deps) { const dth = wrapAngle(th[i] - d.theta); z -= d.depth * Math.exp(-((dth / d.sigma) ** 2)) * Math.sin(Math.PI * l) ** 2; }
      sh.push([ct * r, st * r, z]);
    }
    const rx = ct * rr, ry = st * rr, dp = Math.max(0.5, Math.hypot(ctx.pole[0] - rx, ctx.pole[1] - ry)), off = Math.min(0.85 * dp, Math.max(0.25 * dp, 0.3)), uEnd = 1 - off / dp;
    const tb = [];
    for (let k = 0; k < TS; k++) {
      const u = uEnd * k / (TS - 1), x = rx + u * (ctx.pole[0] - rx), y = ry + u * (ctx.pole[1] - ry);
      let fade = Math.min(1, Math.max(0, u / 0.45)); fade = fade * fade * (3 - 2 * fade);
      tb.push([x, y, guarded(fieldHeight(field, x, y, ctx), zHoc[i] + (zFloor - zHoc[i]) * fade, 0.4)]);
    }
    poleZ = Math.min(poleZ, tb.at(-1)[2]);
    walls.push(wall); shoulders.push(sh); tables.push(tb);
  }
  const mean = P => P.reduce((s, p) => s + polyLen(p), 0) / P.length, lw = mean(walls), ls = mean(shoulders), lt = mean(tables);
  const budget = w => Math.round(rows * w / (wallWeight * lw + ls + lt)), clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const nW = clamp(budget(wallWeight * lw), 8, 34), nS = clamp(budget(ls), 5, 18), nT = clamp(budget(lt), 8, 26), R = nW + nS + nT - 2;
  const positions = [], cervical = [];
  for (let i = 0; i < n; i++) {
    const col = [...arcResample(walls[i], nW), ...arcResample(shoulders[i], nS).slice(1), ...arcResample(tables[i], nT).slice(1)];
    cervical.push(i * R); positions.push(...col);
  }
  const pole = n * R; positions.push([ctx.pole[0], ctx.pole[1], poleZ]);
  const tris = [], v = (i, j) => (i % n) * R + j;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < R - 1; j++) { const a = v(i, j), b = v(i + 1, j), c = v(i, j + 1), d = v(i + 1, j + 1); tris.push([a, b, d], [a, d, c]); }
    tris.push([v(i, R - 1), v(i + 1, R - 1), pole]);
  }
  return { positions, tris, cervical };
}

/**
 * Anatomische kroon + hals/wortelstift als gesloten mesh, in het lokale assenstelsel van teeth.js:
 * x = mesiodistaal-as van het boogframe, y = tandas (cervicaal 0 → occlusaal +), z = buccaal/labiaal.
 * opts: scale (×), cusp (knobbelhoogte 0,3–2), wear (0–1), shape ('oval'|'square'|'tapered', alleen front), rootLength (mm), columns.
 */
export function anatomicTooth(fdi, { scale = 1, cusp = 1, wear = 0, shape = 'oval', rootLength = 4, columns = 56, rows = 34 } = {}) {
  const pos = fdi % 10, q = Math.floor(fdi / 10), upper = q === 1 || q === 2;
  const base = SPEC[(upper ? 'u' : 'l') + pos], dim = crownDimensions(fdi);
  const outline = { ...base.outline };
  if (pos <= 3) { if (shape === 'square') outline.n_f += 0.5; else if (shape === 'tapered') { outline.n_f = Math.max(2, outline.n_f - 0.5); outline.taper_x += 0.08; } }
  const tun = { outline, z_hoc: base.z_hoc, kappa: base.kappa, cej: [dim.cejMesial * scale, dim.cejDistal * scale, 0, base.cejL * scale], cejPower: 3, pole: base.pole, shoulder: base.shoulder, deps: base.deps };
  const req = c => ({ columns, rows, wallWeight: 0.75, md: dim.md * scale, bl: dim.bl * scale, height: dim.length * scale, cmd: dim.mdCervix * scale, cbl: dim.blCervix * scale, tun, field: base.field, wear: c.wear, cusp: c.cusp });
  // kalibratie: de referentiekroon meet precies de leerboek-kroonlengte
  const ref = buildSurface(req({ wear: 0, cusp: 1 })), zRef = Math.max(...ref.positions.map(p => p[2])), k = zRef > 1e-6 ? dim.length * scale / zRef : 1;
  const s = wear === 0 && cusp === 1 ? ref : buildSurface(req({ wear: Math.min(1, Math.max(0, wear)), cusp: Math.min(2, Math.max(0.3, cusp)) }));
  const P = s.positions.map(p => [p[0], p[1], p[2] * k]);
  // hals/wortelstift: cervicale lus versmallen naar beneden en afsluiten (verankering in de prothesebasis)
  const loop = s.cervical, m = loop.length, c0 = loop.reduce((a, v) => [a[0] + P[v][0] / m, a[1] + P[v][1] / m], [0, 0]);
  const zMin = Math.min(...loop.map(v => P[v][2]));
  const rings = [loop];
  for (let r = 1; r <= 3; r++) {
    const t = r / 3, f = 1 - 0.32 * t, ring = [];
    for (const v of loop) { ring.push(P.length); P.push([c0[0] + (P[v][0] - c0[0]) * f, c0[1] + (P[v][1] - c0[1]) * f, zMin - rootLength * t]); }
    rings.push(ring);
  }
  const apex = P.length; P.push([c0[0], c0[1], zMin - rootLength - 0.6]);
  const tris = s.tris.slice();
  for (let r = 0; r < rings.length - 1; r++) for (let i = 0; i < m; i++) { const a = rings[r][i], b = rings[r][(i + 1) % m], c = rings[r + 1][i], d = rings[r + 1][(i + 1) % m]; tris.push([a, c, d], [a, d, b]); }
  const last = rings.at(-1); for (let i = 0; i < m; i++) tris.push([last[i], apex, last[(i + 1) % m]]);
  // spiegelen voor kwadrant 2 en 4 (zoals DentCraft), daarna naar het lokale frame van teeth.js: (x, y, z) = (−X, Z, Y)
  const mirror = q === 2 || q === 4;
  const out = new Float32Array(tris.length * 9); let o = 0, topY = -Infinity;
  for (const t of tris) {
    const order = mirror ? [t[0], t[2], t[1]] : t;
    for (const vi of order) { const X = mirror ? -P[vi][0] : P[vi][0], Y = P[vi][1], Z = P[vi][2]; out[o++] = -X; out[o++] = Z; out[o++] = Y; if (Z > topY) topY = Z; }
  }
  // oriëntatie controleren (naar buiten gerichte normalen: positief volume)
  let vol = 0; for (let i = 0; i < out.length; i += 9) vol += out[i] * (out[i + 4] * out[i + 8] - out[i + 5] * out[i + 7]) - out[i + 1] * (out[i + 3] * out[i + 8] - out[i + 5] * out[i + 6]) + out[i + 2] * (out[i + 3] * out[i + 7] - out[i + 4] * out[i + 6]);
  if (vol < 0) for (let i = 0; i < out.length; i += 9) for (let j = 0; j < 3; j++) { const tmp = out[i + 3 + j]; out[i + 3 + j] = out[i + 6 + j]; out[i + 6 + j] = tmp; }
  return { soup: out, md: dim.md * scale, bl: dim.bl * scale, height: dim.length * scale, cervicalY: 0, occlusalY: topY };
}

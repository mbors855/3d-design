// Rij-logica voor de tandopstelling: boog als polylijn in het boogvlak, elementen langs de boog schuiven,
// aansluiten (approximale contacten) en herschikken terwijl er één element of een groep wordt versleept.
// Werkt op three.js-objecten (elementen) in wereldcoördinaten van hun groep; frame = { O, X, Y, N }.
import * as THREE from 'three';

const _v = new THREE.Vector3(), _q = new THREE.Quaternion();

export class ArchRow {
  // curve: t ∈ [-1, 1] → [x, y] in het frame (x = patiënt-links, y = anterior); t = 0 = middellijn
  constructor(frame, curve, samples = 600) {
    this.frame = frame;
    this.pts = []; this.cum = [0];
    for (let i = 0; i <= samples; i++) this.pts.push(curve(-1 + 2 * i / samples));
    for (let i = 1; i <= samples; i++) this.cum.push(this.cum[i - 1] + Math.hypot(this.pts[i][0] - this.pts[i - 1][0], this.pts[i][1] - this.pts[i - 1][1]));
    this.mid = this.cum[samples / 2];
    this.length = this.cum[samples];
  }
  // booglengte (0 = middellijn) → punt, raaklijn (richting van t = -1 naar t = +1) en buitenwaartse normaal
  at(s) {
    const c = this.cum, n = c.length - 1, a = Math.max(0, Math.min(c[n], s + this.mid));
    let lo = 1, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (c[m] < a) lo = m + 1; else hi = m; }
    const i = Math.max(1, lo), t = (a - c[i - 1]) / ((c[i] - c[i - 1]) || 1), A = this.pts[i - 1], B = this.pts[i];
    let tx = B[0] - A[0], ty = B[1] - A[1]; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
    // extrapolatie voorbij de uiteinden (langs de laatste raaklijn)
    const over = s + this.mid - a;
    const p = [A[0] + t * (B[0] - A[0]) + tx * over, A[1] + t * (B[1] - A[1]) + ty * over];
    // buitenwaarts = weg van het boogcentrum (achter het midden)
    let nx = ty, ny = -tx;
    const cy = this.pts[n >> 1][1] - 30;
    if ((p[0]) * nx + (p[1] - cy) * ny < 0) { nx = -nx; ny = -ny; }
    return { p, t: [tx, ty], n: [nx, ny] };
  }
  // 2D-punt → { s, d } (d = afstand buitenwaarts van de boog)
  project(x, y) {
    let best = Infinity, bi = 1, bt = 0;
    for (let i = 1; i < this.pts.length; i++) {
      const A = this.pts[i - 1], B = this.pts[i], dx = B[0] - A[0], dy = B[1] - A[1], L = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - A[0]) * dx + (y - A[1]) * dy) / L));
      const d = (A[0] + t * dx - x) ** 2 + (A[1] + t * dy - y) ** 2;
      if (d < best) { best = d; bi = i; bt = t; }
    }
    const s = this.cum[bi - 1] + bt * (this.cum[bi] - this.cum[bi - 1]) - this.mid;
    const f = this.at(s);
    return { s, d: (x - f.p[0]) * f.n[0] + (y - f.p[1]) * f.n[1] };
  }
  to2D(w) { const f = this.frame, d = [w[0] - f.O[0], w[1] - f.O[1], w[2] - f.O[2]]; return [d[0] * f.X[0] + d[1] * f.X[1] + d[2] * f.X[2], d[0] * f.Y[0] + d[1] * f.Y[1] + d[2] * f.Y[2], d[0] * f.N[0] + d[1] * f.N[1] + d[2] * f.N[2]]; }
  to3D(x, y, h) { const f = this.frame; return [0, 1, 2].map(i => f.O[i] + f.X[i] * x + f.Y[i] * y + f.N[i] * h); }
  angleOf(t) { return Math.atan2(t[1], t[0]); }
}

// Positie van een element in de rij (gebruikt de oorsprong = halsmidden).
export function rowState(row, obj) {
  const [x, y, h] = row.to2D(obj.position.toArray());
  return { ...row.project(x, y), h };
}

// Lokale steekproef van kroonpunten (boven 30 % van de hoogte) voor extenties langs de boog.
function samplePoints(obj) {
  const g = obj.geometry;
  if (g.userData.crownSample && g.userData.crownSampleVersion === g.userData.version) return g.userData.crownSample;
  const pos = g.getAttribute('position'), h = obj.userData.dims?.height ?? 8, out = [];
  const stride = Math.max(1, Math.floor(pos.count / 1500));
  for (let i = 0; i < pos.count; i += stride) if (pos.getY(i) > h * 0.3) out.push(pos.getX(i), pos.getY(i), pos.getZ(i));
  g.userData.crownSample = Float32Array.from(out); g.userData.crownSampleVersion = g.userData.version;
  return g.userData.crownSample;
}

// Mesiale/distale uitbreiding van de kroon langs de boog, t.o.v. de oorsprong (in mm booglengte).
export function extents(row, obj) {
  obj.updateMatrixWorld();
  const st = rowState(row, obj), f = row.at(st.s), T = row.frame, smp = samplePoints(obj);
  const t3 = [0, 1, 2].map(i => T.X[i] * f.t[0] + T.Y[i] * f.t[1]);
  const o = obj.position; let lo = Infinity, hi = -Infinity;
  const m = obj.matrix; // positie/rotatie/schaal t.o.v. de groep
  for (let i = 0; i < smp.length; i += 3) {
    _v.set(smp[i], smp[i + 1], smp[i + 2]).applyMatrix4(m);
    const d = (_v.x - o.x) * t3[0] + (_v.y - o.y) * t3[1] + (_v.z - o.z) * t3[2];
    if (d < lo) lo = d; if (d > hi) hi = d;
  }
  return { s: st.s, lo, hi, d: st.d, h: st.h };
}

// Element langs de boog naar booglengte s verplaatsen; afstand tot de boog (d) en hoogte blijven,
// de rotatie om de occlusale as volgt de raaklijn.
export function moveAlong(row, obj, s, d = null) {
  const st = rowState(row, obj), f0 = row.at(st.s), f1 = row.at(s), dd = d ?? st.d;
  const p = row.to3D(f1.p[0] + f1.n[0] * dd, f1.p[1] + f1.n[1] * dd, st.h);
  const da = row.angleOf(f1.t) - row.angleOf(f0.t);
  if (Math.abs(da) > 1e-9) { _q.setFromAxisAngle(_v.set(...row.frame.N), da); obj.quaternion.premultiply(_q); }
  obj.position.set(...p); obj.updateMatrix(); obj.updateMatrixWorld();
}

// Rij-indeling (aansluiten). items: objecten van één kaak. fixed: Set van objecten die blijven staan.
// float: object dat de gebruiker vasthoudt — het krijgt een plek in de volgorde, maar wordt niet verplaatst.
// Zonder fixed: contact tussen de twee middelste elementen ligt op de middellijn (s = midShift).
// Geeft per object de doel-s terug.
export function packRow(row, items, { fixed = new Set(), float = null, gap = 0, midShift = 0 } = {}) {
  const info = items.map(o => ({ o, ...extents(row, o) }));
  info.sort((a, b) => a.s - b.s);
  const target = new Map(), n = info.length;
  if (!n) return target;
  const fixedIdx = info.map((x, i) => fixed.has(x.o) ? i : -1).filter(i => i >= 0);
  let s;
  if (fixedIdx.length) {
    const a = Math.min(...fixedIdx), b = Math.max(...fixedIdx);
    for (let i = a; i <= b; i++) target.set(info[i].o, info[i].s);
    s = info[a].s + info[a].lo; for (let i = a - 1; i >= 0; i--) { const c = s - gap - info[i].hi; target.set(info[i].o, c); s = c + info[i].lo; }
    s = info[b].s + info[b].hi; for (let i = b + 1; i < n; i++) { const c = s + gap - info[i].lo; target.set(info[i].o, c); s = c + info[i].hi; }
  } else {
    // splitsing: eerste element met s ≥ midShift (rechts van de middellijn in booglengte)
    let k = info.findIndex(x => x.s >= midShift); if (k < 0) k = n;
    // als alle elementen aan één kant staan, sluit aan op de middellijn
    s = midShift + gap / 2; for (let i = k; i < n; i++) { const c = s - info[i].lo; target.set(info[i].o, c); s = c + info[i].hi + gap; }
    s = midShift - gap / 2; for (let i = k - 1; i >= 0; i--) { const c = s - info[i].hi; target.set(info[i].o, c); s = c + info[i].lo - gap; }
  }
  for (const [o, ts] of target) if (o !== float && !fixed.has(o)) moveAlong(row, o, ts);
  // Nameting per contact (de boog is gebogen; extenties langs één raaklijn zijn een benadering):
  // de werkelijke spleet tussen buren meten in de richting van hun middens en bijschuiven, vanaf het anker naar buiten.
  // het vastgehouden element doet niet mee aan de nameting; over zijn plek heen wordt zijn breedte als ruimte aangehouden
  const fi = float ? info.findIndex(x => x.o === float) : -1, fw = fi >= 0 ? info[fi].hi - info[fi].lo + 2 * gap : 0;
  const seq = info.filter(x => x.o !== float).map(x => x.o), m = seq.length;
  const across = i => fi >= 0 && info.findIndex(x => x.o === seq[i]) < fi && info.findIndex(x => x.o === seq[i + 1]) > fi; // tussen seq[i] en seq[i+1]
  const want = i => gap + (across(i) ? fw : 0);
  const movable = o => !fixed.has(o);
  const shift = (o, ds) => { if (movable(o) && Math.abs(ds) > 1e-4) moveAlong(row, o, rowState(row, o).s + ds); };
  const seqFixed = seq.map((o, i) => fixed.has(o) ? i : -1).filter(i => i >= 0);
  for (let it = 0; it < 3 && m > 1; it++) {
    let a, b;
    if (seqFixed.length) { a = Math.min(...seqFixed); b = Math.max(...seqFixed); }
    else {
      const sNow = seq.map(o => rowState(row, o).s);
      let k = sNow.findIndex(v => v >= midShift); if (k < 0) k = m;
      if (k > 0 && k < m) { const g = gapBetween(row, seq[k - 1], seq[k]) - want(k - 1); shift(seq[k - 1], g / 2); shift(seq[k], -g / 2); }
      a = k - 1; b = k;
    }
    for (let i = b + 1; i < m; i++) { const g = gapBetween(row, seq[i - 1], seq[i]) - want(i - 1); for (let j = i; j < m; j++) shift(seq[j], -g); }
    for (let i = a - 1; i >= 0; i--) { const g = gapBetween(row, seq[i], seq[i + 1]) - want(i); for (let j = i; j >= 0; j--) shift(seq[j], g); }
  }
  return target;
}

// Werkelijke spleet tussen twee buren (negatief = overlap), gemeten langs de lijn tussen hun middens in het boogvlak.
export function gapBetween(row, A, B) {
  const T = row.frame, N = new THREE.Vector3(...T.N);
  const ca = A.position.clone(), cb = B.position.clone();
  const dir = cb.clone().sub(ca); dir.addScaledVector(N, -dir.dot(N)); const L = dir.length(); if (L < 1e-6) return 0; dir.multiplyScalar(1 / L);
  let maxA = -Infinity, minB = Infinity;
  const sa = samplePoints(A), sb = samplePoints(B);
  for (let i = 0; i < sa.length; i += 3) { _v.set(sa[i], sa[i + 1], sa[i + 2]).applyMatrix4(A.matrix); const d = _v.sub(ca).dot(dir); if (d > maxA) maxA = d; }
  for (let i = 0; i < sb.length; i += 3) { _v.set(sb[i], sb[i + 1], sb[i + 2]).applyMatrix4(B.matrix); const d = _v.sub(ca).dot(dir); if (d < minB) minB = d; }
  return minB - maxA;
}

// Groepen voor selectie: front 3–3 of de zijdelingse delen per kwadrant.
export function groupOf(fdi, all) {
  const q = Math.floor(fdi / 10), t = fdi % 10, upper = q <= 2;
  if (t <= 3) return all.filter(f => (Math.floor(f / 10) <= 2) === upper && f % 10 <= 3);
  return all.filter(f => Math.floor(f / 10) === q && f % 10 >= 4);
}

// Morph: schaal per element in lokale assen (x = mesiodistaal, y = hoogte, z = buccolinguaal), rond de hals.
export function morph(obj, fx, fy = fx, fz = fx, limits = [0.6, 1.6]) {
  const c = v => Math.max(limits[0], Math.min(limits[1], v));
  obj.scale.set(c(obj.scale.x * fx), c(obj.scale.y * fy), c(obj.scale.z * fz));
  obj.updateMatrix(); obj.updateMatrixWorld();
}

// Draaien om een lokale as (x = torque, y = om de lengteas, z = angulatie/tip), in graden.
export function rotateLocal(obj, axis, deg) {
  const a = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[axis];
  obj.quaternion.multiply(_q.setFromAxisAngle(_v.set(...a), deg * Math.PI / 180));
  obj.updateMatrix(); obj.updateMatrixWorld();
}

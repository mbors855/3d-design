// Scananalyse: occlusale as, automatische referentiepunten, ondersnijdingen.
import * as THREE from 'three';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };
export const vec = { sub, dot, cross, norm, add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], scale: (a, s) => a.map(v => v * s) };

function eigenSymmetric3(m) {
  // Jacobi-rotaties voor een symmetrische 3×3-matrix.
  const a = m.map(r => r.slice()), v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0; for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) off += a[i][j] ** 2;
    if (off < 1e-18) break;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) {
      if (Math.abs(a[p][q]) < 1e-15) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]), t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
    }
  }
  const values = [a[0][0], a[1][1], a[2][2]], vectors = [0, 1, 2].map(i => [v[0][i], v[1][i], v[2][i]]);
  const order = [0, 1, 2].sort((i, j) => values[i] - values[j]);
  return { values: order.map(i => values[i]), vectors: order.map(i => vectors[i]) };
}

// Occlusale as: kleinste hoofdas van de vlakverdeling, gericht naar de gemiddelde facetnormaal.
export function occlusalAxis(soup) {
  const n = soup.length / 9;
  let A = 0; const c = [0, 0, 0], avgN = [0, 0, 0];
  const step = Math.max(1, Math.floor(n / 60000));
  const faces = [];
  for (let f = 0; f < n; f += step) {
    const o = f * 9, a = [soup[o], soup[o + 1], soup[o + 2]], b = [soup[o + 3], soup[o + 4], soup[o + 5]], d = [soup[o + 6], soup[o + 7], soup[o + 8]];
    const nn = cross(sub(b, a), sub(d, a)), area = Math.hypot(...nn) / 2;
    if (!(area > 0)) continue;
    const cen = [(a[0] + b[0] + d[0]) / 3, (a[1] + b[1] + d[1]) / 3, (a[2] + b[2] + d[2]) / 3];
    faces.push([cen, area]); A += area; for (let k = 0; k < 3; k++) { c[k] += cen[k] * area; avgN[k] += nn[k] / 2; }
  }
  for (let k = 0; k < 3; k++) c[k] /= A;
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const [p, w] of faces) { const d = sub(p, c); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] += w * d[i] * d[j]; }
  const { vectors } = eigenSymmetric3(M);
  let axis = norm(vectors[0]);
  if (dot(axis, avgN) < 0) axis = axis.map(v => -v);
  return { axis, centroid: c, major: norm(vectors[2]) };
}

// Automatische referentiepunten op de kamlijn: rechts distaal, midden, links distaal.
// min/max zonder spread: veilig voor honderdduizenden punten (spread geeft dan een stack overflow)
function range(a) { let lo = Infinity, hi = -Infinity; for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; } return [lo, hi]; }

export function autoLandmarks(soup, axisInfo = occlusalAxis(soup)) {
  const { axis: N, centroid: C } = axisInfo;
  let U = axisInfo.major; U = norm(sub(U, vec.scale(N, dot(U, N)))); const V = cross(N, U);
  const n = soup.length / 3, step = Math.max(1, Math.floor(n / 150000)), pts = [];
  for (let i = 0; i < n; i += step) { const p = [soup[i * 3], soup[i * 3 + 1], soup[i * 3 + 2]], d = sub(p, C); pts.push({ p, u: dot(d, U), v: dot(d, V), h: dot(d, N) }); }
  // Kamtop: per cel in het vlak het hoogste punt; daarvan de hoogste 35%.
  const us = pts.map(q => q.u), vs = pts.map(q => q.v);
  const [u0, u1] = range(us), [v0, v1] = range(vs);
  const span = Math.max(u1 - u0, v1 - v0);
  const cell = span / 40, cells = new Map();
  for (const q of pts) { const k = Math.floor(q.u / cell) + ':' + Math.floor(q.v / cell), b = cells.get(k); if (!b || q.h > b.h) cells.set(k, q); }
  const tops = [...cells.values()].sort((a, b) => b.h - a.h);
  const crest = tops.slice(0, Math.max(10, Math.floor(tops.length * 0.35)));
  // Boog ligt langs de hoofdrichting U met de top (midden) aan één kant van V.
  const [uMin, uMax] = range(crest.map(q => q.u)), mid = (uMin + uMax) / 2, w = uMax - uMin;
  const center = crest.filter(q => Math.abs(q.u - mid) < w * 0.12), ends = crest.filter(q => Math.abs(q.u - mid) > w * 0.35);
  if (!center.length || !ends.length) throw Error('Kamlijn niet automatisch herkend. Zet de punten handmatig.');
  const vCenter = center.reduce((s, q) => s + q.v, 0) / center.length, vEnds = ends.reduce((s, q) => s + q.v, 0) / ends.length;
  const sign = Math.sign(vCenter - vEnds) || 1;
  const M = center.reduce((b, q) => (q.v * sign > b.v * sign ? q : b), center[0]);
  const near = q => q.v * sign < vEnds * sign + w * 0.15;
  const left = crest.filter(q => q.u < mid && near(q)), right = crest.filter(q => q.u > mid && near(q));
  if (!left.length || !right.length) throw Error('Distale kampunten niet gevonden. Zet de punten handmatig.');
  const A = left.reduce((b, q) => (q.u < b.u ? q : b), left[0]), B = right.reduce((b, q) => (q.u > b.u ? q : b), right[0]);
  // Rechts/links volgens de rechtshandige conventie met de occlusale as (zie setup.js).
  return { R: A.p, M: M.p, L: B.p, axis: N };
}

// Ondersnijdingen t.o.v. de invoerrichting (richting waarin de plaat op de kaak schuift is -dir).
// Een facet is bereikbaar als het naar dir kijkt en een straal langs dir de scan niet opnieuw raakt.
export function undercutMarks(mesh, dir) {
  const pos = mesh.geometry.getAttribute('position').array, n = pos.length / 9;
  const marks = new Uint8Array(n), d = new THREE.Vector3(...dir).normalize();
  const ray = new THREE.Raycaster(); ray.firstHitOnly = true;
  const o = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nn = new THREE.Vector3();
  let count = 0, area = 0;
  const box = new THREE.Box3().setFromBufferAttribute(mesh.geometry.getAttribute('position')), eps = box.getSize(new THREE.Vector3()).length() * 1e-4;
  for (let f = 0; f < n; f++) {
    const k = f * 9;
    a.set(pos[k], pos[k + 1], pos[k + 2]); b.set(pos[k + 3], pos[k + 4], pos[k + 5]); c.set(pos[k + 6], pos[k + 7], pos[k + 8]);
    nn.subVectors(b, a).cross(c.clone().sub(a));
    const ar = nn.length() / 2; nn.normalize();
    let blocked = nn.dot(d) < -0.02;
    if (!blocked) {
      o.copy(a).add(b).add(c).multiplyScalar(1 / 3).addScaledVector(d, eps);
      ray.set(o, d);
      blocked = ray.intersectObject(mesh, false).length > 0;
    }
    if (blocked) { marks[f] = 1; count++; area += ar; }
  }
  return { marks, count, area };
}

export function planeFrom3(a, b, c) { return norm(cross(sub(b, a), sub(c, a))); }

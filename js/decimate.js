// Vereenvoudigen (decimeren) van een scan met een harde foutgrens.
//
// Werkwijze (quadric edge collapse, Garland & Heckbert, als 'half-edge collapse'):
//  - Er blijven alleen originele scanpunten over: een punt wordt samengevoegd met een buurpunt dat blijft staan.
//    Er wordt dus nooit een punt verschoven of verzonnen.
//  - Randpunten (open rand van de scan of de uitsnede) en punten op niet-manifold randen blijven altijd staan,
//    zodat de rand exact gelijk blijft.
//  - Elk weggehaald punt hoort bij één driehoek van het nieuwe net. Bij elke samenvoeging worden alle punten van de
//    betrokken driehoeken opnieuw gemeten; is er één verder dan de tolerantie van het nieuwe oppervlak, dan gaat de
//    samenvoeging niet door. Zo ligt elk origineel scanpunt na afloop aantoonbaar binnen de tolerantie.
//  - Geen omklappende of naaldvormige driehoeken en geen niet-manifold randen (linkvoorwaarde).
// Volgorde: eerst de vlakste plekken (kleinste gemiddelde kwadratische afstand tot de vlakken van het cluster).

import { weld } from './mesh.js';

const TINY = 1e-14;
export const SCAN_LIMIT = 400000;  // boven dit aantal facetten wordt een plaat te zwaar (geheugen/tijd)
export const SCAN_TARGET = 300000; // streefwaarde na vereenvoudigen

class EdgeHeap {
  constructor(cap) { this.key = new Float64Array(cap); this.u = new Int32Array(cap); this.v = new Int32Array(cap); this.vu = new Int32Array(cap); this.vv = new Int32Array(cap); this.n = 0; }
  grow() {
    const cap = this.key.length * 2, cp = (A, T) => { const B = new T(cap); B.set(A); return B; };
    this.key = cp(this.key, Float64Array); this.u = cp(this.u, Int32Array); this.v = cp(this.v, Int32Array); this.vu = cp(this.vu, Int32Array); this.vv = cp(this.vv, Int32Array);
  }
  push(k, u, v, vu, vv) {
    if (this.n === this.key.length) this.grow();
    const K = this.key, U = this.u, V = this.v, VU = this.vu, VV = this.vv;
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= k) break;
      K[i] = K[p]; U[i] = U[p]; V[i] = V[p]; VU[i] = VU[p]; VV[i] = VV[p]; i = p;
    }
    K[i] = k; U[i] = u; V[i] = v; VU[i] = vu; VV[i] = vv;
  }
  // haalt de kleinste eraf; resultaat in this.top*
  pop() {
    const K = this.key, U = this.u, V = this.v, VU = this.vu, VV = this.vv;
    this.topKey = K[0]; this.topU = U[0]; this.topV = V[0]; this.topVU = VU[0]; this.topVV = VV[0];
    const n = --this.n;
    if (n > 0) {
      const k = K[n], u = U[n], v = V[n], vu = VU[n], vv = VV[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && K[c + 1] < K[c]) c++;
        if (K[c] >= k) break;
        K[i] = K[c]; U[i] = U[c]; V[i] = V[c]; VU[i] = VU[c]; VV[i] = VV[c]; i = c;
      }
      K[i] = k; U[i] = u; V[i] = v; VU[i] = vu; VV[i] = vv;
    }
  }
}

// Afstand punt → driehoek (Ericson). P: posities, (a,b,c): hoekpuntindices.
function pointTri(P, px, py, pz, a, b, c) {
  const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2], bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2], cx = P[c * 3], cy = P[c * 3 + 1], cz = P[c * 3 + 2];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az, apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return Math.hypot(apx, apy, apz);
  const bpx = px - bx, bpy = py - by, bpz = pz - bz, d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return Math.hypot(bpx, bpy, bpz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const t = d1 / (d1 - d3); return Math.hypot(apx - t * abx, apy - t * aby, apz - t * abz); }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz, d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return Math.hypot(cpx, cpy, cpz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const t = d2 / (d2 - d6); return Math.hypot(apx - t * acx, apy - t * acy, apz - t * acz); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const t = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return Math.hypot(bpx - t * (cx - bx), bpy - t * (cy - by), bpz - t * (cz - bz)); }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return Math.hypot(apx - abx * v - acx * w, apy - aby * v - acy * w, apz - abz * v - acz * w);
}

/**
 * Vereenvoudigt een geïndexeerd net. mesh = { positions, indices }.
 * opts.tolerance: maximale afstand (mm) van elk weggehaald scanpunt tot het nieuwe oppervlak.
 * opts.maxFaces: streefwaarde; wordt die met de tolerantie niet gehaald, dan wordt de tolerantie stapsgewijs
 *   verhoogd tot opts.maxTolerance (standaard gelijk aan tolerance: nooit ruimer dan gevraagd).
 * opts.targetFaces: stop zodra dit aantal bereikt is (niet verder vereenvoudigen dan nodig).
 * opts.lock: Uint8Array(punten) met punten die moeten blijven staan (naast de rand).
 * Geeft { mesh, faceMap (oude facetindex → nieuwe, of −1), report }.
 */
export function simplifyMesh(mesh, { tolerance = 0.01, maxFaces = Infinity, maxTolerance = tolerance, targetFaces = 0, lock = null, minQuality = 0.05, maxNormalTurn = 70 } = {}) {
  const P = mesh.positions, n = P.length / 3, m = mesh.indices.length / 3;
  const F = Int32Array.from(mesh.indices), alive = new Uint8Array(m).fill(1);
  const head = new Int32Array(n).fill(-1), tail = new Int32Array(n).fill(-1), next = new Int32Array(3 * m).fill(-1);
  for (let c = 0; c < 3 * m; c++) { const v = F[c]; if (head[v] < 0) head[v] = c; else next[tail[v]] = c; tail[v] = c; }
  // kwadratische vormen per punt (oppervlak-gewogen vlakken) en oppervlaktesom
  const Q = new Float64Array(10 * n), QA = new Float64Array(n);
  let faces = 0;
  for (let f = 0; f < m; f++) {
    const a = F[f * 3], b = F[f * 3 + 1], c = F[f * 3 + 2];
    if (a === b || b === c || a === c) { alive[f] = 0; continue; }
    faces++;
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2], vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz);
    if (l < TINY) continue;
    nx /= l; ny /= l; nz /= l;
    const d = -(nx * P[a * 3] + ny * P[a * 3 + 1] + nz * P[a * 3 + 2]), w = l / 2;
    const q0 = w * nx * nx, q1 = w * nx * ny, q2 = w * nx * nz, q3 = w * nx * d, q4 = w * ny * ny, q5 = w * ny * nz, q6 = w * ny * d, q7 = w * nz * nz, q8 = w * nz * d, q9 = w * d * d;
    for (let k = 0; k < 3; k++) {
      const v = F[f * 3 + k], o = v * 10;
      Q[o] += q0; Q[o + 1] += q1; Q[o + 2] += q2; Q[o + 3] += q3; Q[o + 4] += q4; Q[o + 5] += q5; Q[o + 6] += q6; Q[o + 7] += q7; Q[o + 8] += q8; Q[o + 9] += q9; QA[v] += w;
    }
  }
  const before = faces;
  // randpunten en niet-manifold punten vastzetten (rand = ongerichte rand in precies één facet)
  const locked = new Uint8Array(n), stamp = new Int32Array(n).fill(-1), cnt = new Int32Array(n);
  for (let v = 0; v < n; v++) {
    if (head[v] < 0) continue;
    for (let c = head[v]; c >= 0; c = next[c]) {
      const f = (c / 3) | 0; if (!alive[f]) continue;
      for (let k = 0; k < 3; k++) { const w = F[f * 3 + k]; if (w === v) continue; if (stamp[w] !== v) { stamp[w] = v; cnt[w] = 0; } cnt[w]++; }
    }
    for (let c = head[v]; c >= 0 && !locked[v]; c = next[c]) {
      const f = (c / 3) | 0; if (!alive[f]) continue;
      for (let k = 0; k < 3; k++) { const w = F[f * 3 + k]; if (w !== v && cnt[w] !== 2) { locked[v] = 1; break; } }
    }
  }
  const edge = Uint8Array.from(locked); // echte rand (en niet-manifold)
  if (lock) for (let v = 0; v < n; v++) if (lock[v]) locked[v] = 1;
  const removed = new Uint8Array(n), ver = new Int32Array(n);
  const fhead = new Int32Array(m).fill(-1), pnext = new Int32Array(n).fill(-1); // weggehaalde punten per facet
  const heap = new EdgeHeap(Math.max(1024, 4 * n));
  const qcost = (a, b, x) => { // (Q[a]+Q[b]) in punt x, gedeeld door het oppervlak
    const oa = a * 10, ob = b * 10, px = P[x * 3], py = P[x * 3 + 1], pz = P[x * 3 + 2];
    const q0 = Q[oa] + Q[ob], q1 = Q[oa + 1] + Q[ob + 1], q2 = Q[oa + 2] + Q[ob + 2], q3 = Q[oa + 3] + Q[ob + 3], q4 = Q[oa + 4] + Q[ob + 4];
    const q5 = Q[oa + 5] + Q[ob + 5], q6 = Q[oa + 6] + Q[ob + 6], q7 = Q[oa + 7] + Q[ob + 7], q8 = Q[oa + 8] + Q[ob + 8], q9 = Q[oa + 9] + Q[ob + 9];
    const e = q0 * px * px + 2 * q1 * px * py + 2 * q2 * px * pz + 2 * q3 * px + q4 * py * py + 2 * q5 * py * pz + 2 * q6 * py + q7 * pz * pz + 2 * q8 * pz + q9;
    return Math.max(0, e) / Math.max(QA[a] + QA[b], TINY);
  };
  const pushEdge = (a, b) => {
    if (removed[a] || removed[b] || (locked[a] && locked[b])) return;
    const cab = locked[a] ? Infinity : qcost(a, b, b), cba = locked[b] ? Infinity : qcost(a, b, a);
    if (cab <= cba) heap.push(cab, a, b, ver[a], ver[b]); else heap.push(cba, b, a, ver[b], ver[a]);
  };
  let token = 0;
  const mark = new Int32Array(n), mark2 = new Int32Array(n);
  const neighbours = (v, fn) => { // unieke buren van v (en snoeit dode hoeken uit de lijst)
    token++;
    let prev = -1;
    for (let c = head[v]; c >= 0;) {
      const f = (c / 3) | 0, nc = next[c];
      if (!alive[f]) { if (prev < 0) head[v] = nc; else next[prev] = nc; if (tail[v] === c) tail[v] = prev; c = nc; continue; }
      for (let k = 0; k < 3; k++) { const w = F[f * 3 + k]; if (w !== v && mark[w] !== token) { mark[w] = token; fn(w); } }
      prev = c; c = nc;
    }
  };
  const pushAll = () => { for (let v = 0; v < n; v++) if (!removed[v] && head[v] >= 0) neighbours(v, w => { if (w > v) pushEdge(v, w); }); };
  // kladruimte
  let fanF = new Int32Array(64), keepF = new Int32Array(64), pts = new Int32Array(1024), ptF = new Int32Array(1024);
  const cosTurn = Math.cos(maxNormalTurn * Math.PI / 180);
  let eps = tolerance, collapses = 0, rejectedError = 0, rejectedShape = 0, rejectedLink = 0;

  // u verdwijnt in v (v blijft op zijn plaats)
  function tryCollapse(u, v) {
    // facetten van u
    let nf = 0, nk = 0, shared = 0;
    for (let c = head[u], prev = -1; c >= 0;) {
      const f = (c / 3) | 0, nc = next[c];
      if (!alive[f]) { if (prev < 0) head[u] = nc; else next[prev] = nc; if (tail[u] === c) tail[u] = prev; c = nc; continue; }
      if (nf === fanF.length) { const g = new Int32Array(nf * 2); g.set(fanF); fanF = g; const h = new Int32Array(nf * 2); h.set(keepF); keepF = h; }
      fanF[nf++] = f;
      if (F[f * 3] === v || F[f * 3 + 1] === v || F[f * 3 + 2] === v) shared++; else keepF[nk++] = f;
      prev = c; c = nc;
    }
    if (shared !== 2 || nk === 0) { rejectedLink++; return false; }
    // linkvoorwaarde: precies twee gemeenschappelijke buren
    token++;
    const tu = token;
    for (let i = 0; i < nf; i++) { const f = fanF[i]; for (let k = 0; k < 3; k++) mark[F[f * 3 + k]] = tu; }
    token++;
    let common = 0;
    for (let c = head[v]; c >= 0; c = next[c]) {
      const f = (c / 3) | 0; if (!alive[f]) continue;
      for (let k = 0; k < 3; k++) { const w = F[f * 3 + k]; if (w !== v && w !== u && mark[w] === tu && mark2[w] !== token) { mark2[w] = token; common++; } }
    }
    if (common !== 2) { rejectedLink++; return false; }
    // vorm: niet omklappen, geen naalden
    const vx = P[v * 3], vy = P[v * 3 + 1], vz = P[v * 3 + 2];
    for (let i = 0; i < nk; i++) {
      const f = keepF[i], o = f * 3;
      let a = F[o], b = F[o + 1], c = F[o + 2];
      const ax0 = P[a * 3], ay0 = P[a * 3 + 1], az0 = P[a * 3 + 2], bx0 = P[b * 3], by0 = P[b * 3 + 1], bz0 = P[b * 3 + 2], cx0 = P[c * 3], cy0 = P[c * 3 + 1], cz0 = P[c * 3 + 2];
      const n0x = (by0 - ay0) * (cz0 - az0) - (bz0 - az0) * (cy0 - ay0), n0y = (bz0 - az0) * (cx0 - ax0) - (bx0 - ax0) * (cz0 - az0), n0z = (bx0 - ax0) * (cy0 - ay0) - (by0 - ay0) * (cx0 - ax0);
      let ax = ax0, ay = ay0, az = az0, bx = bx0, by = by0, bz = bz0, cx = cx0, cy = cy0, cz = cz0;
      if (a === u) { ax = vx; ay = vy; az = vz; a = v; } else if (b === u) { bx = vx; by = vy; bz = vz; b = v; } else { cx = vx; cy = vy; cz = vz; c = v; }
      if (edge[a] && edge[b] && edge[c]) { rejectedShape++; return false; } // geen 'oortje' aan de rand (drie randpunten)
      const n1x = (by - ay) * (cz - az) - (bz - az) * (cy - ay), n1y = (bz - az) * (cx - ax) - (bx - ax) * (cz - az), n1z = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const l0 = Math.hypot(n0x, n0y, n0z), l1 = Math.hypot(n1x, n1y, n1z);
      if (l1 < TINY) { rejectedShape++; return false; }
      if (l0 > TINY && (n0x * n1x + n0y * n1y + n0z * n1z) < cosTurn * l0 * l1) { rejectedShape++; return false; }
      const s1 = (bx - ax) ** 2 + (by - ay) ** 2 + (bz - az) ** 2 + (cx - bx) ** 2 + (cy - by) ** 2 + (cz - bz) ** 2 + (ax - cx) ** 2 + (ay - cy) ** 2 + (az - cz) ** 2;
      const q1 = 3.4641016 * l1 / s1;
      if (q1 < minQuality) {
        const s0 = (bx0 - ax0) ** 2 + (by0 - ay0) ** 2 + (bz0 - az0) ** 2 + (cx0 - bx0) ** 2 + (cy0 - by0) ** 2 + (cz0 - bz0) ** 2 + (ax0 - cx0) ** 2 + (ay0 - cy0) ** 2 + (az0 - cz0) ** 2;
        if (q1 < 3.4641016 * l0 / s0) { rejectedShape++; return false; }
      }
    }
    // afwijking: alle punten van de betrokken facetten (plus u zelf) moeten binnen eps van het nieuwe waaiertje liggen
    let np = 0;
    const addPt = p => { if (np === pts.length) { const g = new Int32Array(np * 2); g.set(pts); pts = g; const h = new Int32Array(np * 2); h.set(ptF); ptF = h; } pts[np++] = p; };
    addPt(u);
    for (let i = 0; i < nf; i++) for (let p = fhead[fanF[i]]; p >= 0; p = pnext[p]) addPt(p);
    for (let j = 0; j < np; j++) {
      const p = pts[j], px = P[p * 3], py = P[p * 3 + 1], pz = P[p * 3 + 2];
      let best = Infinity, bf = -1;
      for (let i = 0; i < nk; i++) {
        const f = keepF[i], o = f * 3;
        const a = F[o] === u ? v : F[o], b = F[o + 1] === u ? v : F[o + 1], c = F[o + 2] === u ? v : F[o + 2];
        const d = pointTri(P, px, py, pz, a, b, c);
        if (d < best) { best = d; bf = f; if (d === 0) break; }
      }
      if (best > eps) { rejectedError++; return false; }
      ptF[j] = bf;
    }
    // uitvoeren
    for (let i = 0; i < nf; i++) { const f = fanF[i]; fhead[f] = -1; }
    for (let i = 0; i < nf; i++) {
      const f = fanF[i];
      if (F[f * 3] === v || F[f * 3 + 1] === v || F[f * 3 + 2] === v) { alive[f] = 0; faces--; continue; }
      for (let k = 0; k < 3; k++) if (F[f * 3 + k] === u) F[f * 3 + k] = v;
    }
    for (let j = 0; j < np; j++) { const p = pts[j], f = ptF[j]; pnext[p] = fhead[f]; fhead[f] = p; }
    if (head[u] >= 0) { if (head[v] < 0) { head[v] = head[u]; tail[v] = tail[u]; } else { next[tail[v]] = head[u]; tail[v] = tail[u]; } }
    head[u] = tail[u] = -1;
    const ou = u * 10, ov = v * 10; for (let k = 0; k < 10; k++) Q[ov + k] += Q[ou + k]; QA[v] += QA[u];
    removed[u] = 1; ver[u]++; ver[v]++;
    collapses++;
    neighbours(v, w => pushEdge(v, w));
    return true;
  }

  pushAll();
  const goal = Math.max(targetFaces, 0);
  for (;;) {
    while (heap.n > 0 && faces > goal) {
      heap.pop();
      const u = heap.topU, v = heap.topV;
      if (removed[u] || removed[v] || ver[u] !== heap.topVU || ver[v] !== heap.topVV) continue;
      if (heap.topKey > 9 * eps * eps) { heap.n = 0; break; } // vanaf hier haalt (vrijwel) niets de puntcontrole nog
      tryCollapse(u, v);
    }
    if (faces <= Math.max(goal, maxFaces === Infinity ? Infinity : maxFaces) || eps >= maxTolerance - 1e-12) break;
    eps = Math.min(maxTolerance, eps * 1.4); // streefaantal niet gehaald: tolerantie stap voor stap ruimer (nooit boven maxTolerance)
    pushAll();
  }
  // compact maken
  const remap = new Int32Array(n).fill(-1), faceMap = new Int32Array(m).fill(-1);
  let nv = 0, nfo = 0;
  for (let f = 0; f < m; f++) if (alive[f]) { faceMap[f] = nfo++; for (let k = 0; k < 3; k++) { const v = F[f * 3 + k]; if (remap[v] < 0) remap[v] = nv++; } }
  const positions = new Float32Array(nv * 3), indices = new Uint32Array(nfo * 3);
  for (let v = 0; v < n; v++) if (remap[v] >= 0) { const o = remap[v] * 3; positions[o] = P[v * 3]; positions[o + 1] = P[v * 3 + 1]; positions[o + 2] = P[v * 3 + 2]; }
  for (let f = 0; f < m; f++) if (alive[f]) { const o = faceMap[f] * 3; for (let k = 0; k < 3; k++) indices[o + k] = remap[F[f * 3 + k]]; }
  // gemeten afwijking van alle weggehaalde punten tot hun facet
  let maxDev = 0, sumDev = 0, cntDev = 0;
  for (let f = 0; f < m; f++) if (alive[f]) for (let p = fhead[f]; p >= 0; p = pnext[p]) {
    const d = pointTri(P, P[p * 3], P[p * 3 + 1], P[p * 3 + 2], F[f * 3], F[f * 3 + 1], F[f * 3 + 2]);
    if (d > maxDev) maxDev = d; sumDev += d; cntDev++;
  }
  return {
    mesh: { positions, indices }, faceMap, remap,
    report: { before, after: nfo, vertices: nv, removedPoints: cntDev, maxDeviation: maxDev, meanDeviation: cntDev ? sumDev / cntDev : 0, tolerance: eps, collapses, rejectedError, rejectedShape, rejectedLink },
  };
}

/**
 * Vereenvoudigt een losse driehoekenlijst (STL-'soup'). Facetten vanaf lockFrom (het ontworpen, aangevulde deel)
 * blijven ongewijzigd en achteraan staan; hun punten blijven vast, zodat de naad dicht blijft.
 * Geeft { soup, report, lockFrom (nieuwe index) }.
 */
export function simplifySoup(soup, { tolerance = 0.01, maxTolerance = tolerance, targetFaces = 0, maxFaces = Infinity, lockFrom = null } = {}) {
  const mesh = weld(soup, 1e-6), nf = mesh.indices.length / 3;
  let lock = null;
  if (lockFrom != null && lockFrom < nf) { lock = new Uint8Array(mesh.positions.length / 3); for (let i = lockFrom * 3; i < mesh.indices.length; i++) lock[mesh.indices[i]] = 1; }
  const r = simplifyMesh(mesh, { tolerance, maxTolerance, targetFaces, maxFaces, lock });
  const p = r.mesh.positions, f = r.mesh.indices, out = new Float32Array(f.length * 3);
  for (let i = 0; i < f.length; i++) { const v = f[i] * 3; out[i * 3] = p[v]; out[i * 3 + 1] = p[v + 1]; out[i * 3 + 2] = p[v + 2]; }
  let newLock = null;
  if (lockFrom != null && lockFrom < nf) { newLock = 0; for (let i = 0; i < lockFrom; i++) if (r.faceMap[i] >= 0) newLock++; }
  return { soup: out, report: r.report, lockFrom: newLock };
}

/** Korte Nederlandse samenvatting voor in beeld. */
export function simplifyText(rep) {
  const nl = v => Math.round(v).toLocaleString('nl-NL'), mm = v => v.toFixed(3).replace('.', ',');
  return `${nl(rep.before)} → ${nl(rep.after)} facetten · afwijking max. ${mm(rep.maxDeviation)} mm, gemiddeld ${mm(rep.meanDeviation)} mm · rand onveranderd · alleen originele scanpunten`;
}

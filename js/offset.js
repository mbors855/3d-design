// Hulpfuncties voor de robuuste offset (v69): buren (CSR), gladde normalen, referentieoppervlak met getekende afstand,
// hoogte tot een iso-niveau langs een richting, en gladmaken van gesloten lussen (de plaatrand) langs de booglengte.
// Het iso-oppervlak zelf staat in isosheet.js, de opbouw van de plaat in shell.js.
import { bvhFor } from './bvh.js';
import { vertexNormals, toSoup } from './mesh.js';

/** Unieke buren per punt als CSR (off: Int32Array(n+1), nb: Int32Array). */
export function adjacency(indices, n) {
  const deg = new Int32Array(n + 1);
  for (let i = 0; i < indices.length; i++) deg[indices[i] + 1] += 2;
  for (let v = 0; v < n; v++) deg[v + 1] += deg[v];
  const tmp = new Int32Array(deg[n]), fill = deg.slice(0, n);
  for (let i = 0; i < indices.length; i += 3) for (let k = 0; k < 3; k++) {
    const a = indices[i + k], b = indices[i + (k + 1) % 3], c = indices[i + (k + 2) % 3];
    tmp[fill[a]++] = b; tmp[fill[a]++] = c;
  }
  // ontdubbelen per punt
  const off = new Int32Array(n + 1), out = new Int32Array(tmp.length), mark = new Int32Array(n).fill(-1);
  let o = 0;
  for (let v = 0; v < n; v++) {
    off[v] = o;
    for (let j = deg[v]; j < deg[v + 1]; j++) { const w = tmp[j]; if (mark[w] !== v) { mark[w] = v; out[o++] = w; } }
  }
  off[n] = o;
  return { off, nb: out.subarray(0, o) };
}

/** Vectorveld gladmaken (genormaliseerd): eigen waarde × selfWeight + som van de buren, 'iterations' keer. */
export function smoothVectors(adj, field, iterations, selfWeight = 2) {
  const { off, nb } = adj, n = off.length - 1;
  let cur = field, next = new Float32Array(field.length);
  for (let it = 0; it < iterations; it++) {
    for (let v = 0; v < n; v++) {
      let x = cur[v * 3] * selfWeight, y = cur[v * 3 + 1] * selfWeight, z = cur[v * 3 + 2] * selfWeight;
      for (let j = off[v]; j < off[v + 1]; j++) { const w = nb[j] * 3; x += cur[w]; y += cur[w + 1]; z += cur[w + 2]; }
      const l = Math.hypot(x, y, z) || 1;
      next[v * 3] = x / l; next[v * 3 + 1] = y / l; next[v * 3 + 2] = z / l;
    }
    [cur, next] = [next, cur === field ? new Float32Array(field.length) : cur];
  }
  return cur === field ? Float32Array.from(field) : cur;
}

/** Referentieoppervlak voor de afstandsmeting: BVH + (gladde) puntnormalen voor de kant (boven/onder). */
export function reference(mesh, normals, rim = null) {
  const s = toSoup(mesh), F = mesh.indices;
  let rimFace = null;
  if (rim) { // facetten met een randpunt
    const on = new Uint8Array(mesh.positions.length / 3); for (const v of rim) on[v] = 1;
    rimFace = new Uint8Array(F.length / 3); for (let t = 0; t < F.length; t += 3) if (on[F[t]] || on[F[t + 1]] || on[F[t + 2]]) rimFace[t / 3] = 1;
  }
  return { soup: s, bvh: bvhFor(s), F, N: normals, rimFace };
}

// Normaal op het referentieoppervlak in punt q van facet 'face': barycentrisch geïnterpoleerde puntnormalen. Gladder
// dan de facetnormaal, zodat de kant ook bij een scherpe snijkant of knobbel goed bepaald wordt.
const SN = new Float64Array(3);
function sideNormal(R, face, qx, qy, qz) {
  const s = R.soup, o = face * 9;
  const ax = s[o], ay = s[o + 1], az = s[o + 2];
  const v0x = s[o + 3] - ax, v0y = s[o + 4] - ay, v0z = s[o + 5] - az, v1x = s[o + 6] - ax, v1y = s[o + 7] - ay, v1z = s[o + 8] - az;
  const v2x = qx - ax, v2y = qy - ay, v2z = qz - az;
  const d00 = v0x * v0x + v0y * v0y + v0z * v0z, d01 = v0x * v1x + v0y * v1y + v0z * v1z, d11 = v1x * v1x + v1y * v1y + v1z * v1z;
  const d20 = v2x * v0x + v2y * v0y + v2z * v0z, d21 = v2x * v1x + v2y * v1y + v2z * v1z, den = d00 * d11 - d01 * d01;
  const F = R.F, N = R.N, ia = F[face * 3] * 3, ib = F[face * 3 + 1] * 3, ic = F[face * 3 + 2] * 3;
  let x, y, z;
  if (den > 1e-24) {
    let vb = (d11 * d20 - d01 * d21) / den, wb = (d00 * d21 - d01 * d20) / den;
    vb = Math.min(1, Math.max(0, vb)); wb = Math.min(1 - vb, Math.max(0, wb)); const ub = 1 - vb - wb;
    x = ub * N[ia] + vb * N[ib] + wb * N[ic]; y = ub * N[ia + 1] + vb * N[ib + 1] + wb * N[ic + 1]; z = ub * N[ia + 2] + vb * N[ib + 2] + wb * N[ic + 2];
  } else { x = v0y * v1z - v0z * v1y; y = v0z * v1x - v0x * v1z; z = v0x * v1y - v0y * v1x; }
  let l = Math.hypot(x, y, z);
  if (!(l > 1e-12)) { x = v0y * v1z - v0z * v1y; y = v0z * v1x - v0x * v1z; z = v0x * v1y - v0y * v1x; l = Math.hypot(x, y, z) || 1; }
  SN[0] = x / l; SN[1] = y / l; SN[2] = z / l;
}

/**
 * Gesloten lus gladmaken met een Gauss-venster langs de booglengte (sigma in mm). Anders dan herhaald middelen
 * haalt dit ook een regelmatige trap (kartelige scanrand) weg, zonder de lus merkbaar te laten krimpen.
 * normalize: voor richtingsvectoren (resultaat eenheidslengte). Geeft een nieuwe Float64Array.
 */
export function gaussLoop(V, cum, total, sigma, normalize = false) {
  const n = V.length / 3, out = new Float64Array(V.length);
  if (n < 3 || !(sigma > 0)) { out.set(V); return out; }
  const reach = 3 * sigma, inv = 1 / (2 * sigma * sigma);
  for (let i = 0; i < n; i++) {
    let x = V[i * 3], y = V[i * 3 + 1], z = V[i * 3 + 2], ws = 1;
    for (const dirn of [1, -1]) {
      for (let k = 1; k < n; k++) {
        const j = ((i + dirn * k) % n + n) % n;
        let s = dirn > 0 ? cum[j] - cum[i] : cum[i] - cum[j]; if (s < 0) s += total;
        if (s > reach || k > n / 2) break;
        const w = Math.exp(-s * s * inv); x += V[j * 3] * w; y += V[j * 3 + 1] * w; z += V[j * 3 + 2] * w; ws += w;
      }
    }
    x /= ws; y /= ws; z /= ws;
    if (normalize) { const l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l; }
    out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = z;
  }
  return out;
}
/** Cumulatieve booglengte van een gesloten lus: { cum (Float64Array, start = 0), total }. */
export function loopArc(V) {
  const n = V.length / 3, cum = new Float64Array(n); let s = 0;
  for (let i = 1; i < n; i++) { const a = (i - 1) * 3, b = i * 3; s += Math.hypot(V[b] - V[a], V[b + 1] - V[a + 1], V[b + 2] - V[a + 2]); cum[i] = s; }
  const a = (n - 1) * 3; const total = s + Math.hypot(V[0] - V[a], V[1] - V[a + 1], V[2] - V[a + 2]);
  return { cum, total };
}


/** Puntnormalen (oppervlakgewogen) van een net met posities X, in 'out' (geen allocatie per ronde). */
export function vertexNormalsInto(X, f, out) {
  out.fill(0);
  for (let t = 0; t < f.length; t += 3) {
    const a = f[t] * 3, b = f[t + 1] * 3, c = f[t + 2] * 3;
    const ux = X[b] - X[a], uy = X[b + 1] - X[a + 1], uz = X[b + 2] - X[a + 2], wx = X[c] - X[a], wy = X[c + 1] - X[a + 1], wz = X[c + 2] - X[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    out[a] += nx; out[a + 1] += ny; out[a + 2] += nz; out[b] += nx; out[b + 1] += ny; out[b + 2] += nz; out[c] += nx; out[c + 1] += ny; out[c + 2] += nz;
  }
  for (let i = 0; i < out.length; i += 3) { const l = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1; out[i] /= l; out[i + 1] /= l; out[i + 2] /= l; }
  return out;
}


/** Getekende afstand tot een referentieoppervlak (positief aan de buitenkant) en het facet van het voetpunt. */
export function signedDistance(R, x, y, z, maxDist = Infinity) {
  const bvh = R.bvh, q = bvh.point;
  let d = bvh.closest(x, y, z, maxDist);
  if (d === Infinity && maxDist !== Infinity) d = bvh.closest(x, y, z);
  if (d === Infinity) return { sd: Infinity, face: -1 };
  const face = bvh.face;
  sideNormal(R, face, q[0], q[1], q[2]);
  const s = (x - q[0]) * SN[0] + (y - q[1]) * SN[1] + (z - q[2]) * SN[2];
  return { sd: s >= 0 ? d : -d, face };
}

/**
 * Hoogte boven een startpunt, langs richting n, waar het iso-oppervlak 'level' ligt (eerste keer naar buiten, van
 * onderen). Stappen van (level − afstand): de afstand groeit hooguit even hard, dus nooit voorbij het eerste snijpunt.
 */
export function heightToLevel(R, px, py, pz, nx, ny, nz, levelFn, maxH = 10) {
  let s = 0;
  for (let k = 0; k < 40; k++) {
    const { sd, face } = signedDistance(R, px + nx * s, py + ny * s, pz + nz * s);
    if (sd === Infinity) return null;
    const lv = levelFn(face), gap = lv - sd;
    if (gap < 0.003) return s;
    s += Math.max(gap, 0.01);
    if (s > maxH) return null;
  }
  return s;
}

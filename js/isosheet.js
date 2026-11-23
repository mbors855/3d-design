// Buitenkant van een plaat als iso-oppervlak (v69): alle punten op precies 'level' mm van de scan, aan de buitenkant.
//
// Werkwijze ('surface nets' op een dun, verspreid raster): vanaf startpunten boven de scan worden alleen de
// rastercellen bezocht waar het iso-oppervlak doorheen loopt (vlakvullen). In elke cel komt één punt, op het
// gemiddelde van de snijpunten op de celribben; elke doorsneden rib geeft een vierhoek tussen de vier cellen eromheen.
// Zo'n oppervlak kan niet omklappen of door zichzelf heen steken, overbrugt smalle spleten (tussen tanden) vanzelf en
// is op bolle delen rond met een straal van minstens 'level'. Bij de plaatrand stopt het vlak (clip), daar sluit de
// afgeronde rand aan.
import { pointTriangle2, TriBVH } from './bvh.js';

/**
 * ref: { bvh, soup, F, N } (zie offset.js: reference) — het oppervlak waarvan de afstand gemeten wordt.
 * level(face, qx, qy, qz) of getal: gewenste afstand (mm) bij voetpunt q op facet 'face'.
 * h: celgrootte (mm). seeds: Float32Array met punten vlak bij het iso-oppervlak.
 * inside(x, y, z, face): false = cel valt buiten de plaat (bij de rand); null = alles.
 * Geeft { positions, indices } (buitenwaarts georiënteerd) en statistiek.
 */
export function* isoSurface({ ref, level, h, seeds, inside = null, due = () => false, label = 'buitenkant', maxCells = 2_000_000 }) {
  const bvh = ref.bvh, q = bvh.point, soup = ref.soup, F = ref.F, N = ref.N;
  const lvOf = typeof level === 'number' ? () => level : level;
  // raster: integer coördinaten rond een oorsprong; sleutel = i + j·K + k·K² (exact in een double)
  const K = 1 << 15, K2 = K * K, ox = -K / 2 * h, oy = -K / 2 * h, oz = -K / 2 * h;
  const key = (i, j, k) => i + j * K + k * K2;
  const val = new Map(); // hoekpunt → F = sd − level (Float, NaN = onbekend)
  let queries = 0;
  const side = new Float64Array(3);
  const sdAt = (x, y, z, bound) => {
    queries++;
    let d = bvh.closest(x, y, z, bound);
    if (d === Infinity) d = bvh.closest(x, y, z);
    if (d === Infinity) return [Infinity, -1];
    const face = bvh.face;
    // kant: barycentrisch geïnterpoleerde puntnormaal in het voetpunt
    const o = face * 9, ax = soup[o], ay = soup[o + 1], az = soup[o + 2];
    const v0x = soup[o + 3] - ax, v0y = soup[o + 4] - ay, v0z = soup[o + 5] - az, v1x = soup[o + 6] - ax, v1y = soup[o + 7] - ay, v1z = soup[o + 8] - az;
    const v2x = q[0] - ax, v2y = q[1] - ay, v2z = q[2] - az;
    const d00 = v0x * v0x + v0y * v0y + v0z * v0z, d01 = v0x * v1x + v0y * v1y + v0z * v1z, d11 = v1x * v1x + v1y * v1y + v1z * v1z;
    const d20 = v2x * v0x + v2y * v0y + v2z * v0z, d21 = v2x * v1x + v2y * v1y + v2z * v1z, den = d00 * d11 - d01 * d01;
    const ia = F[face * 3] * 3, ib = F[face * 3 + 1] * 3, ic = F[face * 3 + 2] * 3;
    if (den > 1e-24) {
      let vb = (d11 * d20 - d01 * d21) / den, wb = (d00 * d21 - d01 * d20) / den;
      vb = Math.min(1, Math.max(0, vb)); wb = Math.min(1 - vb, Math.max(0, wb)); const ub = 1 - vb - wb;
      side[0] = ub * N[ia] + vb * N[ib] + wb * N[ic]; side[1] = ub * N[ia + 1] + vb * N[ib + 1] + wb * N[ic + 1]; side[2] = ub * N[ia + 2] + vb * N[ib + 2] + wb * N[ic + 2];
    } else { side[0] = v0y * v1z - v0z * v1y; side[1] = v0z * v1x - v0x * v1z; side[2] = v0x * v1y - v0y * v1x; }
    const s = (x - q[0]) * side[0] + (y - q[1]) * side[1] + (z - q[2]) * side[2];
    return [s >= 0 ? d : -d, face];
  };
  const footFace = new Map(), absSd = new Map(); // hoekpunt → facet van het voetpunt (voor 'inside') en |afstand|
  let lastAbs = Infinity; // |afstand| van het vorige hoekpunt: + 1,75·h is een bovengrens voor een buurhoekpunt
  const corner = (i, j, k) => {
    const kk = key(i, j, k); let v = val.get(kk);
    if (v !== undefined) { lastAbs = absSd.get(kk); return v; }
    const x = ox + i * h, y = oy + j * h, z = oz + k * h;
    const [sd, face] = sdAt(x, y, z, lastAbs === Infinity ? Infinity : lastAbs + 1.75 * h + 1e-3);
    v = sd === Infinity ? 1e9 : sd - lvOf(face, q[0], q[1], q[2]);
    lastAbs = Math.abs(sd);
    val.set(kk, v); footFace.set(kk, face); absSd.set(kk, lastAbs);
    return v;
  };
  // vlakvullen over doorsneden cellen
  const cellState = new Map(); // cel → 1 actief, 0 niet doorsneden / buiten
  const active = [];
  const queue = [];
  // per cel in de wachtrij ook een bovengrens voor |afstand| (van de cel waar hij vandaan kwam): de eerste vraag per cel
  // hoeft dan niet de hele scan af te zoeken
  const pushCell = (i, j, k, b) => { const kk = key(i, j, k); if (!cellState.has(kk)) { cellState.set(kk, -1); queue.push(i, j, k, b); } };
  for (let s = 0; s < seeds.length; s += 3) pushCell(Math.floor((seeds[s] - ox) / h), Math.floor((seeds[s + 1] - oy) / h), Math.floor((seeds[s + 2] - oz) / h), Infinity);
  const cv = new Float64Array(8);
  let head = 0;
  while (head < queue.length) {
    if (((head / 4) & 1023) === 0 && due()) yield label;
    const i = queue[head++], j = queue[head++], k = queue[head++], kk = key(i, j, k), from = queue[head++];
    let mn = Infinity, mx = -Infinity;
    lastAbs = from === Infinity ? Infinity : from + 1.75 * h; // hoekpunt 0 ligt binnen 2·√3·h van een hoekpunt van de buurcel
    for (let c = 0; c < 8; c++) {
      const v = corner(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1));
      cv[c] = v; if (v < mn) mn = v; if (v > mx) mx = v;
    }
    if (!(mn < 0 && mx >= 0) || mx > 1e8) { cellState.set(kk, 0); continue; }
    if (inside) {
      const x = ox + (i + 0.5) * h, y = oy + (j + 0.5) * h, z = oz + (k + 0.5) * h;
      if (!inside(x, y, z, footFace.get(key(i, j, k)))) { cellState.set(kk, 0); continue; }
    }
    cellState.set(kk, 1); active.push(i, j, k);
    if (active.length / 3 > maxCells) throw Error('Het oppervlak voor de buitenkant werd te groot. Kies een kleinere omtrek of dikte.');
    // buren alleen via zijvlakken waar het iso-oppervlak doorheen gaat
    const faceCross = (a, b, c2, d) => { const lo = Math.min(cv[a], cv[b], cv[c2], cv[d]), hi = Math.max(cv[a], cv[b], cv[c2], cv[d]); return lo < 0 && hi >= 0; };
    const b0 = absSd.get(key(i, j, k));
    if (faceCross(0, 2, 4, 6)) pushCell(i - 1, j, k, b0); if (faceCross(1, 3, 5, 7)) pushCell(i + 1, j, k, b0);
    if (faceCross(0, 1, 4, 5)) pushCell(i, j - 1, k, b0); if (faceCross(2, 3, 6, 7)) pushCell(i, j + 1, k, b0);
    if (faceCross(0, 1, 2, 3)) pushCell(i, j, k - 1, b0); if (faceCross(4, 5, 6, 7)) pushCell(i, j, k + 1, b0);
  }
  // één punt per actieve cel: gemiddelde van de snijpunten op de 12 ribben
  const nCells = active.length / 3, pos = new Float32Array(nCells * 3), index = new Map();
  const E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (let c = 0; c < nCells; c++) {
    const i = active[c * 3], j = active[c * 3 + 1], k = active[c * 3 + 2];
    index.set(key(i, j, k), c);
    for (let t = 0; t < 8; t++) cv[t] = val.get(key(i + (t & 1), j + ((t >> 1) & 1), k + ((t >> 2) & 1)));
    let sx = 0, sy = 0, sz = 0, cnt = 0;
    for (const [a, b] of E) {
      const va = cv[a], vb = cv[b];
      if ((va < 0) === (vb < 0)) continue;
      const t = va / (va - vb);
      sx += (a & 1) + (((b & 1) - (a & 1)) * t); sy += ((a >> 1) & 1) + ((((b >> 1) & 1) - ((a >> 1) & 1)) * t); sz += ((a >> 2) & 1) + ((((b >> 2) & 1) - ((a >> 2) & 1)) * t);
      cnt++;
    }
    pos[c * 3] = ox + (i + sx / cnt) * h; pos[c * 3 + 1] = oy + (j + sy / cnt) * h; pos[c * 3 + 2] = oz + (k + sz / cnt) * h;
  }
  // vierhoeken: per doorsneden rib vanuit het minimale hoekpunt van een cel, als alle vier cellen eromheen actief zijn
  const tris = [];
  const cellIdx = (i, j, k) => index.get(key(i, j, k));
  for (let c = 0; c < nCells; c++) {
    if ((c & 4095) === 0 && due()) yield label;
    const i = active[c * 3], j = active[c * 3 + 1], k = active[c * 3 + 2];
    const v0 = val.get(key(i, j, k));
    for (let a = 0; a < 3; a++) {
      const v1 = val.get(key(i + (a === 0), j + (a === 1), k + (a === 2)));
      if (v1 === undefined || (v0 < 0) === (v1 < 0)) continue;
      // de vier cellen rond deze rib (rib langs as a vanaf hoekpunt (i,j,k))
      let q0, q1, q2, q3;
      if (a === 0) { q0 = cellIdx(i, j - 1, k - 1); q1 = cellIdx(i, j, k - 1); q2 = c; q3 = cellIdx(i, j - 1, k); }
      else if (a === 1) { q0 = cellIdx(i - 1, j, k - 1); q1 = cellIdx(i - 1, j, k); q2 = c; q3 = cellIdx(i, j, k - 1); }
      else { q0 = cellIdx(i - 1, j - 1, k); q1 = cellIdx(i, j - 1, k); q2 = c; q3 = cellIdx(i - 1, j, k); }
      if (q0 === undefined || q1 === undefined || q3 === undefined) continue;
      // oriëntatie: normaal moet langs de rib wijzen van binnen (F<0) naar buiten (F≥0)
      const sgn = v0 < 0 ? 1 : -1; // rib wijst naar +a als het begin binnen ligt
      // kortste diagonaal kiezen
      const dA = dist2(pos, q0, q2), dB = dist2(pos, q1, q3);
      let t1, t2;
      if (dA <= dB) { t1 = [q0, q1, q2]; t2 = [q0, q2, q3]; } else { t1 = [q0, q1, q3]; t2 = [q1, q2, q3]; }
      for (const t of [t1, t2]) {
        const n = triNormal(pos, t[0], t[1], t[2]);
        if (n[a] * sgn < 0) { const tmp = t[1]; t[1] = t[2]; t[2] = tmp; }
        tris.push(t[0], t[1], t[2]);
      }
    }
  }
  return { positions: pos, indices: Uint32Array.from(tris), stats: { cells: nCells, corners: val.size, queries } };
}

function dist2(p, a, b) { const dx = p[a * 3] - p[b * 3], dy = p[a * 3 + 1] - p[b * 3 + 1], dz = p[a * 3 + 2] - p[b * 3 + 2]; return dx * dx + dy * dy + dz * dz; }
function triNormal(p, a, b, c) {
  const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2], wx = p[c * 3] - p[a * 3], wy = p[c * 3 + 1] - p[a * 3 + 1], wz = p[c * 3 + 2] - p[a * 3 + 2];
  return [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx];
}

/**
 * Strook tussen twee gesloten lussen met verschillend aantal punten (zelfde draairichting). A = buitenste lus (vast,
 * bv. de afgeronde plaatrand), B = rand van het iso-oppervlak. Elk punt van B krijgt een plek op A (dichtstbijzijnde
 * punt, steeds verder langs de lus): zo lopen de driehoeken overal dwars over de strook, ook als B kartelig is.
 * Driehoeken (A_i, A_i+1, B_j) en (A_i, B_j+1, B_j): randen van A in de looprichting, van B ertegenin.
 * opts.normals: draairichting van B zo nodig omdraaien; opts.tau: plek van elk B-punt op A (index, mag fractioneel),
 * opts.startA: A begint bij deze index (B[0] hoort daar). Geeft een Float32Array-soup.
 */
export function loftLoops(A, Bin, normals = null, startA = null, tauIn = null) {
  const na = A.length / 3, nb = Bin.length / 3;
  let B = Bin;
  if (normals) {
    // zelfde draairichting? (getekende oppervlakte rond de gemiddelde normaal)
    let ax = 0, ay = 0, az = 0; for (let i = 0; i < normals.length; i += 3) { ax += normals[i]; ay += normals[i + 1]; az += normals[i + 2]; }
    const wind = (L) => { const n = L.length / 3; let s = 0; for (let i = 0; i < n; i++) { const a = i * 3, b = ((i + 1) % n) * 3; s += (L[a + 1] * L[b + 2] - L[a + 2] * L[b + 1]) * ax + (L[a + 2] * L[b] - L[a] * L[b + 2]) * ay + (L[a] * L[b + 1] - L[a + 1] * L[b]) * az; } return s; };
    if (Math.sign(wind(A)) !== Math.sign(wind(B))) { const r = new Float32Array(B.length); for (let j = 0; j < nb; j++) for (let k = 0; k < 3; k++) r[j * 3 + k] = B[(nb - 1 - j) * 3 + k]; B = r; }
  }
  let a0 = 0, b0 = 0, tau = tauIn;
  if (startA !== null) a0 = startA;
  const Ai = (i) => ((a0 + i) % na) * 3;
  if (!tau) {
    // elk B-punt: dichtstbijzijnde punt op A (over de hele lus, BVH over de stukjes van A)
    const segSoup = new Float32Array(na * 9);
    for (let i = 0; i < na; i++) { const p = Ai(i), q = Ai(i + 1); segSoup.set([A[p], A[p + 1], A[p + 2], A[q], A[q + 1], A[q + 2], A[q], A[q + 1], A[q + 2]], i * 9); }
    const bvh = new TriBVH(segSoup), raw = new Float64Array(nb);
    for (let j = 0; j < nb; j++) {
      bvh.closest(B[j * 3], B[j * 3 + 1], B[j * 3 + 2]);
      const i = bvh.face, p = Ai(i), q = Ai(i + 1), cp = bvh.point;
      const ex = A[q] - A[p], ey = A[q + 1] - A[p + 1], ez = A[q + 2] - A[p + 2], l2 = ex * ex + ey * ey + ez * ez;
      raw[j] = i + (l2 > 0 ? Math.min(1, Math.max(0, ((cp[0] - A[p]) * ex + (cp[1] - A[p + 1]) * ey + (cp[2] - A[p + 2]) * ez) / l2)) : 0);
    }
    // B laten beginnen bij het punt met de kleinste plek; daarna oplopend maken (lus rond: +na bij teruglopen) en
    // uitschieters wegwerken (mediaan over 7 buren), tot slot monotoon
    let j0 = 0; for (let j = 1; j < nb; j++) if (raw[j] < raw[j0]) j0 = j;
    b0 = j0;
    const un = new Float64Array(nb); let prev = raw[j0];
    for (let k = 0; k < nb; k++) { let t = raw[(j0 + k) % nb]; while (t < prev - na / 2) t += na; while (t > prev + na / 2) t -= na; un[k] = t; prev = t; }
    tau = new Float64Array(nb); const win = [];
    for (let k = 0; k < nb; k++) { win.length = 0; for (let d = -3; d <= 3; d++) { const kk = k + d; if (kk >= 0 && kk < nb) win.push(un[kk]); } win.sort((x, y) => x - y); tau[k] = win[win.length >> 1]; }
    tau[0] = Math.max(0, Math.min(tau[0], na));
    for (let k = 1; k < nb; k++) tau[k] = Math.min(na, Math.max(tau[k - 1], tau[k]));
    tau[0] = 0;
  }
  const Bj = (j) => ((b0 + j) % nb) * 3;
  const out = new Float32Array((na + nb) * 9);
  let o = 0, i = 0, j = 0;
  const putA = (k) => { const s = Ai(k % na); out[o++] = A[s]; out[o++] = A[s + 1]; out[o++] = A[s + 2]; };
  const putB = (k) => { const s = Bj(k % nb); out[o++] = B[s]; out[o++] = B[s + 1]; out[o++] = B[s + 2]; };
  while (i < na || j < nb) {
    const nextB = j + 1 < nb ? tau[j + 1] : na;
    if (j >= nb || (i < na && i + 1 <= nextB)) { putA(i); putA(i + 1); putB(j); i++; }
    else { putA(i); putB(j + 1); putB(j); j++; }
  }
  return out;
}

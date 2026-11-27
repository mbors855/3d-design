// v74: iso-oppervlak van een willekeurig veld (surface nets op een verspreid raster), zoals isosheet.js, maar met een
// functie in plaats van 'afstand tot de scan'. Veld < 0 = binnen. Alleen de cellen waar het oppervlak doorheen loopt
// worden bezocht (vlakvullen vanaf startpunten). Buiten de doos [lo, hi] telt alles als buiten: het oppervlak is
// daardoor altijd gesloten (en manifold: één punt per cel, een vierhoek per doorsneden rib).

/**
 * field(x, y, z) → getal (< 0 binnen). h: celgrootte (mm). lo, hi: [x, y, z] van de doos.
 * starts: [{ p: [x, y, z], d: [dx, dy, dz], len }] — vanaf p langs d wordt gezocht naar de eerste tekenwissel.
 * Geeft { positions, indices, stats } (normalen naar buiten, waar het veld ≥ 0 is).
 */
export function* isoField({ field, h, lo, hi, starts, maxCells = 2_500_000, due = () => false, label = 'veld' }) {
  const nx = Math.ceil((hi[0] - lo[0]) / h) + 1, ny = Math.ceil((hi[1] - lo[1]) / h) + 1, nz = Math.ceil((hi[2] - lo[2]) / h) + 1;
  const SX = nx + 1, SXY = (nx + 1) * (ny + 1);
  const key = (i, j, k) => i + j * SX + k * SXY;
  const val = new Map();
  let evals = 0;
  const corner = (i, j, k) => {
    const kk = key(i, j, k); let v = val.get(kk);
    if (v !== undefined) return v;
    if (i <= 0 || j <= 0 || k <= 0 || i >= nx || j >= ny || k >= nz) v = 1;
    else { v = field(lo[0] + i * h, lo[1] + j * h, lo[2] + k * h); evals++; if (!(v === v)) v = 1; } // NaN = buiten
    val.set(kk, v);
    return v;
  };
  // startcellen: langs elke zoekrichting de eerste tekenwissel
  const seedCells = [];
  for (const s of starts) {
    const len = s.len ?? 12, step = h * 0.5;
    let prev = null;
    for (let t = 0; t <= len; t += step) {
      const x = s.p[0] + s.d[0] * t, y = s.p[1] + s.d[1] * t, z = s.p[2] + s.d[2] * t;
      if (x <= lo[0] || y <= lo[1] || z <= lo[2] || x >= hi[0] || y >= hi[1] || z >= hi[2]) break;
      const v = field(x, y, z) < 0;
      if (prev !== null && v !== prev) {
        const i = Math.floor((x - lo[0]) / h), j = Math.floor((y - lo[1]) / h), k = Math.floor((z - lo[2]) / h);
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) seedCells.push(i + a, j + b, k + c);
        break;
      }
      prev = v;
    }
  }
  const cv = new Float64Array(8);
  let active = [];
  // vlakvullen over doorsneden cellen (opnieuw na het oplossen van dubbelzinnige zijvlakken; de hoekwaarden blijven bewaard)
  function* flood(extra) {
    const state = new Map(), queue = [], act = [];
    const push = (i, j, k) => { if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return; const kk = key(i, j, k); if (!state.has(kk)) { state.set(kk, -1); queue.push(i, j, k); } };
    for (let s = 0; s < seedCells.length; s += 3) push(seedCells[s], seedCells[s + 1], seedCells[s + 2]);
    for (let s = 0; s < extra.length; s += 3) push(extra[s], extra[s + 1], extra[s + 2]);
    let head = 0;
    while (head < queue.length) {
      if (((head / 3) & 1023) === 0 && due()) yield label;
      const i = queue[head++], j = queue[head++], k = queue[head++], kk = key(i, j, k);
      let mn = Infinity, mx = -Infinity;
      for (let c = 0; c < 8; c++) { const v = corner(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1)); cv[c] = v; if (v < mn) mn = v; if (v > mx) mx = v; }
      if (!(mn < 0 && mx >= 0)) { state.set(kk, 0); continue; }
      state.set(kk, 1); act.push(i, j, k);
      if (act.length / 3 > maxCells) throw Error('Het tandvlees werd te groot om te berekenen.');
      const faceCross = (a, b, c2, d) => { const l = Math.min(cv[a], cv[b], cv[c2], cv[d]), u = Math.max(cv[a], cv[b], cv[c2], cv[d]); return l < 0 && u >= 0; };
      if (faceCross(0, 2, 4, 6)) push(i - 1, j, k); if (faceCross(1, 3, 5, 7)) push(i + 1, j, k);
      if (faceCross(0, 1, 4, 5)) push(i, j - 1, k); if (faceCross(2, 3, 6, 7)) push(i, j + 1, k);
      if (faceCross(0, 1, 2, 3)) push(i, j, k - 1); if (faceCross(4, 5, 6, 7)) push(i, j, k + 1);
    }
    return act;
  }
  // Dubbelzinnige zijvlakken (zadel: hoeken om en om binnen/buiten) en cellen met twee losse hoeken op een
  // lichaamsdiagonaal geven bij één punt per cel een niet-manifold rib of hoekpunt. Oplossen door de hoek die het
  // dichtst bij 0 ligt naar de andere kant te zetten (een topologische correctie op celniveau, ≤ h).
  const FACES = [[0, 2, 6, 4], [1, 3, 7, 5], [0, 1, 5, 4], [2, 3, 7, 6], [0, 1, 3, 2], [4, 5, 7, 6]];
  const ck = (i, j, k, c) => key(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1));
  let fixes = 0;
  for (let pass = 0; pass < 8; pass++) {
    active = yield* flood([]);
    let changed = 0;
    const extra = [];
    for (let a = 0; a < active.length; a += 3) {
      const i = active[a], j = active[a + 1], k = active[a + 2], before = changed;
      for (let c = 0; c < 8; c++) cv[c] = val.get(ck(i, j, k, c));
      for (const [p, q, r, s] of FACES) {
        const sp = cv[p] < 0, sq = cv[q] < 0, sr = cv[r] < 0, ss = cv[s] < 0;
        if (!(sp === sr && sq === ss && sp !== sq)) continue;
        const centre = (cv[p] + cv[q] + cv[r] + cv[s]) / 4;
        // binnen verbonden → een buitenhoek naar binnen; anders een binnenhoek naar buiten
        const cand = centre < 0 ? (sp ? [q, s] : [p, r]) : (sp ? [p, r] : [q, s]);
        const pick = Math.abs(cv[cand[0]]) <= Math.abs(cv[cand[1]]) ? cand[0] : cand[1];
        const nv = centre < 0 ? -1e-7 : 1e-7;
        val.set(ck(i, j, k, pick), nv); cv[pick] = nv; changed++;
      }
      // lichaamsdiagonaal: precies twee hoeken aan één kant, en die liggen tegenover elkaar
      let nin = 0; for (let c = 0; c < 8; c++) if (cv[c] < 0) nin++;
      if (nin === 2 || nin === 6) {
        const want = nin === 2; // de twee 'losse' hoeken zijn binnen (nin = 2) of buiten (nin = 6)
        const odd = []; for (let c = 0; c < 8; c++) if ((cv[c] < 0) === want) odd.push(c);
        if (odd[0] + odd[1] === 7 && (odd[0] ^ odd[1]) === 7) {
          const pick = Math.abs(cv[odd[0]]) <= Math.abs(cv[odd[1]]) ? odd[0] : odd[1], nv = want ? 1e-7 : -1e-7;
          val.set(ck(i, j, k, pick), nv); changed++;
        }
      }
      if (changed > before) extra.push(i, j, k);
    }
    fixes += changed;
    if (!changed) break;
    for (let s = 0; s < extra.length; s += 3) seedCells.push(extra[s], extra[s + 1], extra[s + 2]);
  }
  // één punt per actieve cel: gemiddelde van de snijpunten op de doorsneden ribben
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
      sx += (a & 1) + ((b & 1) - (a & 1)) * t; sy += ((a >> 1) & 1) + (((b >> 1) & 1) - ((a >> 1) & 1)) * t; sz += ((a >> 2) & 1) + (((b >> 2) & 1) - ((a >> 2) & 1)) * t;
      cnt++;
    }
    pos[c * 3] = lo[0] + (i + sx / cnt) * h; pos[c * 3 + 1] = lo[1] + (j + sy / cnt) * h; pos[c * 3 + 2] = lo[2] + (k + sz / cnt) * h;
  }
  const tris = [], cell = (i, j, k) => index.get(key(i, j, k));
  for (let c = 0; c < nCells; c++) {
    if ((c & 8191) === 0 && due()) yield label;
    const i = active[c * 3], j = active[c * 3 + 1], k = active[c * 3 + 2], v0 = val.get(key(i, j, k));
    for (let a = 0; a < 3; a++) {
      const v1 = val.get(key(i + (a === 0), j + (a === 1), k + (a === 2)));
      if (v1 === undefined || (v0 < 0) === (v1 < 0)) continue;
      let q0, q1, q3;
      if (a === 0) { q0 = cell(i, j - 1, k - 1); q1 = cell(i, j, k - 1); q3 = cell(i, j - 1, k); }
      else if (a === 1) { q0 = cell(i - 1, j, k - 1); q1 = cell(i - 1, j, k); q3 = cell(i, j, k - 1); }
      else { q0 = cell(i - 1, j - 1, k); q1 = cell(i, j - 1, k); q3 = cell(i - 1, j, k); }
      if (q0 === undefined || q1 === undefined || q3 === undefined) continue;
      const q2 = c, sgn = v0 < 0 ? 1 : -1;
      const dA = d2(pos, q0, q2), dB = d2(pos, q1, q3);
      const T = dA <= dB ? [[q0, q1, q2], [q0, q2, q3]] : [[q0, q1, q3], [q1, q2, q3]];
      for (const t of T) {
        if (nrm(pos, t[0], t[1], t[2], a) * sgn < 0) { const x = t[1]; t[1] = t[2]; t[2] = x; }
        tris.push(t[0], t[1], t[2]);
      }
    }
  }
  return { positions: pos, indices: Uint32Array.from(tris), stats: { cells: nCells, corners: val.size, evals, fixes } };
}

function d2(p, a, b) { const x = p[a * 3] - p[b * 3], y = p[a * 3 + 1] - p[b * 3 + 1], z = p[a * 3 + 2] - p[b * 3 + 2]; return x * x + y * y + z * z; }
// component 'axis' van de (niet genormaliseerde) normaal van driehoek a-b-c
function nrm(p, a, b, c, axis) {
  const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2], wx = p[c * 3] - p[a * 3], wy = p[c * 3 + 1] - p[a * 3 + 1], wz = p[c * 3 + 2] - p[a * 3 + 2];
  return axis === 0 ? uy * wz - uz * wy : axis === 1 ? uz * wx - ux * wz : ux * wy - uy * wx;
}

/** Synchrone variant (tests, Node). */
export function isoFieldSync(opts) { const g = isoField(opts); let r = g.next(); while (!r.done) r = g.next(); return r.value; }

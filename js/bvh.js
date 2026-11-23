// Statische BVH (bounding volume hierarchy) over de driehoeken van een soup, voor 'dichtstbijzijnd punt'-vragen.
// Alleen typed arrays, geen three.js: werkt in de browser en in Node (tests). Bouwen O(n log n) met een
// mediaansplitsing op de langste as; een vraag bezoekt alleen knopen die dichterbij liggen dan de beste treffer.
// Op een kaakscan van 300.000 facetten: bouwen ±0,15 s, een vraag een paar microseconden (het oude raster deed
// per punt duizenden driehoektests en liet de pagina minutenlang vastlopen).
const CP = new Float64Array(3); // dichtstbijzijnd punt van de laatste driehoektest (geen allocaties per test)

/** Kwadraat van de afstand van p tot driehoek (soup, offset o); het punt komt in CP. Ericson, Real-Time Collision Detection. */
export function pointTriangle2(px, py, pz, s, o) {
  const ax = s[o], ay = s[o + 1], az = s[o + 2], bx = s[o + 3], by = s[o + 4], bz = s[o + 5], cx = s[o + 6], cy = s[o + 7], cz = s[o + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let qx, qy, qz;
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; }
  else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz, d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { qx = bx; qy = by; qz = bz; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); qx = ax + v * abx; qy = ay + v * aby; qz = az + v * abz; }
      else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz, d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { qx = cx; qy = cy; qz = cz; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); qx = ax + w * acx; qy = ay + w * acy; qz = az + w * acz; }
          else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); qx = bx + w * (cx - bx); qy = by + w * (cy - by); qz = bz + w * (cz - bz); }
            else {
              const sum = va + vb + vc;
              if (!(Math.abs(sum) > 1e-30)) { qx = ax; qy = ay; qz = az; } // gedegenereerde driehoek: dichtstbijzijnde hoek is goed genoeg
              else { const den = 1 / sum, v = vb * den, w = vc * den; qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w; }
            }
          }
        }
      }
    }
  }
  CP[0] = qx; CP[1] = qy; CP[2] = qz;
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

export class TriBVH {
  constructor(soup, { leafSize = 6 } = {}) {
    const nf = soup.length / 9;
    this.soup = soup; this.faces = nf;
    const fb = new Float32Array(nf * 6), cen = new Float32Array(nf * 3);
    for (let f = 0; f < nf; f++) {
      const o = f * 9;
      let x0 = soup[o], x1 = x0, y0 = soup[o + 1], y1 = y0, z0 = soup[o + 2], z1 = z0;
      for (let k = 3; k < 9; k += 3) {
        const x = soup[o + k], y = soup[o + k + 1], z = soup[o + k + 2];
        if (x < x0) x0 = x; else if (x > x1) x1 = x;
        if (y < y0) y0 = y; else if (y > y1) y1 = y;
        if (z < z0) z0 = z; else if (z > z1) z1 = z;
      }
      fb[f * 6] = x0; fb[f * 6 + 1] = y0; fb[f * 6 + 2] = z0; fb[f * 6 + 3] = x1; fb[f * 6 + 4] = y1; fb[f * 6 + 5] = z1;
      cen[f * 3] = (x0 + x1) * 0.5; cen[f * 3 + 1] = (y0 + y1) * 0.5; cen[f * 3 + 2] = (z0 + z1) * 0.5;
    }
    const idx = new Uint32Array(nf); for (let i = 0; i < nf; i++) idx[i] = i;
    const maxNodes = Math.max(1, 2 * Math.ceil(nf / Math.max(1, leafSize >> 1)));
    const box = new Float32Array(maxNodes * 6), start = new Int32Array(maxNodes), count = new Int32Array(maxNodes), left = new Int32Array(maxNodes);
    let nodes = 1;
    const stack = [[0, 0, nf]];
    while (stack.length) {
      const [n, s, e] = stack.pop();
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
      for (let i = s; i < e; i++) {
        const f = idx[i], b = f * 6, c = f * 3;
        if (fb[b] < x0) x0 = fb[b]; if (fb[b + 1] < y0) y0 = fb[b + 1]; if (fb[b + 2] < z0) z0 = fb[b + 2];
        if (fb[b + 3] > x1) x1 = fb[b + 3]; if (fb[b + 4] > y1) y1 = fb[b + 4]; if (fb[b + 5] > z1) z1 = fb[b + 5];
        const px = cen[c], py = cen[c + 1], pz = cen[c + 2];
        if (px < cx0) cx0 = px; if (px > cx1) cx1 = px; if (py < cy0) cy0 = py; if (py > cy1) cy1 = py; if (pz < cz0) cz0 = pz; if (pz > cz1) cz1 = pz;
      }
      box[n * 6] = x0; box[n * 6 + 1] = y0; box[n * 6 + 2] = z0; box[n * 6 + 3] = x1; box[n * 6 + 4] = y1; box[n * 6 + 5] = z1;
      const len = e - s, ex = cx1 - cx0, ey = cy1 - cy0, ez = cz1 - cz0;
      if (len <= leafSize || !(Math.max(ex, ey, ez) > 1e-9) || nodes + 2 > maxNodes) { start[n] = s; count[n] = len; continue; }
      const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2, mid = (s + e) >> 1;
      nthElement(idx, cen, axis, s, e - 1, mid);
      const l = nodes; nodes += 2;
      left[n] = l; count[n] = 0;
      stack.push([l, s, mid], [l + 1, mid, e]);
    }
    this.idx = idx; this.box = box; this.start = start; this.count = count; this.left = left; this.nodes = nodes;
    this._stack = new Int32Array(256); this._sd = new Float64Array(256);
    this.point = new Float64Array(3); this.face = -1;
  }
  /** Afstand van p tot het oppervlak als die ≤ maxDist is, anders Infinity. Het punt komt in this.point, het facet in this.face. */
  closest(px, py, pz, maxDist = Infinity) {
    this.face = -1;
    if (!this.faces) return Infinity;
    const box = this.box, cnt = this.count, st = this.start, lf = this.left, idx = this.idx, soup = this.soup;
    let stack = this._stack, sd = this._sd;
    let best = maxDist === Infinity ? Infinity : maxDist * maxDist * (1 + 1e-12), found = -1, bx = 0, by = 0, bz = 0;
    let sp = 0;
    stack[sp] = 0; sd[sp++] = boxDist2(box, 0, px, py, pz);
    while (sp > 0) {
      const n = stack[--sp];
      if (sd[sp] > best) continue;
      const c = cnt[n];
      if (c > 0) {
        for (let i = st[n], e = st[n] + c; i < e; i++) {
          const f = idx[i], d = pointTriangle2(px, py, pz, soup, f * 9);
          if (d < best || (found < 0 && d <= best)) { best = d; found = f; bx = CP[0]; by = CP[1]; bz = CP[2]; }
        }
        continue;
      }
      const l = lf[n], r = l + 1, dl = boxDist2(box, l, px, py, pz), dr = boxDist2(box, r, px, py, pz);
      if (sp + 2 >= stack.length) { const s2 = new Int32Array(stack.length * 2); s2.set(stack); stack = this._stack = s2; const d2 = new Float64Array(sd.length * 2); d2.set(sd); sd = this._sd = d2; }
      // verste eerst op de stapel, zodat de dichtste eerst bekeken wordt
      if (dl <= dr) { if (dr <= best) { stack[sp] = r; sd[sp++] = dr; } if (dl <= best) { stack[sp] = l; sd[sp++] = dl; } }
      else { if (dl <= best) { stack[sp] = l; sd[sp++] = dl; } if (dr <= best) { stack[sp] = r; sd[sp++] = dr; } }
    }
    this.face = found;
    if (found < 0) return Infinity;
    this.point[0] = bx; this.point[1] = by; this.point[2] = bz;
    return Math.sqrt(best);
  }
}

function boxDist2(box, n, px, py, pz) {
  const o = n * 6;
  const dx = px < box[o] ? box[o] - px : px > box[o + 3] ? px - box[o + 3] : 0;
  const dy = py < box[o + 1] ? box[o + 1] - py : py > box[o + 4] ? py - box[o + 4] : 0;
  const dz = pz < box[o + 2] ? box[o + 2] - pz : pz > box[o + 5] ? pz - box[o + 5] : 0;
  return dx * dx + dy * dy + dz * dz;
}

// k-de element (quickselect, Hoare) van idx[lo..hi] op het zwaartepunt langs 'axis'.
function nthElement(idx, cen, axis, lo, hi, k) {
  while (hi > lo) {
    const pivot = cen[idx[(lo + hi) >> 1] * 3 + axis];
    let i = lo, j = hi;
    while (i <= j) {
      while (cen[idx[i] * 3 + axis] < pivot) i++;
      while (cen[idx[j] * 3 + axis] > pivot) j--;
      if (i <= j) { const t = idx[i]; idx[i] = idx[j]; idx[j] = t; i++; j--; }
    }
    if (k <= j) hi = j; else if (k >= i) lo = i; else return;
  }
}

// Eén BVH per soup (de pasvlakcorrectie vraagt 5× over hetzelfde oppervlak).
const CACHE = new WeakMap();
export function bvhFor(soup) {
  let b = CACHE.get(soup);
  if (!b) { b = new TriBVH(soup); CACHE.set(soup, b); }
  return b;
}

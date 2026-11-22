// Waslaag: ondersnijdingen opvullen langs de insteekas (uitblokken) als bewerkbare laag boven de scan.
// De was is per scanpunt een 'lift' (mm) langs de insteekas A. De scan zelf verandert nooit: de plaat wordt op
// scan + was gebouwd, en waar geen was ligt (lift 0) is het pasvlak exact de scan.
// Omdat de lift langs A loopt, verandert de projectie langs A niet: omtreklijnen blijven geldig.
import { weld } from './mesh.js';
import { axisBasis } from './trim.js';

export class WaxLayer {
  constructor(soup, axis) {
    this.soup = soup; this.axis = axis.slice();
    const m = weld(soup, 1e-6);
    this.positions = m.positions; this.indices = m.indices; // indices[soupVertex] = gelaste punt-id
    this.nv = m.positions.length / 3;
    this.lift = new Float32Array(this.nv);
    this.basis = axisBasis(axis);
    const P = this.positions, b = this.basis;
    this.local = new Float32Array(this.nv * 3);
    for (let v = 0; v < this.nv; v++) { const q = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]], [u, w] = b.project(q); this.local[v * 3] = u; this.local[v * 3 + 1] = w; this.local[v * 3 + 2] = b.depth(q); }
    this.history = []; this.future = [];
  }
  /** Automatisch uitblokken: elk punt minimaal tot de omhullende van kegels (halve tophoek = uitblokhoek) rond A. */
  blockout(angle = 2, { maxLift = 8 } = {}) {
    this.snap();
    const L = this.local, n = this.nv, tan = Math.tan(Math.max(0.5, angle) * Math.PI / 180);
    let lo = Infinity, hi = -Infinity; for (let v = 0; v < n; v++) { lo = Math.min(lo, L[v * 3 + 2]); hi = Math.max(hi, L[v * 3 + 2]); }
    const radius = Math.max(0.5, Math.min(maxLift, hi - lo) * tan), cells = new Map(), key = (x, y) => x * 100003 + y;
    for (let v = 0; v < n; v++) { const k = key(Math.floor(L[v * 3] / radius), Math.floor(L[v * 3 + 1] / radius)); let c = cells.get(k); if (!c) cells.set(k, c = []); c.push(v); }
    let changed = 0, max = 0;
    for (let v = 0; v < n; v++) {
      const px = L[v * 3], py = L[v * 3 + 1], h0 = L[v * 3 + 2], cx = Math.floor(px / radius), cy = Math.floor(py / radius);
      let h = h0;
      // de plaat komt van de +A-kant: een punt moet minstens zo hoog liggen als elk hoger punt minus de kegel
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const w of cells.get(key(cx + dx, cy + dy)) || []) {
        const hz = L[w * 3 + 2]; if (hz <= h) continue;
        const d = Math.hypot(L[w * 3] - px, L[w * 3 + 1] - py);
        h = Math.max(h, hz - d / tan);
      }
      // verborgen onder overhangend weefsel: straal langs +A, hoogste treffer boven het punt
      h = Math.max(h, this.coverHeight(px, py, h0));
      const lift = Math.min(maxLift, h - h0);
      this.lift[v] = Math.max(this.lift[v], lift > 0.005 ? lift : 0);
      if (this.lift[v] > 0) { changed++; max = Math.max(max, this.lift[v]); }
    }
    return { changed, max };
  }
  /** Hoogste scanhoogte (langs A) boven (u, w) die hoger ligt dan h0 + 0,01: het punt ligt dan onder een overhang. */
  coverHeight(u, w, h0) {
    if (!this._tri) {
      const L = this.local, f = this.indices, cells = new Map(), c = 1; // driehoeken per cel in het projectievlak
      const soupFaces = f.length / 3;
      for (let i = 0; i < soupFaces; i++) {
        const a = f[i * 3], b = f[i * 3 + 1], d = f[i * 3 + 2];
        const xs = [L[a * 3], L[b * 3], L[d * 3]], ys = [L[a * 3 + 1], L[b * 3 + 1], L[d * 3 + 1]];
        for (let x = Math.floor(Math.min(...xs) / c); x <= Math.floor(Math.max(...xs) / c); x++) for (let y = Math.floor(Math.min(...ys) / c); y <= Math.floor(Math.max(...ys) / c); y++) { const k = x * 100003 + y; let l = cells.get(k); if (!l) cells.set(k, l = []); l.push(i); }
      }
      this._tri = { cells, c };
    }
    const { cells, c } = this._tri, L = this.local, f = this.indices;
    let best = h0;
    for (const i of cells.get(Math.floor(u / c) * 100003 + Math.floor(w / c)) || []) {
      const a = f[i * 3], b = f[i * 3 + 1], d = f[i * 3 + 2];
      const ax = L[a * 3], ay = L[a * 3 + 1], bx = L[b * 3], by = L[b * 3 + 1], cx = L[d * 3], cy = L[d * 3 + 1];
      const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy); if (Math.abs(det) < 1e-12) continue;
      const l1 = ((by - cy) * (u - cx) + (cx - bx) * (w - cy)) / det, l2 = ((cy - ay) * (u - cx) + (ax - cx) * (w - cy)) / det, l3 = 1 - l1 - l2;
      if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
      const z = l1 * L[a * 3 + 2] + l2 * L[b * 3 + 2] + l3 * L[d * 3 + 2];
      if (z > best + 0.01) best = z;
    }
    return best;
  }
  neighbors() {
    if (this._nb) return this._nb;
    const nb = Array.from({ length: this.nv }, () => new Set()), f = this.indices;
    for (let i = 0; i < f.length; i += 3) for (let k = 0; k < 3; k++) { nb[f[i + k]].add(f[i + (k + 1) % 3]); nb[f[i + k]].add(f[i + (k + 2) % 3]); }
    return this._nb = nb.map(s => [...s]);
  }
  grid() {
    if (this._grid) return this._grid;
    const g = new Map(), P = this.positions, c = 1, key = (x, y, z) => (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
    for (let v = 0; v < this.nv; v++) { const k = key(Math.floor(P[v * 3] / c), Math.floor(P[v * 3 + 1] / c), Math.floor(P[v * 3 + 2] / c)); let l = g.get(k); if (!l) g.set(k, l = []); l.push(v); }
    return this._grid = { g, key, c };
  }
  near(center, radius) {
    const { g, key, c } = this.grid(), P = this.positions, out = [], R = Math.ceil(radius / c);
    const cx = Math.floor(center[0] / c), cy = Math.floor(center[1] / c), cz = Math.floor(center[2] / c);
    for (let x = cx - R; x <= cx + R; x++) for (let y = cy - R; y <= cy + R; y++) for (let z = cz - R; z <= cz + R; z++) for (const v of g.get(key(x, y, z)) || []) {
      const d = Math.hypot(P[v * 3] - center[0], P[v * 3 + 1] - center[1], P[v * 3 + 2] - center[2]); if (d < radius) out.push([v, d]);
    }
    return out;
  }
  /** Penseel op de was. center: punt op scan of was. mode: 'add' | 'remove' | 'smooth'. Lift blijft ≥ 0. */
  brush(mode, center, { radius = 3, strength = 0.3 } = {}) {
    const hits = this.near(center, radius), nb = mode === 'smooth' ? this.neighbors() : null, old = mode === 'smooth' ? Float32Array.from(this.lift) : null;
    for (const [v, d] of hits) {
      const w = (1 - (d / radius) ** 2) ** 2;
      if (mode === 'add') this.lift[v] += strength * w;
      else if (mode === 'remove') this.lift[v] = Math.max(0, this.lift[v] - strength * w);
      else { let s = 0; for (const u of nb[v]) s += old[u]; const avg = nb[v].length ? s / nb[v].length : old[v]; this.lift[v] = Math.max(0, old[v] + (avg - old[v]) * Math.min(1, w * 0.8)); }
    }
    return hits.length;
  }
  snap() { this.history.push(Float32Array.from(this.lift)); if (this.history.length > 40) this.history.shift(); this.future = []; }
  undo() { const h = this.history.pop(); if (!h) return false; this.future.push(this.lift); this.lift = h; return true; }
  redo() { const h = this.future.pop(); if (!h) return false; this.history.push(this.lift); this.lift = h; return true; }
  clear() { this.snap(); this.lift.fill(0); }
  stats() { let n = 0, max = 0, vol = 0; for (let v = 0; v < this.nv; v++) if (this.lift[v] > 0) { n++; max = Math.max(max, this.lift[v]); vol += this.lift[v]; } return { points: n, max, mean: n ? vol / n : 0 }; }
  /** Scan + was als soup (zelfde facetvolgorde als de scan). */
  waxedSoup() {
    const out = Float32Array.from(this.soup), A = this.basis.N, idx = this.indices;
    for (let i = 0; i < idx.length; i++) { const l = this.lift[idx[i]]; if (l) { out[i * 3] += A[0] * l; out[i * 3 + 1] += A[1] * l; out[i * 3 + 2] += A[2] * l; } }
    return out;
  }
  /** Alleen de facetten met was (voor de weergave als waslaag). */
  displaySoup(min = 0.01) {
    const all = this.waxedSoup(), idx = this.indices, out = [];
    for (let f = 0; f < idx.length / 3; f++) if (this.lift[idx[f * 3]] > min || this.lift[idx[f * 3 + 1]] > min || this.lift[idx[f * 3 + 2]] > min) for (let k = 0; k < 9; k++) out.push(all[f * 9 + k]);
    return Float32Array.from(out);
  }
}

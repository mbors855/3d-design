// Vrij bewerken van een werkstuk (zoals de wasmes-/freeform-tools in 3Shape en penselen in Photoshop).
// Werkt op een geïndexeerde mesh; de topologie verandert niet, dus een gesloten werkstuk blijft gesloten.
import { weld, toSoup, vertexNormals } from './mesh.js';

export const TOOLS = {
  add: 'Toevoegen', remove: 'Wegnemen', smooth: 'Gladmaken', flatten: 'Vlakmaken', drag: 'Verschuiven',
};
const falloff = t => { const u = 1 - t * t; return u * u; }; // zacht penseel: 1 in het midden, 0 aan de rand

export class Sculpt {
  /** soup: Float32Array; protect(i, x, y, z) → true = punt niet bewegen (bv. pasvlak op de scan) */
  constructor(soup, { protect = null, cell = 2 } = {}) {
    const m = weld(soup, 1e-5);
    this.positions = m.positions; this.indices = m.indices;
    this.count = this.positions.length / 3; this.cell = cell;
    this.locked = new Uint8Array(this.count);
    if (protect) for (let i = 0; i < this.count; i++) if (protect(i, this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2])) this.locked[i] = 1;
    // buren (CSR) voor gladmaken
    const sets = Array.from({ length: this.count }, () => new Set()), f = this.indices;
    for (let i = 0; i < f.length; i += 3) for (let k = 0; k < 3; k++) { const a = f[i + k], b = f[i + (k + 1) % 3]; sets[a].add(b); sets[b].add(a); }
    this.nbStart = new Uint32Array(this.count + 1);
    for (let i = 0; i < this.count; i++) this.nbStart[i + 1] = this.nbStart[i] + sets[i].size;
    this.nb = new Uint32Array(this.nbStart[this.count]);
    for (let i = 0, k = 0; i < this.count; i++) for (const n of sets[i]) this.nb[k++] = n;
    this.normals = vertexNormals(this);
    this.rebuildGrid();
    this.undoStack = []; this.redoStack = [];
  }
  get lockedCount() { let n = 0; for (const v of this.locked) n += v; return n; }

  rebuildGrid() {
    const p = this.positions, inv = 1 / this.cell, map = new Map();
    for (let i = 0; i < this.count; i++) {
      const k = Math.floor(p[i * 3] * inv) + ',' + Math.floor(p[i * 3 + 1] * inv) + ',' + Math.floor(p[i * 3 + 2] * inv);
      let l = map.get(k); if (!l) map.set(k, l = []); l.push(i);
    }
    this.grid = map;
  }
  /** punten binnen straal r rond c, met hun gewicht volgens het zachte penseel */
  query(c, r) {
    const p = this.positions, inv = 1 / this.cell, out = [], r2 = r * r, span = Math.ceil(r * inv) + 1; // +1: punten kunnen sinds de laatste rasterupdate iets verschoven zijn
    const cx = Math.floor(c[0] * inv), cy = Math.floor(c[1] * inv), cz = Math.floor(c[2] * inv);
    for (let x = cx - span; x <= cx + span; x++) for (let y = cy - span; y <= cy + span; y++) for (let z = cz - span; z <= cz + span; z++) {
      const l = this.grid.get(x + ',' + y + ',' + z); if (!l) continue;
      for (const i of l) {
        const dx = p[i * 3] - c[0], dy = p[i * 3 + 1] - c[1], dz = p[i * 3 + 2] - c[2], d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < r2 && !this.locked[i]) out.push(i, falloff(Math.sqrt(d2) / r));
      }
    }
    return out;
  }

  // ---------- geschiedenis ----------
  begin() { this.undoStack.push(this.positions.slice()); if (this.undoStack.length > 30) this.undoStack.shift(); this.redoStack = []; }
  end() { this.normals = vertexNormals(this); this.rebuildGrid(); }
  undo() { const s = this.undoStack.pop(); if (!s) return false; this.redoStack.push(this.positions); this.positions = s; this.end(); return true; }
  redo() { const s = this.redoStack.pop(); if (!s) return false; this.undoStack.push(this.positions); this.positions = s; this.end(); return true; }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  /**
   * Eén penseelstreek op punt c (met oppervlaknormaal n).
   * strength: mm per streek bij toevoegen/wegnemen, 0–1 bij gladmaken/vlakmaken.
   * mirror: { O, X } spiegelvlak (midden van de boog) → dezelfde streek ook aan de andere kant.
   */
  dab(tool, c, n, { radius = 3, strength = 0.15, mirror = null } = {}) {
    let moved = this.#dab(tool, c, n, radius, strength);
    if (mirror) {
      const d = (c[0] - mirror.O[0]) * mirror.X[0] + (c[1] - mirror.O[1]) * mirror.X[1] + (c[2] - mirror.O[2]) * mirror.X[2];
      if (Math.abs(d) > radius * 0.5) {
        const mc = c.map((v, k) => v - 2 * d * mirror.X[k]);
        const dn = n[0] * mirror.X[0] + n[1] * mirror.X[1] + n[2] * mirror.X[2], mn = n.map((v, k) => v - 2 * dn * mirror.X[k]);
        moved += this.#dab(tool, mc, mn, radius, strength);
      }
    }
    if (moved) this.normals = vertexNormals(this);
    return moved;
  }
  #dab(tool, c, n, radius, strength) {
    const p = this.positions, N = this.normals, hits = this.query(c, radius);
    if (!hits.length) return 0;
    if (tool === 'add' || tool === 'remove') {
      const s = (tool === 'add' ? 1 : -1) * strength;
      // gemiddelde normaal in het penseel: voorkomt dat randjes uit elkaar waaieren
      let ax = 0, ay = 0, az = 0;
      for (let k = 0; k < hits.length; k += 2) { const i = hits[k], w = hits[k + 1]; ax += N[i * 3] * w; ay += N[i * 3 + 1] * w; az += N[i * 3 + 2] * w; }
      const l = Math.hypot(ax, ay, az) || 1; ax /= l; ay /= l; az /= l;
      for (let k = 0; k < hits.length; k += 2) { const i = hits[k], w = hits[k + 1] * s; p[i * 3] += ax * w; p[i * 3 + 1] += ay * w; p[i * 3 + 2] += az * w; }
    } else if (tool === 'smooth') {
      const s = Math.min(1, strength), next = new Float32Array(hits.length / 2 * 3);
      for (let k = 0, j = 0; k < hits.length; k += 2, j += 3) {
        const i = hits[k]; let x = 0, y = 0, z = 0; const a = this.nbStart[i], b = this.nbStart[i + 1];
        for (let q = a; q < b; q++) { const v = this.nb[q]; x += p[v * 3]; y += p[v * 3 + 1]; z += p[v * 3 + 2]; }
        const cnt = b - a || 1; next[j] = x / cnt; next[j + 1] = y / cnt; next[j + 2] = z / cnt;
      }
      for (let k = 0, j = 0; k < hits.length; k += 2, j += 3) {
        const i = hits[k], w = hits[k + 1] * s;
        for (let d = 0; d < 3; d++) p[i * 3 + d] += (next[j + d] - p[i * 3 + d]) * w;
      }
    } else if (tool === 'flatten') {
      // vlak door het gewogen zwaartepunt met de gemiddelde normaal
      let cx = 0, cy = 0, cz = 0, nx = 0, ny = 0, nz = 0, W = 0;
      for (let k = 0; k < hits.length; k += 2) { const i = hits[k], w = hits[k + 1]; cx += p[i * 3] * w; cy += p[i * 3 + 1] * w; cz += p[i * 3 + 2] * w; nx += N[i * 3] * w; ny += N[i * 3 + 1] * w; nz += N[i * 3 + 2] * w; W += w; }
      cx /= W; cy /= W; cz /= W; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      const s = Math.min(1, strength);
      for (let k = 0; k < hits.length; k += 2) {
        const i = hits[k], w = hits[k + 1] * s, d = (p[i * 3] - cx) * nx + (p[i * 3 + 1] - cy) * ny + (p[i * 3 + 2] - cz) * nz;
        p[i * 3] -= nx * d * w; p[i * 3 + 1] -= ny * d * w; p[i * 3 + 2] -= nz * d * w;
      }
    }
    return hits.length / 2;
  }

  // Verschuiven: punten vastpakken bij het indrukken en met de muis/vinger meeslepen.
  grab(c, radius, mirror = null) {
    this.grabbed = { base: this.positions.slice(), hits: this.query(c, radius), mirror: null };
    if (mirror) {
      const d = (c[0] - mirror.O[0]) * mirror.X[0] + (c[1] - mirror.O[1]) * mirror.X[1] + (c[2] - mirror.O[2]) * mirror.X[2];
      if (Math.abs(d) > radius * 0.5) this.grabbed.mirror = { X: mirror.X, hits: this.query(c.map((v, k) => v - 2 * d * mirror.X[k]), radius) };
    }
    return this.grabbed.hits.length / 2;
  }
  dragTo(delta) {
    const g = this.grabbed; if (!g) return 0;
    const p = this.positions;
    const apply = (hits, dv) => { for (let k = 0; k < hits.length; k += 2) { const i = hits[k], w = hits[k + 1]; for (let d = 0; d < 3; d++) p[i * 3 + d] = g.base[i * 3 + d] + dv[d] * w; } };
    apply(g.hits, delta);
    if (g.mirror) { const X = g.mirror.X, dd = delta[0] * X[0] + delta[1] * X[1] + delta[2] * X[2]; apply(g.mirror.hits, delta.map((v, k) => v - 2 * dd * X[k])); }
    return g.hits.length / 2;
  }
  release() { this.grabbed = null; this.end(); }

  toSoup() { return toSoup(this); }
}

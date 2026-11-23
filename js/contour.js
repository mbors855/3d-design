// Plaatomtrek: punten op de scan, sluiten, zichtbaar oppervlak selecteren en exact uitsnijden.
import { weld } from './mesh.js';
import { trimByOutline, axisBasis, outlinePolygon } from './trim.js';

export function validContour(polygon) {
  const orientation = (a, b, c) => { const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); return Math.abs(cross) < 1e-7 ? 0 : Math.sign(cross); };
  const within = (a, b, p) => p[0] >= Math.min(a[0], b[0]) - 1e-7 && p[0] <= Math.max(a[0], b[0]) + 1e-7 && p[1] >= Math.min(a[1], b[1]) - 1e-7 && p[1] <= Math.max(a[1], b[1]) + 1e-7;
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1) return false;
    area += a[0] * b[1] - b[0] * a[1];
    for (let j = i + 2; j < polygon.length; j++) {
      if (i === 0 && j === polygon.length - 1) continue;
      const c = polygon[j], d = polygon[(j + 1) % polygon.length];
      const abC = orientation(a, b, c), abD = orientation(a, b, d), cdA = orientation(c, d, a), cdB = orientation(c, d, b);
      if (abC * abD < 0 && cdA * cdB < 0 || !abC && within(a, b, c) || !abD && within(a, b, d) || !cdA && within(c, d, a) || !cdB && within(c, d, b)) return false;
    }
  }
  return Math.abs(area) >= 8;
}

function weights(x, y, a, b, c) {
  const ax = b[0] - a[0], ay = b[1] - a[1], bx = c[0] - a[0], by = c[1] - a[1], det = ax * by - ay * bx;
  if (Math.abs(det) < 1e-10) return null;
  const dx = x - a[0], dy = y - a[1], u = (dx * by - dy * bx) / det, v = (ax * dy - ay * dx) / det;
  return u >= -1e-7 && v >= -1e-7 && u + v <= 1 + 1e-7 ? [1 - u - v, u, v] : null;
}

export function splitContour(polygon) {
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const area = polygon.reduce((s, p, i) => s + cross([0, 0], p, polygon[(i + 1) % polygon.length]), 0);
  const chain = area > 0 ? polygon.slice() : polygon.slice().reverse();
  const pieces = [];
  while (chain.length > 3) {
    let removed = false;
    for (let i = 0; i < chain.length; i++) {
      const a = chain[(i + chain.length - 1) % chain.length], b = chain[i], c = chain[(i + 1) % chain.length];
      if (cross(a, b, c) <= 1e-8) continue;
      if (chain.some(p => p !== a && p !== b && p !== c && weights(p[0], p[1], a, b, c))) continue;
      pieces.push([a, b, c]); chain.splice(i, 1); removed = true; break;
    }
    if (!removed) throw Error('Deze omtrek kan niet worden opgedeeld. Verplaats punten die vrijwel op één lijn liggen.');
  }
  if (cross(...chain) > 1e-8) pieces.push(chain);
  return pieces;
}

// Vult subpixel-facetten aan langs het zichtbare blad zonder over een plooi te gaan.
function completeVisibleSheet(indexed, shape) {
  const p = indexed.positions, f = indexed.indices, proj = shape.project;
  const xs = shape.polygon.map(q => q[0]), ys = shape.polygon.map(q => q[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const near = new Map(), lookup = new Map();
  const P = v => proj(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]);
  for (let i = 0; i < f.length / 3; i++) {
    const a = P(f[i * 3]), b = P(f[i * 3 + 1]), c = P(f[i * 3 + 2]);
    if (Math.max(a[0], b[0], c[0]) < x0 || Math.min(a[0], b[0], c[0]) > x1 || Math.max(a[1], b[1], c[1]) < y0 || Math.min(a[1], b[1], c[1]) > y1) continue;
    const normal = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(normal) < 1e-10) continue;
    const edges = [0, 1, 2].map(k => { const u = f[i * 3 + k], w = f[i * 3 + (k + 1) % 3]; return u < w ? u * 4294967296 + w : w * 4294967296 + u; });
    near.set(i, { normal, edges });
    for (const e of edges) { const l = lookup.get(e); if (l) l.push(i); else lookup.set(e, [i]); }
  }
  const ids = new Set(shape.facets); // weld behoudt de facetvolgorde
  const queue = [...ids];
  for (let q = 0; q < queue.length; q++) {
    const entry = near.get(queue[q]);
    if (!entry) continue;
    for (const e of entry.edges) {
      const nb = lookup.get(e);
      if (!nb || nb.length !== 2) continue;
      for (const id of nb) {
        if (ids.has(id) || entry.normal * near.get(id).normal <= 0) continue;
        ids.add(id); queue.push(id);
      }
    }
  }
  return queue;
}

export function cropSurface(soup, shape) {
  const indexed = weld(soup, 1e-6);
  const faces = completeVisibleSheet(indexed, shape);
  const pieces = splitContour(shape.polygon).map(points => ({ points, x0: Math.min(...points.map(q => q[0])), x1: Math.max(...points.map(q => q[0])), y0: Math.min(...points.map(q => q[1])), y1: Math.max(...points.map(q => q[1])) }));
  const vertices = new Map(), out = [];
  const weldPoint = q => { const key = Math.round(q[0] * 1e6) + ',' + Math.round(q[1] * 1e6) + ',' + Math.round(q[2] * 1e6); if (!vertices.has(key)) vertices.set(key, q); return vertices.get(key); };
  for (const index of faces) {
    const subject = [0, 1, 2].map(k => { const o = index * 9 + k * 3, x = soup[o], y = soup[o + 1], z = soup[o + 2], s = shape.project(x, y, z); return [s[0], s[1], x, y, z]; });
    const sx0 = Math.min(...subject.map(q => q[0])), sx1 = Math.max(...subject.map(q => q[0])), sy0 = Math.min(...subject.map(q => q[1])), sy1 = Math.max(...subject.map(q => q[1]));
    for (const piece of pieces) {
      if (sx1 < piece.x0 || sx0 > piece.x1 || sy1 < piece.y0 || sy0 > piece.y1) continue;
      let clipped = subject;
      for (let i = 0; i < 3 && clipped.length >= 3; i++) {
        const a = piece.points[i], b = piece.points[(i + 1) % 3];
        const side = q => (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]);
        const next = [];
        let prev = clipped.at(-1), dPrev = side(prev);
        for (const q of clipped) {
          const d = side(q);
          if ((dPrev >= 0) !== (d >= 0)) { const t = dPrev / (dPrev - d); next.push(prev.map((v, j) => v + t * (q[j] - v))); }
          if (d >= 0) next.push(q);
          prev = q; dPrev = d;
        }
        clipped = next;
      }
      const ring = clipped.map(q => weldPoint(q.slice(2))).filter((q, i, a) => q !== a[(i + a.length - 1) % a.length]);
      for (let i = 1; i < ring.length - 1; i++) {
        const A = ring[0], B = ring[i], C = ring[i + 1];
        const u = B.map((v, j) => v - A[j]), w = C.map((v, j) => v - A[j]);
        if (Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) > 1e-12) out.push(...A, ...B, ...C);
      }
    }
  }
  if (!out.length) throw Error('Geen scanoppervlak binnen deze omtrek.');
  return Float32Array.from(out);
}

// Omtrekken per werkstuk. Een omtrek is een gesloten lijn van punten op de scan; de uitsnede wordt langs de
// insteekas berekend (trim.js), dus onafhankelijk van het camerastandpunt. Punten kunnen versleept, ingevoegd en
// verwijderd worden; elke wijziging is ongedaan te maken.
export class ContourSet {
  constructor() { this.shapes = new Map(); this.redo = new Map(); this.undoStack = new Map(); }
  get(kind) { return this.shapes.get(kind); }
  ensure(kind) { if (!this.shapes.has(kind)) this.shapes.set(kind, { points: [], closed: false, axis: null, facets: [], surface: null }); return this.shapes.get(kind); }
  snap(kind) { const s = this.ensure(kind), st = this.undoStack.get(kind) ?? []; st.push({ points: s.points.map(p => p.slice()), closed: s.closed, axis: s.axis }); if (st.length > 80) st.shift(); this.undoStack.set(kind, st); this.redo.set(kind, []); }
  invalidate(kind) { const s = this.get(kind); if (s) { s.facets = []; s.surface = null; } }
  addPoint(kind, point, { record = true } = {}) { const s = this.ensure(kind); if (s.closed) throw Error('Omtrek is al gesloten. Versleep punten, of gebruik Terug of Wis.'); if (s.points.length >= 512) throw Error('Maximaal 512 punten.'); if (record) this.snap(kind); s.points.push(point); }
  setPoints(kind, points, axis, { record = true } = {}) { if (record) this.snap(kind); const s = this.ensure(kind); s.points = points.map(p => p.slice()); s.closed = false; this.invalidate(kind); return this.close(kind, axis, { record: false }); }
  setOpen(kind, points, { record = true } = {}) { if (record) this.snap(kind); const s = this.ensure(kind); s.points = points.map(p => p.slice()); s.closed = false; this.invalidate(kind); return s; }
  close(kind, axis, { record = true } = {}) {
    const s = this.get(kind);
    if (!s || s.points.length < 3) throw Error('Zet minimaal drie punten om de omtrek te sluiten.');
    const basis = axisBasis(axis);
    // punten die in de insteekrichting (vrijwel) op elkaar vallen zijn voor de snijlijn overbodig en geven anders
    // een onterechte melding 'kruist zichzelf' (bijv. op een steile wand)
    if (s.points.length > 3) {
      const keep = [];
      for (const p of s.points) { const q = basis.project(p), last = keep.length ? basis.project(keep[keep.length - 1]) : null; if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) >= 0.15) keep.push(p); }
      while (keep.length > 3) { const a = basis.project(keep[keep.length - 1]), b = basis.project(keep[0]); if (Math.hypot(a[0] - b[0], a[1] - b[1]) >= 0.15) break; keep.pop(); }
      if (keep.length >= 3 && keep.length < s.points.length) s.points = keep;
    }
    const poly = outlinePolygon(s.points, basis, { step: 1 });
    if (!validContour(poly.map(q => [q[0] * 10, q[1] * 10]))) throw Error('De omtrek kruist zichzelf of is te klein. Versleep of verwijder het punt waar de lijn kruist.');
    if (record) this.snap(kind);
    s.closed = true; s.axis = axis.slice(); this.invalidate(kind);
    return s;
  }
  /** Punt i verplaatsen (met zachte meeneem-zone langs de lijn); project(p) zet een punt terug op de scan. */
  movePoint(kind, i, to, { radius = 3, project = null } = {}) {
    const s = this.get(kind); if (!s) return;
    const from = s.points[i], d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]], n = s.points.length;
    s.points[i] = to.slice();
    if (radius > 0) for (const dir of [1, -1]) {
      let along = 0, prev = from;
      for (let k = 1; k < n / 2; k++) {
        const j = (i + dir * k + n) % n, q = s.points[j];
        along += Math.hypot(q[0] - prev[0], q[1] - prev[1], q[2] - prev[2]); prev = q;
        if (along >= radius) break;
        const w = (1 - along / radius) ** 2, moved = [q[0] + d[0] * w, q[1] + d[1] * w, q[2] + d[2] * w];
        s.points[j] = project ? project(moved) ?? moved : moved;
      }
    }
    this.invalidate(kind);
  }
  insertPoint(kind, after, point) { const s = this.get(kind); this.snap(kind); s.points.splice(after + 1, 0, point.slice()); this.invalidate(kind); }
  removePoint(kind, i) { const s = this.get(kind); if (s.points.length <= 3) throw Error('Een omtrek heeft minimaal drie punten.'); this.snap(kind); s.points.splice(i, 1); this.invalidate(kind); }
  undo(kind) {
    const st = this.undoStack.get(kind); if (!st?.length) return;
    const s = this.ensure(kind), r = this.redo.get(kind) ?? []; r.push({ points: s.points.map(p => p.slice()), closed: s.closed, axis: s.axis }); this.redo.set(kind, r);
    Object.assign(s, st.pop()); this.invalidate(kind);
  }
  redoStep(kind) {
    const r = this.redo.get(kind); if (!r?.length) return;
    const s = this.ensure(kind), st = this.undoStack.get(kind) ?? []; st.push({ points: s.points.map(p => p.slice()), closed: s.closed, axis: s.axis }); this.undoStack.set(kind, st);
    Object.assign(s, r.pop()); this.invalidate(kind);
  }
  canUndo(kind) { return !!this.undoStack.get(kind)?.length; }
  canRedo(kind) { return !!this.redo.get(kind)?.length; }
  clear(kind) { if (this.get(kind)) this.snap(kind); this.shapes.delete(kind); }
  reset() { this.shapes.clear(); this.redo.clear(); this.undoStack.clear(); }
  /** Uitgesneden oppervlak (exact langs de lijn) en de betrokken facetindices voor de kleuring. */
  surface(kind, soup, splitAt = null) {
    const s = this.get(kind); if (!s?.closed) throw Error('Sluit eerst de omtrek.');
    if (!s.surface || s.splitAt !== splitAt || s.src !== soup) { s.src = soup; const r = trimByOutline(soup, s.points, s.axis, { splitAt }); s.surface = r.soup; s.facets = r.faces; s.trimReport = r.report; s.splitAt = splitAt; s.splitIndex = r.splitIndex; }
    return s.surface;
  }
  toJSON() { return [...this.shapes].map(([kind, s]) => ({ kind, points: s.points, closed: s.closed, axis: s.axis })); }
}

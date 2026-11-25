// Geïndexeerde mesh-algoritmes: lassen, randen, kwaliteit, reparatie, gaten dichten.
import { bvhFor } from './bvh.js';
// Mesh = { positions: Float32Array(v*3), indices: Uint32Array(f*3) }

export function weld(soup, tolerance = 1e-5) {
  // Hoekpunten samenvoegen op een raster van 'tolerance' (afgerond), in volgorde van eerste voorkomen.
  // Hashtabel in typed arrays: zelfde uitkomst als een Map met tekstsleutels, maar 5× sneller en zuiniger (grote scans).
  const inv = 1 / tolerance, corners = soup.length / 3;
  let maxAbs = 0;
  for (let i = 0; i < soup.length; i++) { const a = Math.abs(soup[i]); if (a > maxAbs) maxAbs = a; }
  let size = 16; while (size < corners * 1.5 + 16) size *= 2;
  const mask = size - 1, table = new Int32Array(size).fill(-1);
  const keys = maxAbs * inv < 2e9 ? new Int32Array(corners * 3) : new Float64Array(corners * 3);
  const pos = new Float32Array(corners * 3), indices = new Uint32Array(corners);
  let count = 0;
  for (let c = 0; c < corners; c++) {
    const x = soup[c * 3], y = soup[c * 3 + 1], z = soup[c * 3 + 2];
    const kx = Math.round(x * inv), ky = Math.round(y * inv), kz = Math.round(z * inv);
    let h = (Math.imul(kx | 0, 73856093) ^ Math.imul(ky | 0, 19349663) ^ Math.imul(kz | 0, 83492791)) & mask, id;
    for (;;) {
      id = table[h];
      if (id < 0) { id = count++; table[h] = id; keys[id * 3] = kx; keys[id * 3 + 1] = ky; keys[id * 3 + 2] = kz; pos[id * 3] = x; pos[id * 3 + 1] = y; pos[id * 3 + 2] = z; break; }
      if (keys[id * 3] === kx && keys[id * 3 + 1] === ky && keys[id * 3 + 2] === kz) break;
      h = (h + 1) & mask;
    }
    indices[c] = id;
  }
  return { positions: pos.slice(0, count * 3), indices };
}

export function toSoup(mesh) {
  const { positions: p, indices: f } = mesh, out = new Float32Array(f.length * 3);
  for (let i = 0; i < f.length; i++) { const v = f[i] * 3; out[i * 3] = p[v]; out[i * 3 + 1] = p[v + 1]; out[i * 3 + 2] = p[v + 2]; }
  return out;
}

export function faceNormal(p, f, i, out = [0, 0, 0]) {
  const a = f[i * 3] * 3, b = f[i * 3 + 1] * 3, c = f[i * 3 + 2] * 3;
  const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
  const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
  out[0] = uy * vz - uz * vy; out[1] = uz * vx - ux * vz; out[2] = ux * vy - uy * vx;
  return out;
}

// Randentabel in typed arrays (v68): per ongerichte rand de eerste richting (from → to), het aantal facetten, de eerste
// twee facetten en of een later facet dezelfde richting heeft (omgekeerde buur). Randen genummerd in volgorde van
// eerste voorkomen; faceEdge[f*3+k] = rand van facetzijde k. Veel sneller dan een Map met een object per rand.
export class EdgeTable {
  constructor(mesh) {
    const f = mesh.indices, nh = f.length;
    let size = 16; while (size < nh * 1.4 + 16) size *= 2;
    const mask = size - 1, table = new Int32Array(size).fill(-1);
    const lo = new Int32Array(nh), hi = new Int32Array(nh), from = new Int32Array(nh), to = new Int32Array(nh);
    const count = new Int32Array(nh), f0 = new Int32Array(nh), f1 = new Int32Array(nh), same = new Uint8Array(nh), faceEdge = new Int32Array(nh);
    let n = 0, extra = null;
    for (let i = 0; i < nh; i++) {
      const face = (i / 3) | 0, k = i - face * 3, a = f[i], b = f[face * 3 + (k + 1) % 3];
      const l = a < b ? a : b, h2 = a < b ? b : a;
      let h = (Math.imul(l, 73856093) ^ Math.imul(h2, 19349663)) & mask, id;
      for (;;) {
        id = table[h];
        if (id < 0) { id = n++; table[h] = id; lo[id] = l; hi[id] = h2; from[id] = a; to[id] = b; count[id] = 1; f0[id] = face; f1[id] = -1; break; }
        if (lo[id] === l && hi[id] === h2) {
          const c = ++count[id];
          if (c === 2) f1[id] = face; else { extra ??= new Map(); let x = extra.get(id); if (!x) extra.set(id, x = []); x.push(face); }
          if (from[id] === a) same[id] = 1;
          break;
        }
        h = (h + 1) & mask;
      }
      faceEdge[i] = id;
    }
    Object.assign(this, { n, from, to, count, f0, f1, same, faceEdge, extra });
  }
  faces(e) { const c = this.count[e]; return c === 1 ? [this.f0[e]] : c === 2 ? [this.f0[e], this.f1[e]] : [this.f0[e], this.f1[e], ...this.extra.get(e)]; }
  // zelfde vorm als vroeger (edgeMap): { from, to, count, faces, sameDir }
  *values() { for (let e = 0; e < this.n; e++) yield { from: this.from[e], to: this.to[e], count: this.count[e], faces: this.faces(e), sameDir: !!this.same[e] }; }
  get size() { return this.n; }
}
export function edgeTable(mesh) { return new EdgeTable(mesh); }
// Randstatistiek (compatibel): iterabel via values() met { from, to, count, faces, sameDir } per rand.
export function edgeMap(mesh) { return new EdgeTable(mesh); }

export function boundaryLoops(mesh, edges = null) {
  const T = edges instanceof EdgeTable ? edges : edges ? null : new EdgeTable(mesh);
  const nv = mesh.positions.length / 3;
  // next[v] = volgend randpunt; starts in volgorde van eerste voorkomen (zelfde lussen en volgorde als voorheen)
  const next = new Int32Array(nv).fill(-1), starts = [];
  let branching = false;
  const add = (a, b) => { if (next[a] >= 0) branching = true; else { next[a] = b; starts.push(a); } };
  if (T) { for (let e = 0; e < T.n; e++) if (T.count[e] === 1) add(T.from[e], T.to[e]); }
  else for (const e of edges.values()) if (e.count === 1) add(e.from, e.to);
  const loops = [], seen = new Uint8Array(nv);
  for (const start of starts) {
    if (seen[start]) continue;
    const loop = [];
    let v = start, ok = true;
    while (true) {
      if (seen[v]) { ok = v === start; break; }
      seen[v] = 1; loop.push(v);
      const n = next[v];
      if (n < 0) { ok = false; break; }
      v = n;
      if (v === start) break;
    }
    if (ok && loop.length >= 3) loops.push(loop);
    else branching = true;
  }
  return { loops, branching };
}

// Afstand langs het oppervlak van elk punt tot de gegeven randlussen, tot maxDist (verder: Infinity). Voor de
// afsluitzone langs de plaatrand en 'tot X mm binnen de scanrand'. Dijkstra over de ribben, aangevuld met de
// driehoeksupdate van fast marching (rechte golffront door een driehoek): over de ribben alleen zou een afstand
// schuin op het scanraster tot ~40 % te groot uitvallen, zo blijft dat enkele procenten.
export function rimDistances(mesh, loops, maxDist = Infinity) {
  const p = mesh.positions, f = mesh.indices, n = p.length / 3;
  const vs = new Int32Array(n + 1); for (let i = 0; i < f.length; i++) vs[f[i] + 1]++;
  for (let v = 0; v < n; v++) vs[v + 1] += vs[v];
  const vf = new Int32Array(f.length), fill = vs.slice(0, n); for (let i = 0; i < f.length; i++) vf[fill[f[i]]++] = (i / 3) | 0;
  // Float64: met Float32 kon een afgeronde afstand kleiner zijn dan de waarde in de heap, en werd dat punt overgeslagen
  const dist = new Float64Array(n).fill(Infinity), done = new Uint8Array(n), src = new Uint8Array(n);
  let hd = new Float64Array(1024), hv = new Int32Array(1024), size = 0;
  const push = (d, v) => {
    if (size === hd.length) { const a = new Float64Array(size * 2); a.set(hd); hd = a; const b = new Int32Array(size * 2); b.set(hv); hv = b; }
    let i = size++;
    while (i > 0) { const par = (i - 1) >> 1; if (hd[par] <= d) break; hd[i] = hd[par]; hv[i] = hv[par]; i = par; }
    hd[i] = d; hv[i] = v;
  };
  const pop = () => {
    const v = hv[0], d = hd[0], ld = hd[--size], lv = hv[size];
    let i = 0;
    for (;;) { let c = 2 * i + 1; if (c >= size) break; if (c + 1 < size && hd[c + 1] < hd[c]) c++; if (hd[c] >= ld) break; hd[i] = hd[c]; hv[i] = hv[c]; i = c; }
    hd[i] = ld; hv[i] = lv;
    return [d, v];
  };
  const len = (a, b) => Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);
  const relax = (w, nd) => { if (nd < dist[w] && nd <= maxDist) { dist[w] = nd; push(nd, w); } };
  // C bijwerken vanuit A en B (beide definitief): golffront door AB, vlak uitgevouwen
  const tri = (A, B, C) => {
    const c = len(A, B); if (c < 1e-12) return;
    const dA = dist[A], dB = dist[B], b2 = len(A, C) ** 2, a2 = len(B, C) ** 2;
    const cx = (b2 - a2 + c * c) / (2 * c), cy = Math.sqrt(Math.max(0, b2 - cx * cx)); if (cy < 1e-12) return;
    let d;
    if (src[A] && src[B]) { if (!rimEdge.has(A < B ? A * 4294967296 + B : B * 4294967296 + A) || cx < 0 || cx > c) return; d = cy; } // randribbe: afstand tot de randlijn
    else {
      const sx = (dA * dA - dB * dB + c * c) / (2 * c), s2 = dA * dA - sx * sx; if (s2 < 0) return;
      const sy = -Math.sqrt(s2), t = -sy / (cy - sy), x = sx + t * (cx - sx);
      if (x < 0 || x > c) return; // het rechte pad gaat niet door AB: dan geldt de ribbe
      d = Math.hypot(cx - sx, cy - sy);
      if (d < Math.max(dA, dB)) return; // het front bereikt C niet vóór A en B (stompe driehoek)
    }
    relax(C, d);
  };
  const rimEdge = new Set();
  for (const loop of loops) for (let i = 0; i < loop.length; i++) { const v = loop[i], w = loop[(i + 1) % loop.length]; rimEdge.add(v < w ? v * 4294967296 + w : w * 4294967296 + v); dist[v] = 0; src[v] = 1; push(0, v); }
  while (size) {
    const [d, v] = pop();
    if (done[v] || d > dist[v]) continue;
    done[v] = 1;
    for (let j = vs[v]; j < vs[v + 1]; j++) {
      const t = vf[j], a = f[t * 3], b = f[t * 3 + 1], c = f[t * 3 + 2];
      const [o1, o2] = a === v ? [b, c] : b === v ? [c, a] : [a, b];
      if (!done[o1]) relax(o1, d + len(v, o1));
      if (!done[o2]) relax(o2, d + len(v, o2));
      if (done[o1] && !done[o2]) tri(v, o1, o2);
      else if (done[o2] && !done[o1]) tri(v, o2, o1);
    }
  }
  return dist;
}

export function loopLength(mesh, loop) {
  const p = mesh.positions;
  let s = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i] * 3, b = loop[(i + 1) % loop.length] * 3;
    s += Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]);
  }
  return s;
}

export function components(mesh) {
  const parent = new Int32Array(mesh.positions.length / 3).map((_, i) => i);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const f = mesh.indices;
  for (let i = 0; i < f.length; i += 3) {
    const a = find(f[i]), b = find(f[i + 1]), c = find(f[i + 2]);
    parent[b] = a; parent[find(c)] = a;
  }
  const roots = new Set();
  for (let i = 0; i < f.length; i++) roots.add(find(f[i]));
  return roots.size;
}

export function quality(mesh) {
  const p = mesh.positions, f = mesh.indices, n = [0, 0, 0];
  let area = 0, volume = 0, degenerate = 0;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let j = 0; j < 3; j++) { min[j] = Math.min(min[j], p[i + j]); max[j] = Math.max(max[j], p[i + j]); }
  for (let i = 0; i < f.length / 3; i++) {
    faceNormal(p, f, i, n);
    const a2 = Math.hypot(n[0], n[1], n[2]);
    area += a2 / 2;
    if (a2 < 1e-12) degenerate++;
    const a = f[i * 3] * 3;
    volume += (p[a] * n[0] + p[a + 1] * n[1] + p[a + 2] * n[2]) / 6;
  }
  const edges = new EdgeTable(mesh);
  let open = 0, nonManifold = 0, flipped = 0;
  for (let e = 0; e < edges.n; e++) {
    const c = edges.count[e];
    if (c === 1) open++;
    else if (c > 2) nonManifold++;
    else if (edges.same[e]) flipped++;
  }
  const { loops } = boundaryLoops(mesh, edges);
  return {
    faces: f.length / 3, vertices: p.length / 3, area, volume, signedVolume: volume,
    open, holes: loops.length, nonManifold, flipped, degenerate, components: components(mesh),
    dimensions: max.map((v, i) => v - min[i]),
    watertight: open === 0 && nonManifold === 0 && degenerate === 0 && flipped === 0,
  };
}

// Verwijdert ongeldige, platte en dubbele facetten en ongebruikte punten.
export function clean(mesh, areaEps = 1e-10) {
  const p = mesh.positions, f = mesh.indices, nf = f.length / 3, keep = new Uint32Array(f.length);
  // dubbele facetten (zelfde drie punten, elke volgorde): hashtabel op het gesorteerde drietal
  let size = 16; while (size < nf * 1.5 + 16) size *= 2;
  const mask = size - 1, table = new Int32Array(size).fill(-1), A = new Int32Array(nf), B = new Int32Array(nf), C = new Int32Array(nf);
  let flat = 0, duplicate = 0, kept = 0, m = 0;
  for (let i = 0; i < nf; i++) {
    const a = f[i * 3], b = f[i * 3 + 1], c = f[i * 3 + 2];
    if (a === b || b === c || a === c) { flat++; continue; }
    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    const ux = p[b * 3] - ax, uy = p[b * 3 + 1] - ay, uz = p[b * 3 + 2] - az, vx = p[c * 3] - ax, vy = p[c * 3 + 1] - ay, vz = p[c * 3 + 2] - az;
    if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2 < areaEps) { flat++; continue; }
    let x = a, y = b, z = c, t;
    if (x > y) { t = x; x = y; y = t; } if (y > z) { t = y; y = z; z = t; } if (x > y) { t = x; x = y; y = t; }
    let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & mask, dup = false;
    for (;;) { const id = table[h]; if (id < 0) { table[h] = m; A[m] = x; B[m] = y; C[m] = z; m++; break; } if (A[id] === x && B[id] === y && C[id] === z) { dup = true; break; } h = (h + 1) & mask; }
    if (dup) { duplicate++; continue; }
    keep[kept++] = a; keep[kept++] = b; keep[kept++] = c;
  }
  return { mesh: compact({ positions: p, indices: keep.subarray(0, kept) }), flat, duplicate };
}

export function compact(mesh) {
  const nv = mesh.positions.length / 3, remap = new Int32Array(nv).fill(-1), I = mesh.indices, P = mesh.positions;
  const idx = new Uint32Array(I.length), pos = new Float32Array(Math.min(nv, I.length) * 3);
  let n = 0;
  for (let i = 0; i < I.length; i++) {
    const v = I[i];
    if (remap[v] < 0) { remap[v] = n; pos[n * 3] = P[v * 3]; pos[n * 3 + 1] = P[v * 3 + 1]; pos[n * 3 + 2] = P[v * 3 + 2]; n++; }
    idx[i] = remap[v];
  }
  return { positions: pos.slice(0, n * 3), indices: idx };
}

// Maakt de facetoriëntatie consistent per samenhangend deel (BFS over gedeelde randen).
export function orient(mesh) {
  const f = Uint32Array.from(mesh.indices), faceCount = f.length / 3;
  const T = new EdgeTable({ positions: mesh.positions, indices: f });
  // buren per facet in volgorde van randnummer (zoals vroeger de Map-volgorde)
  const nb = new Int32Array(faceCount * 3).fill(-1), ord = [0, 0, 0];
  for (let face = 0; face < faceCount; face++) {
    ord[0] = T.faceEdge[face * 3]; ord[1] = T.faceEdge[face * 3 + 1]; ord[2] = T.faceEdge[face * 3 + 2];
    ord.sort((x, y) => x - y);
    let k = 0;
    for (let j = 0; j < 3; j++) { const e = ord[j]; if (j && e === ord[j - 1]) continue; if (T.count[e] === 2) nb[face * 3 + k++] = T.f0[e] === face ? T.f1[e] : T.f0[e]; }
  }
  const has = (face, a, b) => { for (let k = 0; k < 3; k++) if (f[face * 3 + k] === a && f[face * 3 + (k + 1) % 3] === b) return true; return false; };
  const visited = new Uint8Array(faceCount), queue = new Int32Array(faceCount);
  let flips = 0;
  for (let s = 0; s < faceCount; s++) {
    if (visited[s]) continue;
    visited[s] = 1;
    let q = 0; queue[q++] = s;
    while (q) {
      const face = queue[--q];
      for (let j = 0; j < 3; j++) {
        const other = nb[face * 3 + j]; if (other < 0) break;
        if (visited[other]) continue;
        // Gedeelde rand moet in tegengestelde richting voorkomen.
        let conflict = false;
        for (let k = 0; k < 3; k++) {
          const a = f[face * 3 + k], b = f[face * 3 + (k + 1) % 3];
          if (has(other, a, b)) { conflict = true; break; }
        }
        if (conflict) { const t = f[other * 3 + 1]; f[other * 3 + 1] = f[other * 3 + 2]; f[other * 3 + 2] = t; flips++; }
        visited[other] = 1; queue[q++] = other;
      }
    }
  }
  return { mesh: { positions: mesh.positions, indices: f }, flips };
}

export function flipAll(mesh) {
  const f = Uint32Array.from(mesh.indices);
  for (let i = 0; i < f.length; i += 3) { const t = f[i + 1]; f[i + 1] = f[i + 2]; f[i + 2] = t; }
  return { positions: mesh.positions, indices: f };
}

// Triangulatie van een randlus: oor-knippen in het best passende vlak, anders een waaier vanuit het zwaartepunt.
function triangulateLoop(positions, loop) {
  const n = loop.length, P = i => [positions[loop[i] * 3], positions[loop[i] * 3 + 1], positions[loop[i] * 3 + 2]];
  const pts = loop.map((_, i) => P(i));
  const c = pts.reduce((s, q) => s.map((v, k) => v + q[k] / n), [0, 0, 0]);
  // Newell-normaal van de lus.
  const nn = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    nn[0] += (a[1] - b[1]) * (a[2] + b[2]); nn[1] += (a[2] - b[2]) * (a[0] + b[0]); nn[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const ln = Math.hypot(...nn);
  if (ln > 1e-12) {
    const N = nn.map(v => v / ln);
    const U = Math.abs(N[0]) < .9 ? [0, -N[2], N[1]] : [-N[2], 0, N[0]];
    const lu = Math.hypot(...U); for (let k = 0; k < 3; k++) U[k] /= lu;
    const V = [N[1] * U[2] - N[2] * U[1], N[2] * U[0] - N[0] * U[2], N[0] * U[1] - N[1] * U[0]];
    const q = pts.map(p => { const d = p.map((v, k) => v - c[k]); return [d[0] * U[0] + d[1] * U[1] + d[2] * U[2], d[0] * V[0] + d[1] * V[1] + d[2] * V[2]]; });
    const tris = earClip(q);
    if (tris) return { tris: tris.map(t => t.map(i => loop[i])), extra: null };
  }
  return { tris: null, extra: c };
}

function earClip(q) {
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  let area = 0;
  for (let i = 0; i < q.length; i++) area += cross([0, 0], q[i], q[(i + 1) % q.length]);
  const sign = Math.sign(area) || 1;
  const idx = q.map((_, i) => i), out = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < q.length * q.length) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = q[ia], b = q[ib], c = q[ic];
      if (sign * cross(a, b, c) <= 1e-12) continue;
      let inside = false;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        const p = q[j];
        if (sign * cross(a, b, p) >= 0 && sign * cross(b, c, p) >= 0 && sign * cross(c, a, p) >= 0) { inside = true; break; }
      }
      if (inside) continue;
      out.push([ia, ib, ic]); idx.splice(i, 1); cut = true; break;
    }
    if (!cut) return null;
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  return out;
}

// Dicht randlussen. keepLargest laat de langste lus open (buitenrand van een kaakscan).
export function fillHoles(mesh, { keepLargest = false, maxEdges = Infinity } = {}) {
  const { loops } = boundaryLoops(mesh);
  let target = loops;
  if (keepLargest && loops.length) {
    const lengths = loops.map(l => loopLength(mesh, l));
    const largest = lengths.indexOf(Math.max(...lengths));
    target = loops.filter((_, i) => i !== largest);
  }
  target = target.filter(l => l.length <= maxEdges);
  if (!target.length) return { mesh, filled: 0, left: loops.length };
  const pos = Array.from(mesh.positions), idx = Array.from(mesh.indices);
  for (const loop of target) {
    // Rand a→b bestaat in de mesh; de vulling gebruikt b→a.
    const rev = loop.slice().reverse();
    const { tris, extra } = triangulateLoop(mesh.positions, rev);
    if (tris) for (const t of tris) idx.push(...t);
    else {
      const c = pos.length / 3; pos.push(...extra);
      for (let i = 0; i < rev.length; i++) idx.push(rev[i], rev[(i + 1) % rev.length], c);
    }
  }
  return { mesh: { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }, filled: target.length, left: loops.length - target.length };
}

// Maakt een open oppervlak geschikt als plaatbasis: alleen het grootste via randen verbonden stuk,
// geen vlinderpunten (rand raakt zichzelf), geen niet-manifold randen en geen losse 'oren' aan de rand.
export function tidySheet(mesh, { maxPasses = 25 } = {}) {
  let f = Uint32Array.from(mesh.indices), removed = 0, passes = 0;
  const p = mesh.positions, nv = p.length / 3, bc = new Int32Array(nv);
  for (; passes < maxPasses; passes++) {
    const T = new EdgeTable({ positions: p, indices: f }), n = f.length / 3;
    const bad = new Uint8Array(n), faceBoundary = new Uint8Array(n);
    bc.fill(0);
    for (let e = 0; e < T.n; e++) {
      const c = T.count[e];
      if (c > 2) { bad[T.f0[e]] = 1; bad[T.f1[e]] = 1; for (const x of T.extra.get(e)) bad[x] = 1; }
      else if (c === 1) { bc[T.from[e]]++; bc[T.to[e]]++; faceBoundary[T.f0[e]]++; }
    }
    let bowtie = false; for (let v = 0; v < nv; v++) if (bc[v] > 2) { bowtie = true; break; }
    for (let i = 0; i < n; i++) {
      if (faceBoundary[i] >= 2) bad[i] = 1; // los 'oortje' aan de rand: geeft platte driehoeken bij het dichten
      else if (bowtie && (bc[f[i * 3]] > 2 || bc[f[i * 3 + 1]] > 2 || bc[f[i * 3 + 2]] > 2)) bad[i] = 1;
    }
    // grootste stuk dat via gedeelde (manifold) randen samenhangt
    const parent = new Int32Array(n); for (let i = 0; i < n; i++) parent[i] = i;
    const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (let e = 0; e < T.n; e++) if (T.count[e] === 2 && !bad[T.f0[e]] && !bad[T.f1[e]]) parent[find(T.f0[e])] = find(T.f1[e]);
    const size = new Int32Array(n), order = [];
    for (let i = 0; i < n; i++) if (!bad[i]) { const r = find(i); if (!size[r]) order.push(r); size[r]++; }
    let best = -1, bestSize = 0; for (const r of order) if (size[r] > bestSize) { best = r; bestSize = size[r]; }
    const keep = new Uint32Array(f.length); let k = 0;
    for (let i = 0; i < n; i++) if (!bad[i] && find(i) === best) { keep[k++] = f[i * 3]; keep[k++] = f[i * 3 + 1]; keep[k++] = f[i * 3 + 2]; }
    const dropped = n - k / 3;
    removed += dropped; f = keep.slice(0, k);
    if (!dropped) break;
  }
  return { mesh: compact({ positions: p, indices: f }), removed, passes };
}

// Volledige reparatie: lassen, reinigen, oriënteren, gaten dichten en naar buiten richten.
export function repair(soup, { fill = true, keepLargest = false, tolerance = 1e-4 } = {}) {
  let invalid = 0;
  const finite = [];
  for (let i = 0; i < soup.length; i += 9) {
    let ok = true;
    for (let j = 0; j < 9; j++) if (!Number.isFinite(soup[i + j])) { ok = false; break; }
    if (ok) for (let j = 0; j < 9; j++) finite.push(soup[i + j]); else invalid++;
  }
  let mesh = weld(Float32Array.from(finite), tolerance);
  const c = clean(mesh); mesh = c.mesh;
  const o = orient(mesh); mesh = o.mesh;
  let filled = 0;
  if (fill) { const h = fillHoles(mesh, { keepLargest }); mesh = h.mesh; filled = h.filled; }
  const q = quality(mesh);
  let outward = false;
  if (q.open === 0 && q.signedVolume < 0) { mesh = flipAll(mesh); outward = true; }
  return { mesh, report: { invalid, flat: c.flat, duplicate: c.duplicate, flips: o.flips, filled, outward, before: soup.length / 9, after: mesh.indices.length / 3 } };
}

export function vertexNormals(mesh) {
  const p = mesh.positions, f = mesh.indices, out = new Float32Array(p.length), n = [0, 0, 0];
  for (let i = 0; i < f.length / 3; i++) {
    faceNormal(p, f, i, n);
    for (let k = 0; k < 3; k++) { const v = f[i * 3 + k] * 3; out[v] += n[0]; out[v + 1] += n[1]; out[v + 2] += n[2]; }
  }
  for (let i = 0; i < out.length; i += 3) { const l = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1; out[i] /= l; out[i + 1] /= l; out[i + 2] /= l; }
  return out;
}

// Transformaties op een soup (in-place kopie).
export function transformSoup(soup, fn) {
  const out = new Float32Array(soup.length), v = [0, 0, 0];
  for (let i = 0; i < soup.length; i += 3) { v[0] = soup[i]; v[1] = soup[i + 1]; v[2] = soup[i + 2]; fn(v); out[i] = v[0]; out[i + 1] = v[1]; out[i + 2] = v[2]; }
  return out;
}

export function flipSoup(soup) {
  const out = Float32Array.from(soup);
  for (let i = 0; i < out.length; i += 9) for (let j = 0; j < 3; j++) { const t = out[i + 3 + j]; out[i + 3 + j] = out[i + 6 + j]; out[i + 6 + j] = t; }
  return out;
}

export function applyMatrixToSoup(soup, m) {
  // m: kolom-major 4x4 (Three.js elements)
  const e = m;
  const out = transformSoup(soup, v => {
    const x = v[0], y = v[1], z = v[2];
    v[0] = e[0] * x + e[4] * y + e[8] * z + e[12];
    v[1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    v[2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  });
  const det = e[0] * (e[5] * e[10] - e[9] * e[6]) - e[4] * (e[1] * e[10] - e[9] * e[2]) + e[8] * (e[1] * e[6] - e[5] * e[2]);
  return det < 0 ? flipSoup(out) : out;
}

// Afstand van punten tot een oppervlak (soup), exact punt-tot-driehoek, met een rasterversnelling.
// Geeft Float32Array met afstanden (Infinity als niets binnen maxDist ligt).
// Afstand van elk punt tot een oppervlak (soup), exact binnen maxDist (verder weg: Infinity). Met een BVH:
// v67 en eerder zochten in een raster van 1 mm en testten per punt duizenden driehoeken, wat bij een afdrukruimte
// van 2 mm op een scan van 300.000 facetten minutenlang duurde (pagina reageert niet).
// bound (optioneel): per punt een bovengrens voor de afstand (bv. tot het scanpunt waar het punt vandaan komt);
// dat maakt het zoeken nog veel kleiner. closest (optioneel): Float32Array(3n) voor de dichtstbijzijnde punten.
export function pointToSurfaceDistances(points, soup, { maxDist = 6, closest = null, bound = null } = {}) {
  const n = points.length / 3, out = new Float32Array(n).fill(Infinity);
  if (!soup.length || !n) return out;
  const bvh = bvhFor(soup), q = bvh.point;
  for (let i = 0; i < n; i++) {
    const lim = bound && bound[i] < maxDist ? bound[i] * (1 + 1e-6) + 1e-6 : maxDist;
    let d = bvh.closest(points[i * 3], points[i * 3 + 1], points[i * 3 + 2], lim);
    if (d === Infinity && lim < maxDist) d = bvh.closest(points[i * 3], points[i * 3 + 1], points[i * 3 + 2], maxDist); // bovengrens klopte niet
    out[i] = d;
    if (closest && d !== Infinity) { closest[i * 3] = q[0]; closest[i * 3 + 1] = q[1]; closest[i * 3 + 2] = q[2]; }
  }
  return out;
}

// Pasvlak-nauwkeurigheid: afstand van de scanpunten (binnen de omtrek) tot de plaat, vergeleken met de ingestelde ruimte.
// rimSeal (mm): punten in de afsluitzone langs de rand (afstand loopt daar bewust naar 0) tellen niet mee voor de afdrukruimte.
export function fitReport(surfaceSoup, plateSoup, gap = 0, { skipFrom = null, sample = 4000, rimSeal = 0, rimBand = 0 } = {}) {
  const n = (skipFrom ?? surfaceSoup.length / 9) * 3, stride = Math.max(1, Math.floor(n / sample));
  let zone = null;
  // rimBand (v69): smalle strook langs de rand die bewust is gladgestreken (kartelige scanrand) telt niet mee
  if ((rimSeal > 0 && gap > 0) || rimBand > 0) {
    const m = weld(surfaceSoup, 1e-5), { loops } = boundaryLoops(m);
    // de afsluitzone beïnvloedt de afstand tot ongeveer 'gap' verder naar binnen (schuine binnenkant)
    const reach = Math.max(rimSeal > 0 && gap > 0 ? rimSeal + gap : 0, rimBand);
    if (loops.length) { const lens = loops.map(l => loopLength(m, l)), dr = rimDistances(m, [loops[lens.indexOf(Math.max(...lens))]], reach); zone = v => dr[m.indices[v]] < reach; }
  }
  const pts = []; for (let v = 0; v < n; v += stride) if (!zone || !zone(v)) pts.push(surfaceSoup[v * 3], surfaceSoup[v * 3 + 1], surfaceSoup[v * 3 + 2]);
  const d = pointToSurfaceDistances(Float32Array.from(pts), plateSoup, { maxDist: gap + 3 });
  const fin = Array.from(d).filter(Number.isFinite);
  const dev = fin.map(x => Math.abs(x - gap)).sort((a, b) => a - b), close = fin.map(x => Math.max(0, gap - x)).sort((a, b) => a - b);
  if (!dev.length) return null;
  const q = (a, f) => a[Math.min(a.length - 1, Math.floor(a.length * f))];
  // 'close' = dichter bij de scan dan de ingestelde ruimte (te weinig afdrukruimte); verder weg = overbrugd (smalle plooi)
  return { n: dev.length, median: q(dev, 0.5), p95: q(dev, 0.95), p99: q(dev, 0.99), max: dev.at(-1), within: dev.filter(x => x <= 0.05).length / dev.length,
    closeP99: q(close, 0.99), closeMax: close.at(-1), bridged: fin.filter(x => x > gap + 0.05).length / fin.length };
}

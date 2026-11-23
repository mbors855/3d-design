// Geïndexeerde mesh-algoritmes: lassen, randen, kwaliteit, reparatie, gaten dichten.
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

const edgeKey = (a, b) => a < b ? a * 4294967296 + b : b * 4294967296 + a;

export function faceNormal(p, f, i, out = [0, 0, 0]) {
  const a = f[i * 3] * 3, b = f[i * 3 + 1] * 3, c = f[i * 3 + 2] * 3;
  const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
  const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
  out[0] = uy * vz - uz * vy; out[1] = uz * vx - ux * vz; out[2] = ux * vy - uy * vx;
  return out;
}

// Randstatistiek: per ongerichte rand het aantal facetten en de richting.
export function edgeMap(mesh) {
  const f = mesh.indices, map = new Map();
  for (let i = 0; i < f.length; i += 3) for (let k = 0; k < 3; k++) {
    const a = f[i + k], b = f[i + (k + 1) % 3], key = edgeKey(a, b);
    const e = map.get(key);
    if (e) { e.count++; e.faces.push(i / 3); if (e.from === a) e.sameDir = true; }
    else map.set(key, { from: a, to: b, count: 1, faces: [i / 3], sameDir: false });
  }
  return map;
}

export function boundaryLoops(mesh, edges = edgeMap(mesh)) {
  const next = new Map();
  let branching = false;
  for (const e of edges.values()) if (e.count === 1) {
    if (next.has(e.from)) branching = true;
    else next.set(e.from, e.to);
  }
  const loops = [], seen = new Set();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    let v = start, ok = true;
    while (true) {
      if (seen.has(v)) { ok = v === start; break; }
      seen.add(v); loop.push(v);
      const n = next.get(v);
      if (n === undefined) { ok = false; break; }
      v = n;
      if (v === start) break;
    }
    if (ok && loop.length >= 3) loops.push(loop);
    else branching = true;
  }
  return { loops, branching };
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
  const edges = edgeMap(mesh);
  let open = 0, nonManifold = 0, flipped = 0;
  for (const e of edges.values()) {
    if (e.count === 1) open++;
    else if (e.count > 2) nonManifold++;
    else if (e.sameDir) flipped++;
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
  const p = mesh.positions, f = mesh.indices, keep = [], seen = new Set(), n = [0, 0, 0];
  let flat = 0, duplicate = 0;
  for (let i = 0; i < f.length / 3; i++) {
    const a = f[i * 3], b = f[i * 3 + 1], c = f[i * 3 + 2];
    if (a === b || b === c || a === c) { flat++; continue; }
    faceNormal(p, f, i, n);
    if (Math.hypot(n[0], n[1], n[2]) / 2 < areaEps) { flat++; continue; }
    const s = [a, b, c].sort((x, y) => x - y).join(',');
    if (seen.has(s)) { duplicate++; continue; }
    seen.add(s); keep.push(a, b, c);
  }
  return { mesh: compact({ positions: p, indices: Uint32Array.from(keep) }), flat, duplicate };
}

export function compact(mesh) {
  const remap = new Int32Array(mesh.positions.length / 3).fill(-1), pos = [];
  const idx = new Uint32Array(mesh.indices.length);
  for (let i = 0; i < mesh.indices.length; i++) {
    const v = mesh.indices[i];
    if (remap[v] < 0) { remap[v] = pos.length / 3; pos.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]); }
    idx[i] = remap[v];
  }
  return { positions: Float32Array.from(pos), indices: idx };
}

// Maakt de facetoriëntatie consistent per samenhangend deel (BFS over gedeelde randen).
export function orient(mesh) {
  const f = Uint32Array.from(mesh.indices), faceCount = f.length / 3;
  const edges = edgeMap({ positions: mesh.positions, indices: f });
  const adj = Array.from({ length: faceCount }, () => []);
  for (const e of edges.values()) if (e.count === 2) { const [x, y] = e.faces; adj[x].push(y); adj[y].push(x); }
  const has = (face, a, b) => { for (let k = 0; k < 3; k++) if (f[face * 3 + k] === a && f[face * 3 + (k + 1) % 3] === b) return true; return false; };
  const visited = new Uint8Array(faceCount);
  let flips = 0;
  for (let s = 0; s < faceCount; s++) {
    if (visited[s]) continue;
    visited[s] = 1;
    const queue = [s];
    while (queue.length) {
      const face = queue.pop();
      for (const other of adj[face]) {
        if (visited[other]) continue;
        // Gedeelde rand moet in tegengestelde richting voorkomen.
        let conflict = false;
        for (let k = 0; k < 3; k++) {
          const a = f[face * 3 + k], b = f[face * 3 + (k + 1) % 3];
          if (has(other, a, b)) { conflict = true; break; }
        }
        if (conflict) { const t = f[other * 3 + 1]; f[other * 3 + 1] = f[other * 3 + 2]; f[other * 3 + 2] = t; flips++; }
        visited[other] = 1; queue.push(other);
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
  let f = Array.from(mesh.indices), removed = 0, passes = 0;
  const p = mesh.positions;
  for (; passes < maxPasses; passes++) {
    const edges = edgeMap({ positions: p, indices: f });
    const bad = new Set(), boundaryCount = new Map();
    for (const e of edges.values()) {
      if (e.count > 2) e.faces.forEach(x => bad.add(x));
      else if (e.count === 1) for (const v of [e.from, e.to]) boundaryCount.set(v, (boundaryCount.get(v) || 0) + 1);
    }
    const bowtie = new Set([...boundaryCount].filter(([, c]) => c > 2).map(([v]) => v));
    const faceBoundary = new Uint8Array(f.length / 3);
    for (const e of edges.values()) if (e.count === 1) faceBoundary[e.faces[0]]++;
    for (let i = 0; i < f.length / 3; i++) {
      if (faceBoundary[i] >= 2) bad.add(i); // los 'oortje' aan de rand: geeft platte driehoeken bij het dichten
      else if (bowtie.size && (bowtie.has(f[i * 3]) || bowtie.has(f[i * 3 + 1]) || bowtie.has(f[i * 3 + 2]))) bad.add(i);
    }
    // grootste stuk dat via gedeelde (manifold) randen samenhangt
    const n = f.length / 3, parent = new Int32Array(n).map((_, i) => i);
    const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (const e of edges.values()) if (e.count === 2 && !bad.has(e.faces[0]) && !bad.has(e.faces[1])) parent[find(e.faces[0])] = find(e.faces[1]);
    const size = new Map();
    for (let i = 0; i < n; i++) if (!bad.has(i)) { const r = find(i); size.set(r, (size.get(r) || 0) + 1); }
    let best = -1, bestSize = 0; for (const [r, c] of size) if (c > bestSize) { best = r; bestSize = c; }
    const keep = [];
    for (let i = 0; i < n; i++) if (!bad.has(i) && find(i) === best) keep.push(f[i * 3], f[i * 3 + 1], f[i * 3 + 2]);
    const dropped = n - keep.length / 3;
    removed += dropped; f = keep;
    if (!dropped) break;
  }
  return { mesh: compact({ positions: p, indices: Uint32Array.from(f) }), removed, passes };
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
export function pointToSurfaceDistances(points, soup, { cell = 1, maxDist = 6, closest = null } = {}) {
  const grid = new Map(), key = (x, y, z) => (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
  const nf = soup.length / 9;
  for (let i = 0; i < nf; i++) {
    const o = i * 9;
    const x0 = Math.floor(Math.min(soup[o], soup[o + 3], soup[o + 6]) / cell), x1 = Math.floor(Math.max(soup[o], soup[o + 3], soup[o + 6]) / cell);
    const y0 = Math.floor(Math.min(soup[o + 1], soup[o + 4], soup[o + 7]) / cell), y1 = Math.floor(Math.max(soup[o + 1], soup[o + 4], soup[o + 7]) / cell);
    const z0 = Math.floor(Math.min(soup[o + 2], soup[o + 5], soup[o + 8]) / cell), z1 = Math.floor(Math.max(soup[o + 2], soup[o + 5], soup[o + 8]) / cell);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) { const k = key(x, y, z); let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(i); }
  }
  const out = new Float32Array(points.length / 3).fill(Infinity), seen = new Int32Array(nf).fill(-1);
  const R = Math.ceil(maxDist / cell);
  for (let pi = 0; pi < points.length / 3; pi++) {
    const px = points[pi * 3], py = points[pi * 3 + 1], pz = points[pi * 3 + 2];
    const cx = Math.floor(px / cell), cy = Math.floor(py / cell), cz = Math.floor(pz / cell);
    let best = Infinity;
    for (let ring = 0; ring <= R; ring++) {
      for (let x = cx - ring; x <= cx + ring; x++) for (let y = cy - ring; y <= cy + ring; y++) for (let z = cz - ring; z <= cz + ring; z++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy), Math.abs(z - cz)) !== ring) continue;
        for (const i of grid.get(key(x, y, z)) || []) { if (seen[i] === pi) continue; seen[i] = pi; const d = pointTriangle(px, py, pz, soup, i * 9, closest ? _cp : null); if (d < best) { best = d; if (closest) { closest[pi * 3] = _cp[0]; closest[pi * 3 + 1] = _cp[1]; closest[pi * 3 + 2] = _cp[2]; } } }
      }
      if (best <= ring * cell) break;
    }
    out[pi] = best;
  }
  return out;
}
const _cp = [0, 0, 0];
function pointTriangle(px, py, pz, s, o, cp = null) {
  // Ericson, Real-Time Collision Detection: dichtstbijzijnd punt op een driehoek
  const ax = s[o], ay = s[o + 1], az = s[o + 2], bx = s[o + 3], by = s[o + 4], bz = s[o + 5], cx = s[o + 6], cy = s[o + 7], cz = s[o + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az, apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  const dist = (x, y, z) => { if (cp) { cp[0] = x; cp[1] = y; cp[2] = z; } return Math.hypot(px - x, py - y, pz - z); };
  if (d1 <= 0 && d2 <= 0) return dist(ax, ay, az);
  const bpx = px - bx, bpy = py - by, bpz = pz - bz, d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return dist(bx, by, bz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return dist(ax + v * abx, ay + v * aby, az + v * abz); }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz, d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return dist(cx, cy, cz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return dist(ax + w * acx, ay + w * acy, az + w * acz); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return dist(bx + w * (cx - bx), by + w * (cy - by), bz + w * (cz - bz)); }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return dist(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

// Pasvlak-nauwkeurigheid: afstand van de scanpunten (binnen de omtrek) tot de plaat, vergeleken met de ingestelde ruimte.
export function fitReport(surfaceSoup, plateSoup, gap = 0, { skipFrom = null, sample = 4000 } = {}) {
  const n = (skipFrom ?? surfaceSoup.length / 9) * 3, stride = Math.max(1, Math.floor(n / sample));
  const pts = []; for (let v = 0; v < n; v += stride) pts.push(surfaceSoup[v * 3], surfaceSoup[v * 3 + 1], surfaceSoup[v * 3 + 2]);
  const d = pointToSurfaceDistances(Float32Array.from(pts), plateSoup, { maxDist: gap + 3 });
  const fin = Array.from(d).filter(Number.isFinite);
  const dev = fin.map(x => Math.abs(x - gap)).sort((a, b) => a - b), close = fin.map(x => Math.max(0, gap - x)).sort((a, b) => a - b);
  if (!dev.length) return null;
  const q = (a, f) => a[Math.min(a.length - 1, Math.floor(a.length * f))];
  // 'close' = dichter bij de scan dan de ingestelde ruimte (te weinig afdrukruimte); verder weg = overbrugd (smalle plooi)
  return { n: dev.length, median: q(dev, 0.5), p95: q(dev, 0.95), p99: q(dev, 0.99), max: dev.at(-1), within: dev.filter(x => x <= 0.05).length / dev.length,
    closeP99: q(close, 0.99), closeMax: close.at(-1), bridged: fin.filter(x => x > gap + 0.05).length / fin.length };
}

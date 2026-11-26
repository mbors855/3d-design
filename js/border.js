// v72: scanrand strak maken, zoals een technicus een model bijwerkt.
//  1. Franjes weg: dunne tongetjes, draadjes en haakjes aan de rand (scanruis, wang/tong) verdwijnen met een
//     'opening' over het oppervlak: alles binnen r mm van de rand weghalen en daarna weer r mm teruggroeien vanaf
//     wat overblijft. Stukken die smaller zijn dan 2r komen niet terug; brede delen blijven exact zoals gescand.
//  2. Inhammen dicht (bijv. een gat in het front): een smalle inkeping in de rand (opening < breedte, diep genoeg) wordt
//     overbrugd met een glad vlak tussen de wanden, aangesloten op de scan. De nieuwe rand loopt recht over de opening.
//  3. De buitenrand wordt vloeiend getrokken (in het raakvlak, dus op het oppervlak).
// Scanpunten binnenin worden nooit verschoven; alleen randdriehoeken verdwijnen of komen erbij.
import { weld, toSoup, boundaryLoops, edgeMap, rimDistances, compact, tidySheet, fillHoles } from './mesh.js';
import { TriBVH } from './bvh.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], len = a => Math.hypot(a[0], a[1], a[2]);

// kortste afstand over de randen van het net vanaf een verzameling beginpunten (Dijkstra; ± geodetisch)
function graphDistance(mesh, isSource, maxDist) {
  const p = mesh.positions, f = mesh.indices, n = p.length / 3;
  const deg = new Int32Array(n + 1); for (let i = 0; i < f.length; i++) deg[f[i] + 1] += 2;
  for (let v = 0; v < n; v++) deg[v + 1] += deg[v];
  const nb = new Int32Array(deg[n]), fill = deg.slice(0, n);
  for (let t = 0; t < f.length; t += 3) for (let k = 0; k < 3; k++) { const a = f[t + k], b = f[t + (k + 1) % 3], c = f[t + (k + 2) % 3]; nb[fill[a]++] = b; nb[fill[a]++] = c; }
  const dist = new Float64Array(n).fill(Infinity);
  let hd = new Float64Array(1024), hv = new Int32Array(1024), size = 0;
  const push = (d, v) => { if (size === hd.length) { const a = new Float64Array(size * 2); a.set(hd); hd = a; const b = new Int32Array(size * 2); b.set(hv); hv = b; } let i = size++; while (i > 0) { const q = (i - 1) >> 1; if (hd[q] <= d) break; hd[i] = hd[q]; hv[i] = hv[q]; i = q; } hd[i] = d; hv[i] = v; };
  const pop = () => { const v = hv[0], d = hd[0], ld = hd[--size], lv = hv[size]; let i = 0; for (;;) { let c = 2 * i + 1; if (c >= size) break; if (c + 1 < size && hd[c + 1] < hd[c]) c++; if (hd[c] >= ld) break; hd[i] = hd[c]; hv[i] = hv[c]; i = c; } hd[i] = ld; hv[i] = lv; return [d, v]; };
  for (let v = 0; v < n; v++) if (isSource(v)) { dist[v] = 0; push(0, v); }
  while (size) {
    const [d, v] = pop(); if (d > dist[v]) continue;
    for (let j = deg[v]; j < deg[v + 1]; j++) {
      const w = nb[j], nd = d + Math.hypot(p[v * 3] - p[w * 3], p[v * 3 + 1] - p[w * 3 + 1], p[v * 3 + 2] - p[w * 3 + 2]);
      if (nd < dist[w] && nd <= maxDist) { dist[w] = nd; push(nd, w); }
    }
  }
  return dist;
}

function largestComponent(mesh) {
  const f = mesh.indices, n = mesh.positions.length / 3, parent = new Int32Array(n).map((_, i) => i);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < f.length; t += 3) { const a = find(f[t]), b = find(f[t + 1]); parent[b] = a; parent[find(f[t + 2])] = a; }
  const cnt = new Map(); for (let t = 0; t < f.length; t += 3) { const r = find(f[t]); cnt.set(r, (cnt.get(r) ?? 0) + 1); }
  if (cnt.size <= 1) return mesh;
  let best = -1, bc = -1; for (const [r, c] of cnt) if (c > bc) { bc = c; best = r; }
  const keep = []; for (let t = 0; t < f.length; t += 3) if (find(f[t]) === best) keep.push(f[t], f[t + 1], f[t + 2]);
  return compact({ positions: mesh.positions, indices: Uint32Array.from(keep) });
}

/** 1. Franjes weg: opening met straal r (mm) over het oppervlak. */
export function removeFringes(mesh, r, protect = null) {
  const loops = boundaryLoops(mesh, edgeMap(mesh)).loops; if (!loops.length) return { mesh, removed: 0 };
  const d = rimDistances(mesh, loops, r * 2.5);
  const g = graphDistance(mesh, v => !(d[v] <= r), r * 1.6); // kern: verder dan r van de rand
  const f = mesh.indices, keep = [], lim = r * 1.08 + 1e-6; // padlengte over ribben is ± 8% langer dan de echte afstand
  const P = mesh.positions, safe = t => protect && protect([(P[f[t] * 3] + P[f[t + 1] * 3] + P[f[t + 2] * 3]) / 3, (P[f[t] * 3 + 1] + P[f[t + 1] * 3 + 1] + P[f[t + 2] * 3 + 1]) / 3, (P[f[t] * 3 + 2] + P[f[t + 1] * 3 + 2] + P[f[t + 2] * 3 + 2]) / 3]);
  for (let t = 0; t < f.length; t += 3) if ((g[f[t]] <= lim && g[f[t + 1]] <= lim && g[f[t + 2]] <= lim) || safe(t)) keep.push(f[t], f[t + 1], f[t + 2]);
  const removed = f.length / 3 - keep.length / 3;
  if (!removed) return { mesh, removed: 0 };
  let m = compact({ positions: mesh.positions, indices: Uint32Array.from(keep) });
  m = tidySheet(largestComponent(m)).mesh;
  return { mesh: m, removed: f.length / 3 - m.indices.length / 3 };
}

/** 2. Inhammen in de buitenrand overbruggen. width: hoogstens zo breed (mm) is de opening; minDepth: zo diep minstens. */
export function fillNotches(mesh, { width = 7, minDepth = 1.5, maxArc = 60 } = {}) {
  const { loops } = boundaryLoops(mesh, edgeMap(mesh)); if (!loops.length) return { mesh, notches: [] };
  const P = mesh.positions, at = v => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
  const lens = loops.map(l => { let s = 0; for (let i = 0; i < l.length; i++) s += len(sub(at(l[i]), at(l[(i + 1) % l.length]))); return s; });
  const L = loops[lens.indexOf(Math.max(...lens))], m = L.length, total = Math.max(...lens);
  const cum = new Float64Array(m + 1); for (let i = 1; i <= m; i++) cum[i] = cum[i - 1] + len(sub(at(L[i - 1]), at(L[i % m])));
  const arc = (i, j) => (j >= i ? cum[j] - cum[i] : total - cum[i] + cum[j]);
  const normalNear = nearNormals(mesh, 1.5);
  // kandidaten: voor elk randpunt het verste punt verderop (langs de rand) dat dichtbij ligt én waarvan de brug
  // helemaal door lege ruimte loopt (een te brede brug schampt anders over het oppervlak naast de inham)
  const bvh = new TriBVH(toSoup(mesh)), clear = (A, B) => {
    const L2 = len(sub(B, A)), n = Math.max(2, Math.ceil(L2 / 0.5));
    for (let s = 1; s < n; s++) { const t = s / n; if (t * L2 < 0.7 || (1 - t) * L2 < 0.7) continue; const q = A.map((x, k) => x + (B[k] - x) * t), d = bvh.closest(q[0], q[1], q[2], 2); if (d < 0.3) return false; }
    return true;
  };
  const cand = [];
  for (let i = 0; i < m; i++) {
    const a = at(L[i]), opts = [];
    for (let k = 1; k < m; k++) {
      const j = (i + k) % m, s = arc(i, j); if (s > Math.min(maxArc, total / 3)) break;
      const dd = len(sub(at(L[j]), a)); if (dd > width || s < Math.max(4, dd + 2 * minDepth)) continue;
      opts.push({ j, s });
    }
    opts.sort((x, y) => y.s - x.s);
    for (const o of opts.slice(0, 12)) if (clear(a, at(L[o.j]))) { cand.push({ i, j: o.j, arc: o.s }); break; }
  }
  cand.sort((x, y) => y.arc - x.arc);
  const used = new Uint8Array(m), notches = [];
  for (const c of cand) {
    let free = true; for (let k = c.i; k !== (c.j + 1) % m; k = (k + 1) % m) if (used[k]) { free = false; break; }
    if (!free) continue;
    const A = at(L[c.i]), B = at(L[c.j]), AB = sub(B, A), ab = len(AB) || 1;
    // diepte van de inham en: ligt de brug echt in een opening (niet over het oppervlak, zoals bij een bolle kampunt)?
    let depth = 0; for (let k = c.i; k !== c.j; k = (k + 1) % m) { const q = sub(at(L[k]), A), t = Math.max(0, Math.min(1, dot(q, AB) / (ab * ab))); depth = Math.max(depth, len(sub(q, AB.map(x => x * t)))); }
    if (depth < Math.max(minDepth, 0.25 * ab)) continue; // ondiep en breed = gewoon een bocht in de rand
    let gap = 0; for (const t of [0.3, 0.5, 0.7]) { const q = A.map((x, k) => x + AB[k] * t); const d = bvh.closest(q[0], q[1], q[2], 5); gap = Math.max(gap, d === Infinity ? 5 : d); }
    if (gap < 0.4) continue; // de brug ligt op het oppervlak: geen inham
    // een echte inham is een opening ín het vlak: aan beide kanten wijst het oppervlak dezelfde kant op en de brug ligt
    // in dat vlak. Bij het uiteinde van de kam (rand loopt van wang- naar tongzijde om de kam heen) wijzen de kanten
    // tegen elkaar in: dat is geen inham (anders komt er een vlies onder de kam)
    const nA = normalNear(A), nB = normalNear(B), u = AB.map(x => x / ab);
    if (dot(nA, nB) < 0 || Math.abs(dot(u, nA)) > 0.6 || Math.abs(dot(u, nB)) > 0.6) continue;
    // inham of schiereiland? Langs de rand ligt het oppervlak links (gezien vanaf de normaal). Rand A→B plus brug B→A
    // loopt bij een inham met de klok mee om de lege ruimte (negatief oppervlak), bij een uitstekend stuk (het eind van
    // de kam, een tongetje) tegen de klok in om het oppervlak heen: dat stuk mag niet worden 'overbrugd'
    const nm = nA.map((x, k) => x + nB[k]), nl = len(nm) || 1; let area = 0;
    for (let k = c.i; ; k = (k + 1) % m) { const p = at(L[k]), q = k === c.j ? A : at(L[(k + 1) % m]); area += dot(crs(p, q), nm) / nl / 2; if (k === c.j) break; }
    if (area >= 0) continue;
    for (let k = c.i; k !== (c.j + 1) % m; k = (k + 1) % m) used[k] = 1;
    notches.push({ i: c.i, j: c.j, width: ab, depth, arc: c.arc });
  }
  if (!notches.length) return { mesh, notches: [] };
  const pos = Array.from(P), idx = Array.from(mesh.indices), h = medianEdge(mesh);
  for (const nt of notches) {
    const chain = []; for (let k = nt.i; ; k = (k + 1) % m) { chain.push(L[k]); if (k === nt.j) break; }
    const A = at(L[nt.i]), B = at(L[nt.j]), nb = Math.max(1, Math.round(len(sub(A, B)) / h));
    const bridge = []; for (let k = 1; k < nb; k++) { const t = k / nb; bridge.push(pos.length / 3); pos.push(B[0] + (A[0] - B[0]) * t, B[1] + (A[1] - B[1]) * t, B[2] + (A[2] - B[2]) * t); }
    patch(pos, idx, [...chain, ...bridge], h);
  }
  const out = { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
  // de hoeken waar de brug op de rand aansluit iets afronden (anders een scherpe knik: daar maakt de plaatrand een
  // dun vinnetje)
  const ends = new Set(); for (const nt of notches) { ends.add(L[nt.i]); ends.add(L[nt.j]); }
  const nl = boundaryLoops(out, edgeMap(out)).loops, loop = nl.reduce((x, y) => (y.length > x.length ? y : x), []);
  const Q = out.positions, n = loop.length, move = new Set();
  loop.forEach((v, k) => { if (!ends.has(v)) return; let s = 0; for (let d = 0; d < n && s < 1.5; d++) { const a = loop[(k + d) % n], b = loop[(k + d + 1) % n]; move.add(a); s += Math.hypot(Q[a * 3] - Q[b * 3], Q[a * 3 + 1] - Q[b * 3 + 1], Q[a * 3 + 2] - Q[b * 3 + 2]); }
    s = 0; for (let d = 0; d < n && s < 1.5; d++) { const a = loop[(k - d + n) % n], b = loop[(k - d - 1 + n) % n]; move.add(a); s += Math.hypot(Q[a * 3] - Q[b * 3], Q[a * 3 + 1] - Q[b * 3 + 1], Q[a * 3 + 2] - Q[b * 3 + 2]); } });
  for (let it = 0; it < 8; it++) loop.forEach((v, k) => { if (!move.has(v)) return; const a = loop[(k - 1 + n) % n], b = loop[(k + 1) % n]; for (let c = 0; c < 3; c++) Q[v * 3 + c] = 0.5 * Q[v * 3 + c] + 0.25 * (Q[a * 3 + c] + Q[b * 3 + c]); });
  return { mesh: out, notches };
}

// gemiddelde (oppervlakte-gewogen) normaal van de facetten binnen r mm van een punt
export function nearNormals(mesh, r) {
  const P = mesh.positions, f = mesh.indices, cells = new Map(), key = (x, y, z) => (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
  const nt = f.length / 3, cen = new Float32Array(nt * 3), nrm = new Float32Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    const a = f[t * 3] * 3, b = f[t * 3 + 1] * 3, c = f[t * 3 + 2] * 3;
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]], n = crs(u, v);
    for (let k = 0; k < 3; k++) { cen[t * 3 + k] = (P[a + k] + P[b + k] + P[c + k]) / 3; nrm[t * 3 + k] = n[k] / 2; }
    const kk = key(Math.floor(cen[t * 3] / r), Math.floor(cen[t * 3 + 1] / r), Math.floor(cen[t * 3 + 2] / r));
    let l = cells.get(kk); if (!l) cells.set(kk, l = []); l.push(t);
  }
  return q => {
    const s = [0, 0, 0], cx = Math.floor(q[0] / r), cy = Math.floor(q[1] / r), cz = Math.floor(q[2] / r);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (const t of cells.get(key(cx + dx, cy + dy, cz + dz)) || []) {
      if (Math.hypot(cen[t * 3] - q[0], cen[t * 3 + 1] - q[1], cen[t * 3 + 2] - q[2]) > r) continue;
      s[0] += nrm[t * 3]; s[1] += nrm[t * 3 + 1]; s[2] += nrm[t * 3 + 2];
    }
    const l = len(s) || 1; return s.map(x => x / l);
  };
}

function medianEdge(mesh) {
  const p = mesh.positions, f = mesh.indices, s = [];
  for (let t = 0; t < f.length && s.length < 4000; t += 3 * Math.max(1, Math.floor(f.length / 12000))) { const a = f[t] * 3, b = f[t + 1] * 3; s.push(Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2])); }
  s.sort((x, y) => x - y); return Math.max(0.15, s[s.length >> 1] || 0.5);
}

// Een gesloten rand (hoekpunt-indices; volgorde = zoals in het net, de vulling gebruikt de omgekeerde richting)
// vullen: oren knippen in het best passende vlak, dan punten bijzetten in grote driehoeken met ribbe-omklappen
// (± Delaunay), en de nieuwe punten glad laten 'hangen' tussen de rand (vaste rand, Laplace).
function patch(pos, idx, loop, h) {
  const n = loop.length, at = v => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];
  const rev = loop.slice().reverse(), pts = rev.map(at);
  const c = pts.reduce((s, q) => s.map((x, k) => x + q[k] / n), [0, 0, 0]);
  let N = [0, 0, 0]; for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; N = [N[0] + (a[1] - b[1]) * (a[2] + b[2]), N[1] + (a[2] - b[2]) * (a[0] + b[0]), N[2] + (a[0] - b[0]) * (a[1] + b[1])]; }
  const ln = len(N) || 1; N = N.map(x => x / ln);
  let U = Math.abs(N[0]) < 0.9 ? crs(N, [1, 0, 0]) : crs(N, [0, 1, 0]); const lu = len(U); U = U.map(x => x / lu); const V = crs(N, U);
  const uv = v => { const d = sub(at(v), c); return [dot(d, U), dot(d, V)]; };
  let verts = rev.slice(), tris = earClip2(verts.map(uv));
  if (!tris) { // terugval: waaier vanuit het midden
    const ci = pos.length / 3; pos.push(...c);
    for (let i = 0; i < n; i++) idx.push(rev[i], rev[(i + 1) % n], ci);
    return;
  }
  tris = tris.map(t => t.map(i => verts[i]));
  const boundary = new Set(rev), interior = [];
  // punten bijzetten in te grote driehoeken (zwaartepunt), daarna ribben omklappen in het vlak
  const area = t => { const [a, b, c2] = t.map(uv); return Math.abs((b[0] - a[0]) * (c2[1] - a[1]) - (b[1] - a[1]) * (c2[0] - a[0])) / 2; };
  const target = h * h * 0.9, L = (a, b) => Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]);
  const EK = (a, b) => (a < b ? a * 4194304 + b : b * 4194304 + a), onRim = new Set();
  for (let i = 0; i < rev.length; i++) onRim.add(EK(rev[i], rev[(i + 1) % rev.length])); // randribben: aan de scan vast, niet splitsen
  for (let round = 0; round < 12; round++) {
    // 1. grote driehoeken: punt in het midden
    let next = [], added = 0;
    for (const t of tris) {
      if (area(t) > target * 2.2) { const g = [0, 1, 2].map(k => (pos[t[0] * 3 + k] + pos[t[1] * 3 + k] + pos[t[2] * 3 + k]) / 3), gi = pos.length / 3; pos.push(...g); interior.push(gi); next.push([t[0], t[1], gi], [t[1], t[2], gi], [t[2], t[0], gi]); added++; }
      else next.push(t);
    }
    // 2. lange binnenribben (splinters): middelpunt, beide driehoeken mee gesplitst
    const split = new Map();
    for (const t of next) { let best = -1, bl = 2.2 * h; for (let k = 0; k < 3; k++) { const a = t[k], b = t[(k + 1) % 3], l = L(a, b); if (l > bl && !onRim.has(EK(a, b))) { bl = l; best = k; } } if (best >= 0) { const a = t[best], b = t[(best + 1) % 3], key = EK(a, b); if (!split.has(key)) { const mi = pos.length / 3; pos.push((pos[a * 3] + pos[b * 3]) / 2, (pos[a * 3 + 1] + pos[b * 3 + 1]) / 2, (pos[a * 3 + 2] + pos[b * 3 + 2]) / 2); interior.push(mi); split.set(key, mi); } } }
    if (split.size) {
      const out = [];
      for (const t of next) {
        let k = -1; for (let q = 0; q < 3; q++) if (split.has(EK(t[q], t[(q + 1) % 3]))) { k = q; break; }
        if (k < 0) { out.push(t); continue; }
        // hooguit één ribbe per ronde per driehoek; de andere gesplitste ribben komen de volgende ronde
        const a = t[k], b = t[(k + 1) % 3], c = t[(k + 2) % 3], m = split.get(EK(a, b));
        const other = [EK(b, c), EK(c, a)].filter(e => split.has(e));
        if (other.length) { // meer dan één gesplitste ribbe: in vieren/drieën delen zoals bij verfijnen
          const mb = split.get(EK(b, c)), mc = split.get(EK(c, a));
          if (mb !== undefined && mc !== undefined) out.push([a, m, mc], [m, b, mb], [mc, mb, c], [m, mb, mc]);
          else if (mb !== undefined) out.push([m, b, mb], [a, m, mb], [a, mb, c]);
          else out.push([a, m, mc], [m, b, c], [mc, m, c]);
        } else out.push([a, m, c], [m, b, c]);
        added++;
      }
      next = out;
    }
    tris = flipDelaunay(next, uv, boundary);
    if (!added) break;
  }
  // glad laten hangen: Laplace op de nieuwe punten (rand vast)
  const nbs = new Map(); for (const v of interior) nbs.set(v, new Set());
  for (const t of tris) for (let k = 0; k < 3; k++) { const a = t[k]; if (nbs.has(a)) { nbs.get(a).add(t[(k + 1) % 3]); nbs.get(a).add(t[(k + 2) % 3]); } }
  for (let it = 0; it < 40; it++) for (const v of interior) { const s = [...nbs.get(v)], q = [0, 0, 0]; for (const w of s) for (let k = 0; k < 3; k++) q[k] += pos[w * 3 + k] / s.length; for (let k = 0; k < 3; k++) pos[v * 3 + k] = q[k]; }
  for (const t of tris) idx.push(...t);
}

function earClip2(q) {
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  let area = 0; for (let i = 0; i < q.length; i++) area += cross([0, 0], q[i], q[(i + 1) % q.length]);
  const sgn = Math.sign(area) || 1, ix = q.map((_, i) => i), out = [];
  const inTri = (p, a, b, c) => { const d1 = cross(a, b, p) * sgn, d2 = cross(b, c, p) * sgn, d3 = cross(c, a, p) * sgn; return d1 > 1e-12 && d2 > 1e-12 && d3 > 1e-12; };
  let guard = 0;
  while (ix.length > 3 && guard++ < q.length * q.length) {
    let cut = false;
    for (let k = 0; k < ix.length; k++) {
      const i0 = ix[(k - 1 + ix.length) % ix.length], i1 = ix[k], i2 = ix[(k + 1) % ix.length];
      if (cross(q[i0], q[i1], q[i2]) * sgn <= 1e-12) continue;
      if (ix.some(j => j !== i0 && j !== i1 && j !== i2 && inTri(q[j], q[i0], q[i1], q[i2]))) continue;
      out.push([i0, i1, i2]); ix.splice(k, 1); cut = true; break;
    }
    if (!cut) return null;
  }
  if (ix.length === 3) out.push([ix[0], ix[1], ix[2]]);
  return out;
}

// ribben omklappen tot elke binnenribbe aan de Delaunay-voorwaarde voldoet (in het vlak van de vulling)
function flipDelaunay(tris, uv, boundary) {
  const key = (a, b) => (a < b ? a * 4194304 + b : b * 4194304 + a);
  for (let pass = 0; pass < 8; pass++) {
    const edge = new Map(); tris.forEach((t, ti) => { for (let k = 0; k < 3; k++) { const kk = key(t[k], t[(k + 1) % 3]); (edge.get(kk) ?? edge.set(kk, []).get(kk)).push(ti); } });
    let flips = 0; const dead = new Set();
    for (const [, list] of edge) {
      if (list.length !== 2 || dead.has(list[0]) || dead.has(list[1])) continue;
      const [t1, t2] = list.map(i => tris[i]);
      const sh = t1.filter(v => t2.includes(v)); if (sh.length !== 2) continue;
      const a = t1.find(v => !sh.includes(v)), b = t2.find(v => !sh.includes(v));
      if (boundary.has(sh[0]) && boundary.has(sh[1]) && boundary.has(a) && boundary.has(b)) { /* rand-rand mag ook */ }
      const [pa, pb, ps0, ps1] = [a, b, sh[0], sh[1]].map(uv);
      if (!inCircle(pa, ps0, ps1, pb)) continue;
      // nieuwe driehoeken moeten geldig blijven (vierhoek bol)
      const c1 = orient(pa, pb, ps0), c2 = orient(pa, pb, ps1); if (c1 * c2 >= 0) continue;
      // oriëntatie behouden: t1 = (…sh0→sh1…) in volgorde
      const o1 = t1.indexOf(sh[0]), forward = t1[(o1 + 1) % 3] === sh[1];
      const [s0, s1] = forward ? sh : [sh[1], sh[0]];
      tris[list[0]] = [a, s0, b]; tris[list[1]] = [b, s1, a];
      dead.add(list[0]); dead.add(list[1]); flips++;
    }
    if (!flips) break;
  }
  return tris;
}
const orient = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
function inCircle(a, b, c, d) { // d binnen de omgeschreven cirkel van a,b,c (orientatie-onafhankelijk)
  const m = [[a[0] - d[0], a[1] - d[1]], [b[0] - d[0], b[1] - d[1]], [c[0] - d[0], c[1] - d[1]]].map(([x, y]) => [x, y, x * x + y * y]);
  const det = m[0][0] * (m[1][1] * m[2][2] - m[2][1] * m[1][2]) - m[0][1] * (m[1][0] * m[2][2] - m[2][0] * m[1][2]) + m[0][2] * (m[1][0] * m[2][1] - m[2][0] * m[1][1]);
  return det * orient(a, b, c) > 1e-12;
}

// facet-sleutel onafhankelijk van de puntvolgorde (posities op 0,1 µm afgerond): zo is na het bewerken terug te vinden
// welke facetten nog originele scan zijn
function faceKeys(soup) {
  const n = soup.length / 9, keys = new Float64Array(n), q = x => Math.round(x * 1e4) | 0;
  for (let t = 0; t < n; t++) {
    const h = [0, 1, 2].map(k => { const i = t * 9 + k * 3; return (Math.imul(q(soup[i]), 73856093) ^ Math.imul(q(soup[i + 1]), 19349663) ^ Math.imul(q(soup[i + 2]), 83492791)) >>> 0; }).sort((a, b) => a - b);
    const h1 = (Math.imul(h[0] ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(h[1], 0xc2b2ae35) ^ h[2]) >>> 0, h2 = (h[0] + h[1] * 3 + h[2] * 7) & 0xfffff;
    keys[t] = h1 * 1048576 + h2;
  }
  return keys;
}

// Alle binnenlussen (gaten in de scan, zoals de opening rond een implantaat of een niet gescand stukje tandvlees in het
// front) tot maxSize mm doorsnede dichten met een glad vlak (zelfde vulling als bij de inhammen).
export function fillInnerHoles(mesh, { maxSize = 25, near = null } = {}) {
  const { loops } = boundaryLoops(mesh, edgeMap(mesh)); if (loops.length < 2) return { mesh, filled: 0 };
  const P = mesh.positions, at = v => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
  const lens = loops.map(l => { let s = 0; for (let i = 0; i < l.length; i++) s += len(sub(at(l[i]), at(l[(i + 1) % l.length]))); return s; });
  const outer = lens.indexOf(Math.max(...lens)), pos = Array.from(P), idx = Array.from(mesh.indices), h = medianEdge(mesh);
  let filled = 0;
  loops.forEach((l, i) => {
    if (i === outer) return;
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const v of l) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], P[v * 3 + k]); mx[k] = Math.max(mx[k], P[v * 3 + k]); }
    // v73: een gat onder een steg (daar kan de scanner niet kijken) wordt ook gedicht als het groter is: de uitsparing
    // haalt dat stuk later toch weg, maar zonder vulling hield de plaat daar een tweede rand en mislukte hij
    const under = near && l.filter(v => near(at(v))).length >= 0.7 * l.length;
    if (len(sub(mx, mn)) > maxSize && !under) return;
    patch(pos, idx, l, h); filled++;
  });
  return filled ? { mesh: { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }, filled } : { mesh, filled: 0 };
}

/** Alles samen. designedFrom: facetten vanaf deze index waren al ontworpen (aangevulde plooi).
 *  Geeft { soup, designedFrom, report: { fringeFaces, notches: [{ width, depth }], holes } }. Gedichte gaten en
 *  inhammen horen bij het scanoppervlak (een werkstuk 'langs de scanrand' gaat er dus overheen); alleen wat al
 *  ontworpen was blijft achteraan (paars). */
export function tidyBorder(soup, { designedFrom = null, fringe = 1.5, notchWidth = 7, notchMinDepth = 1.5, protect = null, holeSize = 25, holeNear = protect } = {}) {
  const nIn = soup.length / 9, inKeys = faceKeys(soup), designed = new Set();
  for (let t = designedFrom ?? nIn; t < nIn; t++) designed.add(inKeys[t]);
  let mesh = weld(soup, 1e-5);
  mesh = tidySheet(mesh).mesh;
  const holes = fillInnerHoles(mesh, { maxSize: holeSize, near: holeNear }); mesh = holes.mesh;
  const report = { fringeFaces: 0, notches: [], holes: holes.filled };
  if (fringe > 0) { const r = removeFringes(mesh, fringe, protect); mesh = r.mesh; report.fringeFaces = r.removed; }
  if (notchWidth > 0) { const r = fillNotches(mesh, { width: notchWidth, minDepth: notchMinDepth }); mesh = r.mesh; report.notches = r.notches.map(({ width, depth }) => ({ width, depth })); }
  const out = toSoup(mesh), keys = faceKeys(out), n = out.length / 9, a = [], b = [];
  for (let t = 0; t < n; t++) (designed.has(keys[t]) ? b : a).push(t);
  const res = new Float32Array(out.length);
  [...a, ...b].forEach((t, i) => res.set(out.subarray(t * 9, t * 9 + 9), i * 9));
  return { soup: res, designedFrom: b.length ? a.length : null, report };
}

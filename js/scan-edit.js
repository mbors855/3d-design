// Scanbewerking (rekenkern, zonder interface): selecteren met lasso of gum, wissen, gladmaken, vlak afsnijden,
// losse delen verwijderen, gaten dichten. Alles werkt op een "soup" (Float32Array, 9 getallen per driehoek) zoals
// de rest van het programma, en geeft een nieuwe soup terug. Scanpunten buiten de selectie veranderen nooit.
import { weld, toSoup, fillHoles, boundaryLoops, edgeMap } from './mesh.js';

export const triCount = soup => soup.length / 9;

// ---------- selecteren ----------
// Punt-in-veelhoek (even-oneven), polygon = [[x, y], …] in schermpixels.
export function insidePolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Lasso: driehoeken waarvan het zwaartepunt binnen de getekende veelhoek valt.
// project(x, y, z) → [sx, sy, zDiepte] in schermpixels; viewDir = kijkrichting (wereld, genormaliseerd).
// frontOnly: alleen driehoeken die naar de kijker gericht zijn (de zichtbare kant), anders "door en door".
export function lassoMask(soup, polygon, project, { viewDir = null, frontOnly = false } = {}) {
  const n = triCount(soup), mask = new Uint8Array(n);
  if (polygon.length < 3) return mask;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of polygon) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  for (let f = 0; f < n; f++) {
    const o = f * 9;
    if (frontOnly && viewDir) {
      const ux = soup[o + 3] - soup[o], uy = soup[o + 4] - soup[o + 1], uz = soup[o + 5] - soup[o + 2];
      const vx = soup[o + 6] - soup[o], vy = soup[o + 7] - soup[o + 1], vz = soup[o + 8] - soup[o + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * viewDir[0] + ny * viewDir[1] + nz * viewDir[2] >= 0) continue; // wijst van de kijker af
    }
    const [sx, sy] = project((soup[o] + soup[o + 3] + soup[o + 6]) / 3, (soup[o + 1] + soup[o + 4] + soup[o + 7]) / 3, (soup[o + 2] + soup[o + 5] + soup[o + 8]) / 3);
    if (sx < minX || sx > maxX || sy < minY || sy > maxY) continue;
    if (insidePolygon(sx, sy, polygon)) mask[f] = 1;
  }
  return mask;
}

// Gum/penseel: driehoeken met een hoekpunt binnen de straal rond een punt (wereld-mm). Voegt toe aan mask.
export function sphereMask(soup, center, radius, mask = new Uint8Array(triCount(soup))) {
  const r2 = radius * radius, [cx, cy, cz] = center;
  for (let f = 0, n = triCount(soup); f < n; f++) {
    if (mask[f]) continue;
    for (let k = 0; k < 3; k++) {
      const o = f * 9 + k * 3, dx = soup[o] - cx, dy = soup[o + 1] - cy, dz = soup[o + 2] - cz;
      if (dx * dx + dy * dy + dz * dz <= r2) { mask[f] = 1; break; }
    }
  }
  return mask;
}

export const countMask = mask => { let c = 0; for (let i = 0; i < mask.length; i++) c += mask[i] ? 1 : 0; return c; };
export const invertMask = mask => mask.map(v => v ? 0 : 1);

// ---------- bewerkingen ----------
export function deleteMask(soup, mask) {
  const keep = triCount(soup) - countMask(mask), out = new Float32Array(keep * 9);
  let o = 0;
  for (let f = 0, n = triCount(soup); f < n; f++) if (!mask[f]) { out.set(soup.subarray(f * 9, f * 9 + 9), o); o += 9; }
  return out;
}

// Wissen met een strakke rand: na het verwijderen worden alleen de NIEUWE randpunten langs de rand gladgetrokken
// (de oorspronkelijke scanrand blijft exact). Zo geen zaagtand langs de lasso- of gumlijn.
export function deleteMaskClean(soup, mask, { iterations = 6 } = {}) {
  const out = deleteMask(soup, mask);
  const key = (a, i) => `${Math.round(a[i] * 1e4)},${Math.round(a[i + 1] * 1e4)},${Math.round(a[i + 2] * 1e4)}`;
  const before = weld(soup, 1e-5), old = new Set();
  for (const loop of boundaryLoops(before, edgeMap(before)).loops) for (const v of loop) old.add(key(before.positions, v * 3));
  const mesh = weld(out, 1e-5), P = mesh.positions;
  for (const loop of boundaryLoops(mesh, edgeMap(mesh)).loops) {
    const m = loop.length; if (m < 4) continue;
    const free = loop.map(v => !old.has(key(P, v * 3)));
    for (let it = 0; it < iterations; it++) {
      const next = loop.map((v, k) => { if (!free[k]) return null; const a = loop[(k - 1 + m) % m] * 3, b = loop[(k + 1) % m] * 3; return [0, 1, 2].map(c => 0.5 * P[v * 3 + c] + 0.25 * (P[a + c] + P[b + c])); });
      loop.forEach((v, k) => { if (next[k]) for (let c = 0; c < 3; c++) P[v * 3 + c] = next[k][c]; });
    }
  }
  return toSoup(mesh);
}

// Alleen het grootste aaneengesloten deel houden (of alle delen boven minShare van het totaal).
export function faceLabels(mesh) {
  const nv = mesh.positions.length / 3, parent = new Int32Array(nv).map((_, i) => i), I = mesh.indices;
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let i = 0; i < I.length; i += 3) { const a = find(I[i]), b = find(I[i + 1]); parent[b] = a; parent[find(I[i + 2])] = find(a); }
  const labels = new Int32Array(I.length / 3); for (let f = 0; f < labels.length; f++) labels[f] = find(I[f * 3]);
  return labels;
}
export function keepLargest(soup, { minShare = 0 } = {}) {
  const mesh = weld(soup, 1e-5), labels = faceLabels(mesh), count = new Map();
  for (const c of labels) count.set(c, (count.get(c) || 0) + 1);
  let best = -1, bestN = -1; for (const [c, k] of count) if (k > bestN) { best = c; bestN = k; }
  const keep = c => c === best || (minShare > 0 && count.get(c) / labels.length >= minShare);
  const idx = []; for (let f = 0; f < labels.length; f++) if (keep(labels[f])) idx.push(mesh.indices[f * 3], mesh.indices[f * 3 + 1], mesh.indices[f * 3 + 2]);
  const removed = [...count.keys()].filter(c => !keep(c)).length;
  return { soup: toSoup({ positions: mesh.positions, indices: Uint32Array.from(idx) }), removed, parts: count.size };
}

// Vlak afsnijden: houdt het deel aan de kant van normal (dot ≥ 0); randdriehoeken worden exact gesneden.
export function planeCut(soup, origin, normal) {
  const [ox, oy, oz] = origin, [nx, ny, nz] = normal, out = [];
  const d = (x, y, z) => (x - ox) * nx + (y - oy) * ny + (z - oz) * nz;
  const lerp = (a, b, da, db) => { const t = da / (da - db); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; };
  for (let f = 0, n = triCount(soup); f < n; f++) {
    const o = f * 9, P = [[soup[o], soup[o + 1], soup[o + 2]], [soup[o + 3], soup[o + 4], soup[o + 5]], [soup[o + 6], soup[o + 7], soup[o + 8]]];
    const D = P.map(p => d(...p)), up = D.map(v => v >= 0), k = up.filter(Boolean).length;
    if (k === 3) { out.push(...P[0], ...P[1], ...P[2]); continue; }
    if (k === 0) continue;
    let r = 0; while (up[r] === (k === 1 ? false : true)) r++;
    const a = r, b = (r + 1) % 3, c = (r + 2) % 3;
    if (k === 1) out.push(...P[a], ...lerp(P[a], P[b], D[a], D[b]), ...lerp(P[a], P[c], D[a], D[c]));
    else { const ab = lerp(P[a], P[b], D[a], D[b]), ac = lerp(P[a], P[c], D[a], D[c]); out.push(...P[b], ...P[c], ...ac, ...P[b], ...ac, ...ab); }
  }
  return Float32Array.from(out);
}

// Gladmaken binnen de selectie (Taubin λ/μ: krimpt niet). De rand van de scan blijft op zijn plek.
export function smoothMask(soup, mask, { iterations = 4, lambda = 0.5, mu = -0.53 } = {}) {
  const mesh = weld(soup, 1e-5), P = mesh.positions, I = mesh.indices, nv = P.length / 3;
  const sel = new Uint8Array(nv);
  for (let f = 0; f < I.length / 3; f++) if (mask[f]) { sel[I[f * 3]] = 1; sel[I[f * 3 + 1]] = 1; sel[I[f * 3 + 2]] = 1; }
  // randhoekpunten van de scan niet verschuiven (anders loopt de rand weg)
  for (const loop of boundaryLoops(mesh, edgeMap(mesh)).loops) for (const v of loop) sel[v] = 0;
  const nb = Array.from({ length: nv }, () => new Set());
  for (let f = 0; f < I.length; f += 3) for (let k = 0; k < 3; k++) { const a = I[f + k], b = I[f + (k + 1) % 3]; if (sel[a]) nb[a].add(b); if (sel[b]) nb[b].add(a); }
  const step = w => {
    const upd = new Float32Array(P.length);
    for (let v = 0; v < nv; v++) {
      if (!sel[v] || !nb[v].size) continue;
      let x = 0, y = 0, z = 0; for (const u of nb[v]) { x += P[u * 3]; y += P[u * 3 + 1]; z += P[u * 3 + 2]; }
      const k = nb[v].size; upd[v * 3] = (x / k - P[v * 3]) * w; upd[v * 3 + 1] = (y / k - P[v * 3 + 1]) * w; upd[v * 3 + 2] = (z / k - P[v * 3 + 2]) * w;
    }
    for (let i = 0; i < P.length; i++) P[i] += upd[i];
  };
  for (let it = 0; it < iterations; it++) { step(lambda); step(mu); }
  return toSoup(mesh);
}

// Gaten in de scan dichten (de buitenrand blijft open).
export function closeHoles(soup, { maxEdges = 400 } = {}) {
  const mesh = weld(soup, 1e-5), before = boundaryLoops(mesh, edgeMap(mesh)).loops.length;
  const res = fillHoles(mesh, { keepLargest: true, maxEdges });
  const after = boundaryLoops(res.mesh, edgeMap(res.mesh)).loops.length;
  return { soup: toSoup(res.mesh), filled: Math.max(0, before - after) };
}

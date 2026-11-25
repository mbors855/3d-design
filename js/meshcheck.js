// Zelfdoorsnijding zoeken (v69): driehoeken van één gesloten mesh die elkaar snijden. Een slicer (Asiga Composer)
// en de booleaanse bewerkingen (beetwal, handvat) gaan daar slecht mee om; een ontwerp hoort er geen te hebben.
// Uniform raster over de begrenzingsdozen, per kandidaatpaar zonder gedeeld hoekpunt een driehoek-driehoek-test
// (elke rib van de ene tegen de andere driehoek).

/** mesh: { positions, indices } (gelast). Geeft { pairs, faces: Uint8Array (1 = snijdt), checked }. */
export function selfIntersections(mesh, { cell = 0, maxPairs = 2e8 } = {}) {
  const p = mesh.positions, f = mesh.indices, nf = f.length / 3;
  if (!nf) return { pairs: 0, faces: new Uint8Array(0), checked: 0 };
  if (!cell) { // gemiddelde ribbelengte × 2
    let s = 0; const k = Math.min(nf, 5000);
    for (let t = 0; t < k; t++) { const a = f[t * 3] * 3, b = f[t * 3 + 1] * 3; s += Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]); }
    cell = Math.max(1e-3, 2 * s / k);
  }
  const inv = 1 / cell, grid = new Map();
  const box = new Float64Array(nf * 6);
  for (let t = 0; t < nf; t++) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < 3; k++) { const v = f[t * 3 + k] * 3; x0 = Math.min(x0, p[v]); y0 = Math.min(y0, p[v + 1]); z0 = Math.min(z0, p[v + 2]); x1 = Math.max(x1, p[v]); y1 = Math.max(y1, p[v + 1]); z1 = Math.max(z1, p[v + 2]); }
    box.set([x0, y0, z0, x1, y1, z1], t * 6);
    const i0 = Math.floor(x0 * inv), i1 = Math.floor(x1 * inv), j0 = Math.floor(y0 * inv), j1 = Math.floor(y1 * inv), k0 = Math.floor(z0 * inv), k1 = Math.floor(z1 * inv);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) * (k1 - k0 + 1) > 4096) continue; // zeer grote driehoek: overslaan
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) {
      const key = i * 73856093 ^ j * 19349663 ^ k * 83492791, kk = key + ':' + i + ',' + j + ',' + k;
      let l = grid.get(kk); if (!l) grid.set(kk, l = []); l.push(t);
    }
  }
  const hit = new Uint8Array(nf), seen = new Set();
  let pairs = 0, checked = 0;
  for (const list of grid.values()) {
    for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
      const s = list[a], t = list[b];
      // dozen overlappen?
      const os = s * 6, ot = t * 6;
      if (box[os] > box[ot + 3] || box[ot] > box[os + 3] || box[os + 1] > box[ot + 4] || box[ot + 1] > box[os + 4] || box[os + 2] > box[ot + 5] || box[ot + 2] > box[os + 5]) continue;
      const fs0 = f[s * 3], fs1 = f[s * 3 + 1], fs2 = f[s * 3 + 2], ft0 = f[t * 3], ft1 = f[t * 3 + 1], ft2 = f[t * 3 + 2];
      if (fs0 === ft0 || fs0 === ft1 || fs0 === ft2 || fs1 === ft0 || fs1 === ft1 || fs1 === ft2 || fs2 === ft0 || fs2 === ft1 || fs2 === ft2) continue;
      const key = s < t ? s * nf + t : t * nf + s;
      if (seen.has(key)) continue; seen.add(key);
      if (++checked > maxPairs) return { pairs, faces: hit, checked, truncated: true };
      if (triTri(p, f, s, t)) { pairs++; hit[s] = 1; hit[t] = 1; }
    }
  }
  return { pairs, faces: hit, checked };
}

// Snijden twee driehoeken? Een rib van de ene door het binnenste van de andere (of omgekeerd).
function triTri(p, f, s, t) {
  for (let k = 0; k < 3; k++) {
    if (segTri(p, f[s * 3 + k], f[s * 3 + (k + 1) % 3], f, t)) return true;
    if (segTri(p, f[t * 3 + k], f[t * 3 + (k + 1) % 3], f, s)) return true;
  }
  return false;
}
// Möller–Trumbore op een lijnstuk a→b tegen driehoek t (strikt binnen, met een kleine marge tegen afrondingsruis).
function segTri(p, ia, ib, f, t) {
  const a = ia * 3, b = ib * 3, v0 = f[t * 3] * 3, v1 = f[t * 3 + 1] * 3, v2 = f[t * 3 + 2] * 3;
  const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
  const e1x = p[v1] - p[v0], e1y = p[v1 + 1] - p[v0 + 1], e1z = p[v1 + 2] - p[v0 + 2], e2x = p[v2] - p[v0], e2y = p[v2 + 1] - p[v0 + 1], e2z = p[v2 + 2] - p[v0 + 2];
  const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x, det = e1x * hx + e1y * hy + e1z * hz;
  const scale = Math.hypot(e1x, e1y, e1z) * Math.hypot(e2x, e2y, e2z) * Math.hypot(dx, dy, dz);
  if (Math.abs(det) <= 1e-9 * scale) return false; // evenwijdig (coplanair telt niet mee)
  const inv = 1 / det, sx = p[a] - p[v0], sy = p[a + 1] - p[v0 + 1], sz = p[a + 2] - p[v0 + 2];
  const u = (sx * hx + sy * hy + sz * hz) * inv; if (u <= 1e-7 || u >= 1 - 1e-7) return false;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv; if (v <= 1e-7 || u + v >= 1 - 1e-7) return false;
  const w = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return w > 1e-7 && w < 1 - 1e-7;
}

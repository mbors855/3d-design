// Weefselzijde (binnenkant) uit een afgewerkt, gesloten product halen: de facetten die vanaf de weefselkant
// direct zichtbaar zijn. Resultaat is een open oppervlak dat als 'scan' voor een nieuwe lepel/beetplaat dient.
import { weld, toSoup, tidySheet, compact, edgeMap, flipAll } from './mesh.js';

/**
 * soup: Float32Array, side: -1 = weefsel aan de -z kant (3Shape-export, occlusaal naar boven), +1 = omgekeerd.
 * Geeft { soup, report } terug.
 */
export function extractIntaglio(soup, { side = -1, cell = 1, minFacing = 0.05, erode = 2 } = {}) {
  const mesh = weld(soup, 1e-5), p = mesh.positions, f = mesh.indices, nf = f.length / 3;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]); }
  const nx = Math.max(1, Math.ceil((x1 - x0) / cell)), ny = Math.max(1, Math.ceil((y1 - y0) / cell));
  // raster met per cel de facetten waarvan de XY-omhullende de cel raakt (CSR-opslag)
  const counts = new Uint32Array(nx * ny + 1);
  const cellRange = (i, out) => {
    const a = f[i * 3] * 3, b = f[i * 3 + 1] * 3, c = f[i * 3 + 2] * 3;
    out[0] = Math.max(0, Math.floor((Math.min(p[a], p[b], p[c]) - x0) / cell)); out[1] = Math.min(nx - 1, Math.floor((Math.max(p[a], p[b], p[c]) - x0) / cell));
    out[2] = Math.max(0, Math.floor((Math.min(p[a + 1], p[b + 1], p[c + 1]) - y0) / cell)); out[3] = Math.min(ny - 1, Math.floor((Math.max(p[a + 1], p[b + 1], p[c + 1]) - y0) / cell));
  };
  const r = [0, 0, 0, 0];
  for (let i = 0; i < nf; i++) { cellRange(i, r); for (let y = r[2]; y <= r[3]; y++) for (let x = r[0]; x <= r[1]; x++) counts[y * nx + x + 1]++; }
  for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
  const fill = counts.slice(0, -1), list = new Uint32Array(counts[counts.length - 1]);
  for (let i = 0; i < nf; i++) { cellRange(i, r); for (let y = r[2]; y <= r[3]; y++) for (let x = r[0]; x <= r[1]; x++) list[fill[y * nx + x]++] = i; }

  const keep = [], keepIdx = [];
  for (let i = 0; i < nf; i++) {
    const a = f[i * 3] * 3, b = f[i * 3 + 1] * 3, c = f[i * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx, l = Math.hypot(fx, fy, fz);
    if (!(l > 0) || side * fz / l < minFacing) continue;
    const cx = (p[a] + p[b] + p[c]) / 3, cy = (p[a + 1] + p[b + 1] + p[c + 1]) / 3, cz = (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
    const gx = Math.min(nx - 1, Math.floor((cx - x0) / cell)), gy = Math.min(ny - 1, Math.floor((cy - y0) / cell));
    let hidden = false;
    for (let k = counts[gy * nx + gx], e = counts[gy * nx + gx + 1]; k < e && !hidden; k++) {
      const j = list[k]; if (j === i) continue;
      const A = f[j * 3] * 3, B = f[j * 3 + 1] * 3, C = f[j * 3 + 2] * 3;
      // punt-in-driehoek in XY (barycentrisch)
      const d = (p[B + 1] - p[C + 1]) * (p[A] - p[C]) + (p[C] - p[B]) * (p[A + 1] - p[C + 1]);
      if (Math.abs(d) < 1e-14) continue;
      const w1 = ((p[B + 1] - p[C + 1]) * (cx - p[C]) + (p[C] - p[B]) * (cy - p[C + 1])) / d;
      const w2 = ((p[C + 1] - p[A + 1]) * (cx - p[C]) + (p[A] - p[C]) * (cy - p[C + 1])) / d;
      const w3 = 1 - w1 - w2;
      if (w1 < -1e-9 || w2 < -1e-9 || w3 < -1e-9) continue;
      const z = w1 * p[A + 2] + w2 * p[B + 2] + w3 * p[C + 2];
      if (side * (z - cz) > 1e-4) hidden = true; // een ander facet ligt dichter bij de weefselkant
    }
    if (!hidden) { keep.push(f[i * 3], f[i * 3 + 1], f[i * 3 + 2]); keepIdx.push(i); }
  }
  // Gaten (ondersnijdingen, steile flenswanden) opvullen met de echte productvlakken: elk samenhangend stuk van de
  // niet-gekozen vlakken dat níet met de buitenkant verbonden is, ligt ingesloten in de weefselzijde.
  const chosen = new Uint8Array(nf); for (const i of keepIdx) chosen[i] = 1;
  const parent = new Int32Array(nf).map((_, i) => i);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (const e of edgeMap(mesh).values()) if (e.count === 2 && !chosen[e.faces[0]] && !chosen[e.faces[1]]) { const a = find(e.faces[0]), b = find(e.faces[1]); if (a !== b) parent[a] = b; }
  const area = new Map();
  for (let i = 0; i < nf; i++) if (!chosen[i]) { const a = f[i * 3] * 3, b = f[i * 3 + 1] * 3, c = f[i * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const r0 = find(i); area.set(r0, (area.get(r0) || 0) + Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2); }
  let outside = -1, big = 0; for (const [r0, a] of area) if (a > big) { big = a; outside = r0; }
  let patched = 0;
  for (let i = 0; i < nf; i++) if (!chosen[i] && find(i) !== outside) { keep.push(f[i * 3], f[i * 3 + 1], f[i * 3 + 2]); patched++; }
  let out = tidySheet(compact({ positions: p, indices: Uint32Array.from(keep) })).mesh;
  // de smalle, steile randband (dikte van de flensrand) wegsnoeien
  for (let pass = 0; pass < erode; pass++) {
    const edges = edgeMap(out), border = new Set();
    for (const e of edges.values()) if (e.count === 1) { border.add(e.from); border.add(e.to); }
    const q = out.positions, g = out.indices, kept = [];
    for (let i = 0; i < g.length; i += 3) {
      const a = g[i] * 3, b = g[i + 1] * 3, c = g[i + 2] * 3;
      const ux = q[b] - q[a], uy = q[b + 1] - q[a + 1], uz = q[b + 2] - q[a + 2], vx = q[c] - q[a], vy = q[c + 1] - q[a + 1], vz = q[c + 2] - q[a + 2];
      const fz = ux * vy - uy * vx, l = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, fz);
      const steep = l > 0 && Math.abs(fz / l) < 0.5;
      if (steep && (border.has(g[i]) || border.has(g[i + 1]) || border.has(g[i + 2]))) continue;
      kept.push(g[i], g[i + 1], g[i + 2]);
    }
    out = tidySheet(compact({ positions: q, indices: Uint32Array.from(kept) })).mesh;
  }
  // normalen het product in laten wijzen (weg van het weefsel): dan bouwen lepel/beetplaat zonder 'omkeren' de goede kant op
  const res = toSoup(flipAll(out));
  return { soup: res, report: { input: nf, kept: res.length / 9, patched } };
}

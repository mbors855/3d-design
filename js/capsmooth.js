// v75: kap over de steg als glad, afgerond lichaam, zoals een technicus hem in was zou boetseren.
//
// v72–v74 bouwden de kap als prisma op een raster van 0,2 mm: rechte, verticale zijwanden met fijne trapjes
// ('streepjes'), een scherpe hoek waar de kap op de plaat staat en, vlak bij de plaatrand, een dun randje plaat onder
// een wand van 6 à 8 mm. Nu is de kap het iso-oppervlak van een veld (isofield.js):
//  - koepel: alles binnen 'wall' van de uitsparing (de steg + ruimte) — rond over de bovenkant, de zijkanten volgen de
//    steg op wanddikte;
//  - hol afgerond (± 1,6 mm) in het buitenoppervlak van de plaat over (smooth minimum): geen scherpe hoek, geen trede;
//  - bij de plaatrand loopt de kap schuin (± 63°) af naar de rand in plaats van als wand boven een dun randje te
//    blijven staan; nooit dunner dan 'wallMin' rond de uitsparing.
// Onder de plaat (halverwege de plaatwand) en ver van de steg ligt het lichaam in de plaat: na het samenvoegen
// onzichtbaar.
import { TriBVH } from './bvh.js';
import { isoField, taubin } from './isofield.js';
import { footprintFields } from './gingiva.js';

const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
const smax = (a, b, k) => -smin(-a, -b, k);

/**
 * relief: soup van de uitsparing · grid: { G, rTop, deep } uit barBlocks · plate: soup van de plaat (voor de rand)
 * scanSd(x, y, z, bound): getekende afstand tot het plaatoppervlak (positief aan de plaatkant) · gap, wall: plaat
 * Geeft { positions, indices, stats } (generator: pauzeert met yield).
 */
export function* smoothCapSteps({ relief, grid, plate, scanSd, gap, wall }, report = {}, opts = {}) {
  const { h = 0.2, fillet = 1.6, wallMin = Math.min(1.5, wall), slope = 2.0, eps = 0.15, due = () => false } = opts;
  const t0 = performance.now(), level = gap + wall;
  const { G, rTop, deep } = grid, { W, H, g, x0, y0, b } = G, U = b.U, V = b.V, N = b.N;
  const rb = new TriBVH(relief);
  // binnen de uitsparing: cel van het raster heeft een bovenkant en het punt ligt tussen 'deep' en die bovenkant
  const inside = (x, y, z) => {
    const u = x * U[0] + y * U[1] + z * U[2], w = x * V[0] + y * V[1] + z * V[2], ix = Math.floor(u / g - x0), iy = Math.floor(w / g - y0);
    if (ix < 0 || iy < 0 || ix >= W || iy >= H) return false;
    const t = rTop[iy * W + ix]; if (!(t > -Infinity)) return false;
    const d = x * N[0] + y * N[1] + z * N[2]; return d < t && d > deep;
  };
  const fpF = plate ? footprintFields(plate, { O: [0, 0, 0], X: U, Y: V, N }) : null;
  const mid = gap + Math.min(wall * 0.5, 1.25);
  const field = (x, y, z) => {
    let dr = rb.closest(x, y, z, wall + 6);
    if (dr === Infinity) return 1;
    if (inside(x, y, z)) dr = -dr;
    const sd = scanSd(x, y, z, level + 12);
    const dome = dr - wall;
    let F = sd === Infinity ? dome : smin(dome, sd - level + eps, fillet);
    if (sd !== Infinity) F = Math.max(F, mid - sd);   // onderkant: halverwege de plaatwand
    F = Math.max(F, dr - (wall + 4));                 // alleen rond de steg
    if (fpF) { // plaatrand: schuin aflopen naar de rand, maar nooit dunner dan wallMin rond de uitsparing
      const u = x * U[0] + y * U[1] + z * U[2], v = x * V[0] + y * V[1] + z * V[2], n = x * N[0] + y * N[1] + z * N[2];
      const fp = fpF.fp(u, v), B = (n - (fpF.rimN(u, v) + level + 0.3)) - slope * fp;
      F = smax(F, Math.min(B, dr - wallMin), 0.6);
      // vlak bij de rand loopt de plaat zelf rond af: daar alleen de koepel, niet de huid onder het plaatoppervlak
      F = Math.max(F, Math.min(1.6 - fp, dr - wall * 0.9));
    }
    return F;
  };
  report.field = field;
  // doos: uitsparing + wand + ruimte; startpunten: vanaf de bovenkant van de uitsparing langs de as omhoog
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < relief.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], relief[i + k]); hi[k] = Math.max(hi[k], relief[i + k]); }
  for (let k = 0; k < 3; k++) { lo[k] -= wall + 7; hi[k] += wall + 7; }
  const starts = [];
  for (let iy = 0; iy < H; iy += 6) for (let ix = 0; ix < W; ix += 6) {
    const t = rTop[iy * W + ix]; if (!(t > -Infinity)) continue;
    const u = (ix + x0 + 0.5) * g, w = (iy + y0 + 0.5) * g, d = t - 0.5;
    starts.push({ p: [0, 1, 2].map(k => U[k] * u + V[k] * w + N[k] * d), d: N, len: wall + 6 });
    if (starts.length > 400) break;
  }
  const r = largestPart(yield* isoField({ field, h, lo, hi, starts, due, label: 'kap' }));
  taubin(r.positions, r.indices, { iterations: 8 }); // rastertrapje en rimpels van de steg weg
  report.stats = r.stats; report.ms = performance.now() - t0;
  return r;
}

/** Alleen het grootste samenhangende deel houden (losse snippers bij de rand weg). */
export function largestPart(r) {
  const I = r.indices, nv = r.positions.length / 3, par = new Int32Array(nv);
  for (let i = 0; i < nv; i++) par[i] = i;
  const find = a => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  for (let t = 0; t < I.length; t += 3) { const a = find(I[t]), b = find(I[t + 1]), c = find(I[t + 2]); par[b] = a; par[find(c)] = a; }
  const cnt = new Map(); for (let t = 0; t < I.length; t += 3) { const k = find(I[t]); cnt.set(k, (cnt.get(k) || 0) + 1); }
  if (cnt.size < 2) return r;
  let best = -1, bn = 0; for (const [k, n] of cnt) if (n > bn) { bn = n; best = k; }
  const keep = []; for (let t = 0; t < I.length; t += 3) if (find(I[t]) === best) keep.push(I[t], I[t + 1], I[t + 2]);
  return { ...r, indices: Uint32Array.from(keep), stats: { ...r.stats, dropped: cnt.size - 1 } };
}

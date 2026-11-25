// Synthetische betande kaakscan (v69), intraoraal-achtig: tandvlees-hoefijzer + anatomische kronen, verenigd met
// Manifold, daarna alleen het gescande bovenoppervlak (open rand in het vestibulum / de mondbodem). Occlusaal = +Z.
// Voor tests en als demo: op zo'n scan liet de oude offset (t/m v68) de buitenkant van een plaat 'scherven'.
import { anatomicTooth } from './crowns.js';
import { layoutArch } from './teeth.js';
import { unionSoups, loadManifold } from './csg.js';
import { weld, quality, vertexNormals } from './mesh.js';

export async function dentateJaw({ noise = 0, seed = 12345, jaw = 'lower', missing = [], step = 0.4, depth = 8.5, band = 12, width = 50, archDepth = 40, columns = 56, rows = 34, palate = false } = {}) {
  const lower = jaw === 'lower';
  const all = lower ? [47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37] : [17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27];
  const ids = all.filter(id => !missing.includes(id));
  const lay = layoutArch(all, { jaw, width, depth: archDepth, form: 'oval', gap: 0.05 });
  // kamlijn = verbindingslijn door de tandposities (ook waar tanden ontbreken), iets verlengd achter de laatste molaar
  const sorted = lay.slice().sort((a, b) => a.position[0] - b.position[0]);
  const arch = sorted.map(t => t.position);
  const ext = (p, q, d) => { const v = [p[0] - q[0], p[1] - q[1]], l = Math.hypot(...v); return [p[0] + v[0] / l * d, p[1] + v[1] / l * d]; };
  arch.unshift(ext(arch[0], arch[1], 6)); arch.push(ext(arch.at(-1), arch.at(-2), 6));
  // fijn bemonsterde kamlijn voor de afstandsfunctie
  const fine = []; for (let i = 0; i < arch.length - 1; i++) for (let k = 0; k < 10; k++) { const t = k / 10; fine.push([arch[i][0] + (arch[i + 1][0] - arch[i][0]) * t, arch[i][1] + (arch[i + 1][1] - arch[i][1]) * t]); } fine.push(arch.at(-1));
  const cx = fine.reduce((s, p) => s + p[0], 0) / fine.length, cy = fine.reduce((s, p) => s + p[1], 0) / fine.length;
  const near = (x, y) => { let best = Infinity, bi = 0; for (let i = 0; i < fine.length; i++) { const d = (x - fine[i][0]) ** 2 + (y - fine[i][1]) ** 2; if (d < best) { best = d; bi = i; } } return [Math.sqrt(best), bi]; };
  // binnen de boog (palatinaal / linguaal) of buiten (buccaal)
  const inside = (x, y) => { // punt-in-polygoon van de kamlijn, gesloten via het midden achteraan
    const poly = [...fine, [fine.at(-1)[0], -50], [fine[0][0], -50]]; let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; }
    return c && y > Math.min(...fine.map(p => p[1])) - 4;
  };
  const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const top = 0.6;
  const height = (x, y) => {
    const [d] = near(x, y);
    if (palate && !lower && inside(x, y)) { // verhemelte: diep gewelf
      return top - (depth + 4) * sstep(2.5, 16, d) + 3.5 * sstep(14, 22, d);
    }
    return top - depth * sstep(2.5, band - 1, d);
  };
  const keep = (x, y) => { const [d] = near(x, y); return d <= band || (palate && !lower && inside(x, y)); };
  const xs = [], ys = [];
  const minX = Math.min(...fine.map(p => p[0])) - band - 1, maxX = Math.max(...fine.map(p => p[0])) + band + 1;
  const minY = Math.min(...fine.map(p => p[1])) - band - 1, maxY = Math.max(...fine.map(p => p[1])) + band + 1;
  for (let x = minX; x <= maxX; x += step) xs.push(x);
  for (let y = minY; y <= maxY; y += step) ys.push(y);
  const grid = xs.map(x => ys.map(y => keep(x, y) ? [x, y, height(x, y)] : null));
  // gesloten tandvleesblok: bovenkant + zijwanden + bodem
  const bottom = -depth - 6;
  const topTris = [];
  for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ys.length - 1; j++) {
    const a = grid[i][j], b = grid[i + 1][j], c = grid[i + 1][j + 1], d = grid[i][j + 1];
    if (a && b && c && d) topTris.push([a, b, c], [a, c, d]);
  }
  // randranden van de bovenkant zoeken → wanden en bodem (bodem als waaier over de rand naar een middenpunt per lus
  // is lastig bij een hoefijzer; daarom: bodem = kopie van de bovenkant op z = bottom, omgekeerd)
  const key = p => p[0].toFixed(4) + ',' + p[1].toFixed(4);
  const edges = new Map();
  for (const t of topTris) for (let k = 0; k < 3; k++) { const a = t[k], b = t[(k + 1) % 3], ka = key(a), kb = key(b), e = ka < kb ? ka + '|' + kb : kb + '|' + ka; const r = edges.get(e); if (r) r.n++; else edges.set(e, { n: 1, a, b }); }
  const out = [];
  for (const t of topTris) out.push(...t[0], ...t[1], ...t[2]);
  for (const t of topTris) { const f = p => [p[0], p[1], bottom]; out.push(...f(t[0]), ...f(t[2]), ...f(t[1])); }
  for (const e of edges.values()) if (e.n === 1) {
    // richting van de rand zoals in de bovenste driehoek (a → b): wand naar buiten
    const { a, b } = e, A = [a[0], a[1], bottom], B = [b[0], b[1], bottom];
    out.push(...b, ...a, ...A, ...b, ...A, ...B);
  }
  let gum = Float32Array.from(out);
  // wanden: richting controleren via het volume
  const q0 = quality(weld(gum, 1e-6));
  if (!q0.watertight) {
    // randrichting omdraaien
    const o2 = []; for (const t of topTris) o2.push(...t[0], ...t[1], ...t[2]);
    for (const t of topTris) { const f = p => [p[0], p[1], bottom]; o2.push(...f(t[0]), ...f(t[2]), ...f(t[1])); }
    for (const e of edges.values()) if (e.n === 1) { const { a, b } = e, A = [a[0], a[1], bottom], B = [b[0], b[1], bottom]; o2.push(...a, ...b, ...B, ...a, ...B, ...A); }
    gum = Float32Array.from(o2);
  }
  // tanden
  const teeth = [];
  for (const t of lay) {
    if (!ids.includes(t.fdi)) continue;
    const tooth = anatomicTooth(t.fdi, { columns, rows, rootLength: 5 });
    const m = [t.mesial[0], t.mesial[1], 0];
    // buccaal = loodrecht op mesiaal, van het boogmidden af
    let b = [-m[1], m[0], 0];
    const toC = [cx - t.position[0], cy - t.position[1]];
    if (b[0] * toC[0] + b[1] * toC[1] > 0) b = [-b[0], -b[1], 0];
    const up = [0, 0, 1], z0 = top - 1.6; // cervicale lijn 1,6 mm onder de tandvleesrand
    const s = tooth.soup, o = new Float32Array(s.length);
    for (let i = 0; i < s.length; i += 3) {
      const X = s[i], Y = s[i + 1], Z = s[i + 2];
      o[i] = t.position[0] + m[0] * X + up[0] * Y + b[0] * Z;
      o[i + 1] = t.position[1] + m[1] * X + up[1] * Y + b[1] * Z;
      o[i + 2] = z0 + m[2] * X + up[2] * Y + b[2] * Z;
    }
    // determinant van (m, up, b): bij −1 de driehoeken omdraaien
    const det = m[0] * (up[1] * b[2] - up[2] * b[1]) - m[1] * (up[0] * b[2] - up[2] * b[0]) + m[2] * (up[0] * b[1] - up[1] * b[0]);
    if (det < 0) for (let i = 0; i < o.length; i += 9) for (let j = 0; j < 3; j++) { const tmp = o[i + 3 + j]; o[i + 3 + j] = o[i + 6 + j]; o[i + 6 + j] = tmp; }
    teeth.push(o);
  }
  await loadManifold();
  const u = await unionSoups([gum, ...teeth]);
  // alleen het bovenoppervlak: wanden en bodem (onder de randhoogte) weg
  const rimZ = top - depth, keepF = [];
  const s = u.soup;
  for (let f = 0; f < s.length / 9; f++) {
    const o = f * 9, zc = (s[o + 2] + s[o + 5] + s[o + 8]) / 3;
    if (zc > rimZ - 1e-3) for (let k = 0; k < 9; k++) keepF.push(s[o + k]);
  }
  let soup = Float32Array.from(keepF);
  if (noise > 0) { // scannerruis: punten langs hun normaal (± noise mm) plus wat zijdelings, deterministisch
    const m = weld(soup, 1e-5), n = vertexNormals(m), p = m.positions;
    let st = seed >>> 0; const rnd = () => { st = (Math.imul(st, 1103515245) + 12345) >>> 0; return (st & 0x7fffffff) / 0x7fffffff; };
    const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());
    for (let v = 0; v < p.length / 3; v++) { const g = gauss() * noise; for (let j = 0; j < 3; j++) p[v * 3 + j] += n[v * 3 + j] * g + gauss() * noise * 0.3; }
    soup = new Float32Array(m.indices.length * 3); for (let i = 0; i < m.indices.length; i++) { const v = m.indices[i] * 3; soup[i * 3] = p[v]; soup[i * 3 + 1] = p[v + 1]; soup[i * 3 + 2] = p[v + 2]; }
  }
  return { soup, solid: s, ids, layout: lay };
}

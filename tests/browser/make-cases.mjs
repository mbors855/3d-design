// v73: synthetische testscans: demo-onderkaak en -bovenkaak met een gefreesde steg op implantaten, ook met een scan die
// vlak naast de steg ophoudt, een inham onder de steg, of een scan die onder én naast de steg ontbreekt.
// Gebruik: node tests/browser/make-cases.mjs [uitvoermap]   (standaard tests/browser/out/cases)
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname);
const outdir = process.argv[2] || path.join(here, 'out', 'cases'); mkdirSync(outdir, { recursive: true });
const J = path.resolve(here, '../../js') + '/';
const { anatomicJaw } = await import(J + 'demo.js');
const { loadManifold, fromManifold } = await import(J + 'csg.js');
const { writeSTL } = await import(J + 'stl.js');
const { quality, weld } = await import(J + 'mesh.js');
const w = await loadManifold();

// gefreesde steg langs de kamlijn: profiel (b = buccaal, z) geveegd langs y = y0 - k x², met abutments (cilinders)
function bar({ y0, k, x0 = -13, x1 = 13, zBot = 1.8, h = 4, width = 2.4, implants = [-12.5, 12.5], rImpl = 2.25, zImpl = -2.5, step = 1 }) {
  const hw = width / 2, prof = [[-hw, zBot], [hw, zBot], [hw, zBot + h - 1.1], [hw * 0.55, zBot + h - 0.25], [0, zBot + h], [-hw * 0.55, zBot + h - 0.25], [-hw, zBot + h - 1.1]];
  const crest = x => [x, y0 - k * x * x];
  const ring = x => { const [cx, cy] = crest(x), tx = 1, ty = -2 * k * x, l = Math.hypot(tx, ty), bx = -ty / l, by = tx / l; // normaal (buccaal = +y voor)
    return prof.map(([b, z]) => [cx + bx * b, cy + by * b, z]); };
  const segs = [];
  for (let x = x0; x < x1 - 1e-9; x += step) { const xe = Math.min(x1, x + step); segs.push(w.Manifold.hull([...ring(x - 0.03), ...ring(xe + 0.03)])); }
  for (const xi of implants) { const [cx, cy] = crest(xi); const c = w.Manifold.cylinder(zBot + 1.5 - zImpl, rImpl, rImpl, 40).translate([cx, cy, zImpl]); segs.push(c); }
  const u = w.Manifold.union(segs); const soup = fromManifold(u); u.delete(); for (const s of segs) s.delete();
  return soup;
}
const crestDist = (x, y, y0, k) => { let best = Infinity, sgn = 1; for (let t = -30; t <= 30; t += 0.05) { const d = Math.hypot(x - t, y - (y0 - k * t * t)); if (d < best) { best = d; sgn = y > y0 - k * t * t ? 1 : -1; } } return best * sgn; };
function filterSoup(soup, keep) { const out = []; for (let i = 0; i < soup.length; i += 9) { const cx = (soup[i] + soup[i + 3] + soup[i + 6]) / 3, cy = (soup[i + 1] + soup[i + 4] + soup[i + 7]) / 3; if (keep(cx, cy)) for (let k = 0; k < 9; k++) out.push(soup[i + k]); } return Float32Array.from(out); }
const cat = (...a) => { const o = new Float32Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
function save(name, soup) { const buf = writeSTL(soup, name); const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer ? buf.buffer : buf); writeFileSync(`${outdir}/${name}.stl`, data); console.log(name, soup.length / 9, 'facetten'); }

// A: onderkaak, steg 33–43 langs de kam, volledige scan
{
  const { soup, truth } = anatomicJaw({ jaw: 'lower' }), { y0, k } = truth.archY;
  const b = bar({ y0, k }); const q = quality(weld(b, 1e-5)); console.log('steg A', JSON.stringify(q));
  save('ok_steg_volledig', cat(soup, b));
  // B: zelfde, maar de scan houdt linguaal vlak naast de steg op (front) en onder de steg zit een gat
  const scanB = filterSoup(soup, (x, y) => { const d = crestDist(x, y, y0, k); if (Math.abs(x) < 14.5 && d < -2.3) return false; if (Math.abs(x) < 13.2 && Math.abs(d) < 1.6) return false; return true; });
  save('ok_steg_scanrand', cat(scanB, b));
  // B2: scan houdt linguaal 1 mm naast de steg op (front), onder de steg wel gescand
  const scanB2 = filterSoup(soup, (x, y) => { const d = crestDist(x, y, y0, k); return !(Math.abs(x) < 14.5 && d < -2.2); });
  save('ok_steg_linguaal1mm', cat(scanB2, b));
  // B3: zoals B2, plus een inham onder de steg vanuit linguaal (8 mm breed, tot onder de buccale kant van de steg)
  const scanB3 = filterSoup(soup, (x, y) => { const d = crestDist(x, y, y0, k); if (Math.abs(x) < 14.5 && d < -2.2) return false; if (Math.abs(x) < 4 && d < 1.0) return false; return true; });
  save('ok_steg_inham', cat(scanB3, b));
}
// C: bovenkaak met torus, steg op 4 implantaten (14–24)
{
  const { soup, truth } = anatomicJaw({ jaw: 'upper', torus: true }), { y0, k } = truth.archY;
  const b = bar({ y0, k, x0: -16, x1: 16, implants: [-15, -6, 6, 15], zBot: 1.6, h: 3.6 }); const q = quality(weld(b, 1e-5)); console.log('steg C gesloten', q.watertight, 'niet-manifold', q.nonManifold);
  save('bk_steg_4impl', cat(soup, b));
}

// v73: end-to-end in Chrome (Playwright): STL openen, instellingen zetten, ⚡ Alles automatisch, resultaat meten.
//   node tests/browser/make-cases.mjs            (maakt de testscans met steg in tests/browser/out/cases)
//   node tests/browser/e2e.mjs [cases.json] [uitvoermap]     ONLY=<regex> om een deel te draaien, WARN=1 voor waarschuwingen
// Geen webserver nodig: de testbrowser krijgt de bestanden van de repo rechtstreeks van schijf (http://ddcad.test/).
// Per geval: gesloten / niet-manifold / losse delen / zelfdoorsnijdingen van elk werkstuk, de meldingen, een schermafdruk
// en de ontwerpen als float32-soup (voor eigen metingen).
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname);
const REPO = process.env.REPO || path.resolve(here, '../..');
let chromium; try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { ({ chromium } = createRequire('/opt/npm-tools/node_modules/')('playwright')); }
const casesFile = process.argv[2] || path.join(here, 'cases.json'), outdir = process.argv[3] || path.join(here, 'out', 'run');
const cases = JSON.parse(readFileSync(casesFile, 'utf8'));
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
mkdirSync(outdir, { recursive: true });
const args = (process.env.CHROME_ARGS || '--use-angle=swiftshader').split(' ').filter(Boolean);
const exe = process.env.CHROME || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
const browser = await chromium.launch({ executablePath: exe, headless: true, args });
const summary = [];
const b64of = 'const b64 = a => { const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); let s = ""; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return btoa(s); };';
for (const c of cases) {
  if (only && !only.test(c.name)) continue;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true, locale: 'nl-NL' });
  // geen webserver nodig: de testbrowser krijgt de bestanden van de repo rechtstreeks van schijf
  await ctx.route('http://ddcad.test/**', route => {
    const url = new URL(route.request().url()), rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = `${REPO}/${rel}`, ext = rel.split('.').pop();
    const type = { js: 'text/javascript', mjs: 'text/javascript', html: 'text/html', css: 'text/css', wasm: 'application/wasm', json: 'application/json', txt: 'text/plain', svg: 'image/svg+xml', png: 'image/png' }[ext] || 'application/octet-stream';
    try { return route.fulfill({ status: 200, contentType: type, body: readFileSync(file) }); } catch { return route.fulfill({ status: 404, body: 'niet gevonden' }); }
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  const warns = [];
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); else if (m.type() === 'warning' || (m.type() === 'info' && process.env.INFO)) warns.push(m.text()); });
  const t0 = Date.now();
  await page.goto('http://ddcad.test/index.html', { waitUntil: 'load' });
  await page.waitForFunction(() => window.ddcad && document.querySelector('#autoAll'));
  const set = async (id, v) => page.evaluate(([id, v]) => { const e = document.getElementById(id); if (!e) throw Error('geen #' + id); if (e.type === 'checkbox') e.checked = !!v; else e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, [id, v]);
  await set('work', c.work); await set('jaw', c.jaw);
  for (const [id, v] of Object.entries(c.pre || {})) await set(id, v);
  if (c.file) await page.setInputFiles('#fileScan', path.resolve(here, c.file));
  else await page.click('#demoBtn');
  await page.waitForFunction(() => window.ddcad.S.scan && document.getElementById('busy').classList.contains('hide'), null, { timeout: 120000 });
  for (const [id, v] of Object.entries(c.settings || {})) await set(id, v);
  if (c.partMode) await page.evaluate(m => window.ddcad.setPartMode(0, m), c.partMode);
  await page.evaluate(async () => { document.getElementById('autoAll').click(); await new Promise(r => setTimeout(r, 300)); while (window.ddcad.S.autoRunning) await new Promise(r => setTimeout(r, 250)); });
  // extra stappen (bv. instelling wijzigen en opnieuw bouwen)
  for (const step of c.after || []) {
    if (step.set) for (const [id, v] of Object.entries(step.set)) await set(id, v);
    if (step.click) { await page.click('#' + step.click); await page.waitForTimeout(300); await page.waitForFunction(() => document.getElementById('busy').classList.contains('hide'), null, { timeout: 600000 }); }
  }
  if (c.evalAfter) { const r = await page.evaluate(new Function(`return (async () => { ${c.evalAfter} })();`)); console.log('  evalAfter:', typeof r === 'string' ? r : JSON.stringify(r)); }
  const res = await page.evaluate(async () => {
    const { weld, quality } = await import('./js/mesh.js'); const { selfIntersections } = await import('./js/meshcheck.js');
    const S = window.ddcad.S, out = { plates: {} };
    for (const [k, p] of Object.entries(S.plates)) {
      if (!p?.soup) continue;
      const m = weld(p.soup, 1e-6), q = quality(m), si = selfIntersections(m, { maxPairs: 2e7 });
      out.plates[k] = { file: p.file, faces: q.faces, open: q.open, nonManifold: q.nonManifold, components: q.components, volume: +Math.abs(q.volume).toFixed(1), watertight: q.watertight, selfPairs: si.pairs };
    }
    const txt = id => (document.getElementById(id)?.innerText || '').trim();
    out.result = { lepel: txt('lepelResult'), beet: txt('beetResult'), basis: txt('basisResult') };
    out.autoLog = txt('autoLog'); out.status = txt('status');
    out.parts = (S.parts || []).map(p => ({ kind: p.kind, mode: p.mode, faces: p.faces, size: p.size.map(v => +v.toFixed(1)) }));
    out.frame = S.frame ? { O: S.frame.O, N: S.frame.N, X: S.frame.X, Y: S.frame.Y } : null;
    return out;
  });
  // ontwerpen als ruwe float32-soup bewaren (voor afbeeldingen en metingen)
  const stls = await page.evaluate(new Function(`${b64of} const S = window.ddcad.S, o = {}; for (const [k, p] of Object.entries(S.plates)) if (p?.soup) o[k] = b64(p.soup); if (S.scan) o.__scan = b64(S.scan); (S.parts || []).forEach((p, i) => { o['__part' + i] = b64(p.soup); }); for (const [k, v] of Object.entries(window.__save || {})) o['x_' + k] = b64(v); return o;`));
  for (const [k, b] of Object.entries(stls)) writeFileSync(`${outdir}/${c.name}__${k}.f32`, Buffer.from(b, 'base64'));
  const outl = await page.evaluate(() => { const S = window.ddcad.S, o = {}; for (const k of ['lepel', 'beetplaat', 'basis']) { const s = S.contours.get(k); if (s?.points?.length) o[k] = { points: s.points, edge: s.edge ?? null, closed: s.closed }; } o.designedFrom = S.designedFrom ?? null; o.frame = S.frame ?? null; return o; });
  writeFileSync(`${outdir}/${c.name}__outline.json`, JSON.stringify(outl));
  await page.screenshot({ path: `${outdir}/${c.name}.png` });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  summary.push({ name: c.name, secs, errors, ...res });
  console.log(`\n=== ${c.name} (${secs} s) ===`);
  for (const [k, p] of Object.entries(res.plates)) console.log(`  ${k}: ${p.faces} f · open ${p.open} · niet-manifold ${p.nonManifold} · delen ${p.components} · overlap ${p.selfPairs} · vol ${p.volume} · ${p.file}`);
  console.log('  log:', res.autoLog.replace(/\n/g, ' | ').slice(0, 400));
  const r = res.result[c.work === 'beetplaat' ? 'beet' : c.work === 'lepel' ? 'lepel' : 'basis'];
  console.log('  resultaat:', r.replace(/\n/g, ' ').slice(0, 1200));
  if (res.parts.length) console.log('  onderdelen:', JSON.stringify(res.parts));
  if (errors.length) console.log('  FOUTEN:', errors.slice(0, 5).join(' || '));
  if (warns.length && process.env.WARN) console.log('  WAARSCHUWINGEN:', warns.slice(0, 8).join(' || ').slice(0, 1500));
  await ctx.close();
}
writeFileSync(`${outdir}/summary.json`, JSON.stringify(summary, null, 1));
await browser.close();

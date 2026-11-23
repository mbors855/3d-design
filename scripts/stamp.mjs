// Gebruik: node scripts/stamp.mjs
// Schrijft in index.html en orders.html een import-map waarin elke module een ?v=<versie> krijgt. Zo laadt de browser
// na een update altijd een consistente set bestanden (geen mix van oude en nieuwe modules uit de cache).
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const VERSION = fs.readFileSync(path.join(root, 'js/version.js'), 'utf8').match(/VERSION = '([^']+)'/)[1];
const major = VERSION.split('.')[0];
const mods = ['js', 'js/steps', 'js/ui'].flatMap(d => fs.existsSync(path.join(root, d)) ? fs.readdirSync(path.join(root, d)).filter(f => f.endsWith('.js')).map(f => `./${d}/${f}`) : []);
const vendor = fs.readdirSync(path.join(root, 'vendor')).filter(f => f.endsWith('.js')).map(f => `./vendor/${f}`);
export function importMap() {
  const imports = { three: `./vendor/three.module.js?v=${VERSION}` };
  for (const m of [...mods, ...vendor].sort()) imports[m] = `${m}?v=${VERSION}`;
  return `<script type="importmap">${JSON.stringify({ imports }, null, 1).replace(/\n\s*/g, ' ')}</script>`;
}
for (const [file, entry] of [['index.html', 'js/main.js'], ['orders.html', 'js/orders-ui.js']]) {
  const p = path.join(root, file);
  let s = fs.readFileSync(p, 'utf8');
  s = s.replace(/<script type="importmap">[\s\S]*?<\/script>/, importMap());
  s = s.replace(new RegExp(`<script type="module" src="${entry.replace('.', '\\.')}(\\?v=[^"]*)?"></script>`), `<script type="module" src="${entry}?v=${VERSION}"></script>`);
  s = s.replace(/(<title>[^<]*?)\d+(\.\d+)*(<\/title>)/, `$1${VERSION}$3`).replace(/(Digital Denture CAD <span>)[^<]*(<\/span>)/, `$1${VERSION}$2`);
  fs.writeFileSync(p, s);
}
if (process.argv[1] === new URL(import.meta.url).pathname) console.log(`Gestempeld: versie ${VERSION}, ${mods.length + vendor.length} modules.`);

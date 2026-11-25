// Gebruik: node scripts/i18n-build.mjs
// Leest de vertalingen in i18n/*.txt (regel: Nederlands ⟫ English ⟫ Deutsch; # = commentaar) en schrijft
// js/i18n-data.js. Controleert dat elke regel drie delen heeft en dat {0}, {1} … in alle talen overeenkomen.
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = path.join(root, 'i18n');
const data = new Map(), problems = [];
const ph = s => [...s.matchAll(/\{(\d+)\}/g)].map(m => m[1]).sort().join(',');
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.txt')).sort()) {
  fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim() || line.startsWith('#')) return;
    const parts = line.split(' ⟫ ');
    if (parts.length !== 3) { problems.push(`${f}:${i + 1}: verwacht 3 delen, gevonden ${parts.length}`); return; }
    const [nl, en, de] = parts.map(s => s.replace(/\s+/g, ' ').trim());
    if (!nl || !en || !de) { problems.push(`${f}:${i + 1}: leeg deel`); return; }
    const src = new Set(ph(nl).split(','));
    if ([...ph(en).split(','), ...ph(de).split(',')].some(p => p && !src.has(p))) problems.push(`${f}:${i + 1}: vertaling heeft een {n} die niet in de bron staat (${nl})`);
    const old = data.get(nl);
    if (old && (old[0] !== en || old[1] !== de)) problems.push(`${f}:${i + 1}: dubbel met andere vertaling: ${nl}`);
    data.set(nl, [en, de]);
  });
}
const body = [...data].map(([k, v]) => `  ${JSON.stringify(k)}: [${JSON.stringify(v[0])}, ${JSON.stringify(v[1])}],`).join('\n');
fs.writeFileSync(path.join(root, 'js/i18n-data.js'), `// v71: woordenboek Nederlands → [English, Deutsch]. Sleutel = de Nederlandse tekst zoals die in het programma staat
// ({0}, {1} = ingevulde waarden). Gegenereerd uit i18n/*.txt met scripts/i18n-build.mjs: daar bewerken, niet hier.
export default {
${body}
};
`);
if (process.argv[1] === new URL(import.meta.url).pathname) {
  console.log(`i18n: ${data.size} teksten.`);
  if (problems.length) { console.log(problems.join('\n')); process.exitCode = 1; }
}

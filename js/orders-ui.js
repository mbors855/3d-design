// Orderoverzicht: inlezen, tonen, printsimulatie en overdracht naar het CAD-programma.
import { tr } from './i18n.js'; // v71: taalkeuze (moet als eerste: vertaalt de pagina vóór de rest opbouwt)
import { listZip, readZipEntry } from './unzip.js';
import { decodeText, stlMetrics, analyseOrders, simulatePrint, PRINTERS, PRODUCTS, classifyGeometry, suggestedName, namingStyle } from './orders.js';
import { putHandoff } from './handoff.js';
import { parseSTL } from './stl.js';

const $ = id => document.getElementById(id);
const fmt = (v, d = 0) => Number(v).toLocaleString('nl-NL', { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const today = new Date().toISOString().slice(0, 10);
let R = null, SOURCES = new Map(), FILTER = 'all';
const WHERE = /iPhone|iPad|iPod/.test(navigator.userAgent) ? 'Bestanden → Downloads' : /Android/.test(navigator.userAgent) ? 'Mijn bestanden → Downloads' : 'map Downloads';

function toast(text, error = false) { const t = $('toast'); t.textContent = text; t.classList.toggle('error', error); t.classList.remove('hide'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hide'), error ? 6000 : 2800); }
function progress(done, total, label) {
  $('progress').classList.remove('hide');
  $('progress').querySelector('i').style.width = (total ? done / total * 100 : 0) + '%';
  $('progress').querySelector('span').textContent = label;
}
const tick = () => new Promise(r => setTimeout(r, 0));
const wanted = n => /\.(stl|3ox|inf|pts)$/i.test(n) && !/(^|\/)(__MACOSX|\.)/.test(n.replace(/^.*\//, '/'));

// ---------- inlezen ----------
async function ingest(list) { // list: [{ name, size, read: () => Promise<ArrayBuffer> }]
  list = list.filter(f => wanted(f.name));
  if (!list.length) return toast('Geen 3Shape-bestanden (.stl/.3ox/.inf/.pts) gevonden.', true);
  SOURCES = new Map();
  const files = [];
  // eerst de kleine tekstbestanden, dan de STL's
  list.sort((a, b) => /\.stl$/i.test(a.name) - /\.stl$/i.test(b.name) || a.name.localeCompare(b.name));
  for (let i = 0; i < list.length; i++) {
    const f = list[i], name = f.name.replace(/^.*\//, '');
    progress(i, list.length, `${i + 1}/${list.length} · ${name}`); await tick();
    const rec = { name, size: f.size };
    try {
      const buf = await f.read();
      if (/\.stl$/i.test(name)) { rec.metrics = stlMetrics(buf); SOURCES.set(name, f.read); }
      else rec.text = decodeText(buf);
    } catch (e) { rec.error = e.message; }
    files.push(rec);
  }
  progress(list.length, list.length, 'Analyseren…'); await tick();
  R = analyseOrders(files, { today });
  $('drop').classList.add('hide'); $('report').classList.remove('hide');
  render();
}

async function fromZip(file) {
  try {
    progress(0, 1, 'ZIP-inhoud lezen…');
    const entries = await listZip(file);
    await ingest(entries.map(e => ({ name: e.name, size: e.usize, read: () => readZipEntry(file, e) })));
  } catch (e) { toast('ZIP kon niet gelezen worden: ' + e.message, true); }
}
async function fromFiles(fileList) {
  const arr = [...fileList];
  const zips = arr.filter(f => /\.zip$/i.test(f.name));
  if (zips.length && arr.length === zips.length) return fromZip(zips[0]);
  await ingest(arr.map(f => ({ name: f.webkitRelativePath || f.name, size: f.size, read: () => f.arrayBuffer() })));
}
$('pickZip').addEventListener('change', e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) fromZip(f); });
$('pickFiles').addEventListener('change', e => { const l = e.target.files; if (l?.length) fromFiles(l); e.target.value = ''; });
$('pickDir').addEventListener('change', e => { const l = e.target.files; if (l?.length) fromFiles(l); e.target.value = ''; });
if (!('webkitdirectory' in document.createElement('input'))) $('pickDirLabel').classList.add('hide');
const drop = $('drop');
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => { const l = e.dataTransfer.files; if (l?.length) fromFiles(l); });
$('resetBtn').onclick = () => { R = null; SOURCES = new Map(); $('report').classList.add('hide'); $('drop').classList.remove('hide'); $('progress').classList.add('hide'); };

// ---------- weergave ----------
const levelClass = l => l === 'fout' ? 'fout' : l === 'let op' ? 'letop' : 'info';
function orderMatches(o) {
  if (FILTER === 'fout') return o.issues.some(i => i[0] === 'fout');
  if (FILTER === 'let op') return o.issues.some(i => i[0] === 'let op');
  if (FILTER === 'late') return o.late;
  return true;
}
function render() {
  const t = R.totals, late = R.orders.filter(o => o.late).length;
  const parts = printableParts();
  $('tiles').innerHTML = [
    ['', t.orders, 'orders'], ['', t.patients, 'patiënten'], ['', t.stl, "STL's"],
    [t.errors ? 'bad' : 'good', t.errors, 'orders met fout'], [t.warnings ? 'warn' : 'good', t.warnings, 'orders met "let op"'],
    [late ? 'warn' : '', late, 'levering verstreken'], ['', fmt(parts.reduce((s, p) => s + p.volume, 0) / 1000 * 1.35), 'ml hars (incl. supports)'],
  ].map(([c, v, l]) => `<div class="op-tile ${c}"><b>${v}</b><span>${l}</span></div>`).join('');
  renderPatients(); renderSim(); renderNaming();
}
function renderPatients() {
  const q = $('search').value.trim().toLowerCase();
  const html = [];
  const sorted = [...R.patients].sort((a, b) => (a.orderNo ?? 'zzzz').localeCompare(b.orderNo ?? 'zzzz') || a.name.localeCompare(b.name));
  for (const p of sorted) {
    if (q && !(p.name.toLowerCase().includes(q) || (p.orderNo ?? '').includes(q) || p.orders.some(o => o.key.toLowerCase().includes(q)))) continue;
    const orders = p.orders.filter(orderMatches);
    if (!orders.length) continue;
    const deliveries = [...new Set(p.orders.map(o => o.delivery).filter(Boolean))].sort();
    html.push(`<article class="op-patient"><div class="head"><span class="nr" translate="no">${esc(p.orderNo ?? '––––')}</span><span class="name" translate="no">${esc(p.name)}</span>
      ${p.jaws.map(j => `<span class="chip jaw">${esc(j.toUpperCase())}</span>`).join('')}${p.note ? `<span class="chip">${esc(p.note)}</span>` : ''}
      <span class="meta">${deliveries.length ? 'levering ' + deliveries.join(', ') : 'geen leverdatum'}</span></div>
      ${orders.map(orderHtml).join('')}</article>`);
  }
  $('patients').innerHTML = html.join('') || '<p class="note">Niets gevonden met dit filter.</p>';
}
function orderHtml(o) {
  const stls = o.stl.map(s => {
    const m = s.metrics, g = m && classifyGeometry(m);
    const info = m ? `${fmt(m.volume / 1000, 1)} ml · ${m.dims.map(v => fmt(v)).join('×')} mm · ${fmt(m.triangles)} △ ${m.watertight ? '<span class="chip ok">gesloten</span>' : '<span class="chip late">open</span>'}${g === 'fragment' ? ' <span class="chip late">fragment</span>' : ''}` : esc(s.error ?? '');
    const canOpen = m && g !== 'fragment' && g !== 'provisorium';
    return `<div class="stl"><span class="file" translate="no">${esc(s.file)}</span><span>${info}</span>
      ${canOpen ? `<button data-open="${esc(s.file)}" title="Open in CAD en haal de weefselzijde eruit">🦷 Nieuwe plaat hierop</button>` : ''}
      <button data-view="${esc(s.file)}" title="Bekijk in 3D">👁</button><button data-download="${esc(s.file)}" title="Download">↓</button></div>`;
  }).join('');
  return `<div class="op-order"><div class="line"><span class="chip p-${esc(o.product)}">${esc(PRODUCTS[o.product] ?? o.product)}</span>
    ${o.jaw ? `<span class="chip jaw">${esc(o.jaw.toUpperCase())}</span>` : ''}
    ${o.teeth.length ? `<span class="sub">element ${o.teeth.join(', ')}</span>` : ''}
    ${o.late ? `<span class="chip late">levering ${esc(o.delivery)} verstreken</span>` : o.delivery ? `<span class="sub">levering ${esc(o.delivery)}</span>` : ''}
    ${o.operator ? `<span class="sub">door ${esc(o.operator)}</span>` : ''}<span class="sub">${esc(o.source)}</span>
    ${o.pts.length ? `<span class="sub">${o.pts.length} curvebestand(en)</span>` : ''}</div>
    <div class="file" translate="no">${esc(o.key)}</div>
    <div class="stls">${stls}</div>
    ${o.issues.length ? `<ul class="issues">${o.issues.map(([l, t]) => `<li class="${levelClass(l)}">${esc(t)}</li>`).join('')}</ul>` : ''}</div>`;
}
document.querySelector('.seg').addEventListener('click', e => {
  const b = e.target.closest('[data-filter]'); if (!b) return;
  FILTER = b.dataset.filter; for (const x of document.querySelectorAll('.seg button')) x.classList.toggle('active', x === b); renderPatients();
});
$('search').addEventListener('input', renderPatients);
$('patients').addEventListener('click', async e => {
  const vw = e.target.closest('[data-view]');
  if (vw) { const read = SOURCES.get(vw.dataset.view); if (read) showStl(vw.dataset.view, await read()); return; }
  const dl = e.target.closest('[data-download]'), op = e.target.closest('[data-open]');
  const name = (dl || op)?.dataset.download ?? (dl || op)?.dataset.open; if (!name) return;
  const read = SOURCES.get(name); if (!read) return toast('Bestand niet meer beschikbaar.', true);
  const buf = await read();
  if (dl) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([buf], { type: 'model/stl' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); toast(`Opgeslagen: ${name} → ${WHERE}`); return; }
  const o = R.orders.find(x => x.stl.some(s => s.file === name));
  try {
    await putHandoff({ name, buffer: buf, extract: true, product: o?.product, jaw: o?.jaw, caseName: o ? suggestedName(o, R.patients.find(p => p.orders.includes(o))?.name ?? '') : name });
    location.href = 'index.html?handoff=1';
  } catch (err) { toast('Doorgeven aan CAD mislukt: ' + err.message, true); }
});

// ---------- printsimulatie ----------
for (const [k, p] of Object.entries(PRINTERS)) $('simPrinter').insertAdjacentHTML('beforeend', `<option value="${k}">${esc(p.label)} · ${p.x}×${p.y}×${p.z} mm</option>`);
try { const s = JSON.parse(localStorage.getItem('ddcad-sim') || '{}'); for (const k of ['simPrinter', 'simOrient', 'simLayer', 'simResin', 'simLayerSec']) if (s[k] && (k !== 'simPrinter' || PRINTERS[s[k]])) $(k).value = s[k]; } catch { /* */ }
for (const id of ['simPrinter', 'simOrient', 'simLayer', 'simResin', 'simUntil', 'simLayerSec']) $(id).addEventListener('change', () => {
  try { localStorage.setItem('ddcad-sim', JSON.stringify(Object.fromEntries(['simPrinter', 'simOrient', 'simLayer', 'simResin', 'simLayerSec'].map(k => [k, $(k).value])))); } catch { /* */ }
  if (R) renderSim();
});
function printableParts() {
  const until = $('simUntil').value;
  return R.orders.filter(o => !until || !o.delivery || o.delivery <= until).flatMap(o => o.stl
    .filter(s => s.metrics && s.metrics.watertight && classifyGeometry(s.metrics) !== 'fragment')
    .map(s => ({ id: s.file, label: s.file.replace(/\.stl$/i, ''), dims: s.metrics.dims, volume: s.metrics.volume, product: o.product })));
}
const PALETTE = { lepel: '#3fb7c2', beetplaat: '#7c8cf0', beetwal: '#c58be8', copydenture: '#e0c45c', provisorium: '#ef8a7a', onbekend: '#8aa1b1' };
function renderSim() {
  const sim = simulatePrint(printableParts(), { printer: $('simPrinter').value, orientation: $('simOrient').value, layer: +$('simLayer').value, resinPerL: +$('simResin').value || 0, layerSec: +$('simLayerSec').value || null });
  const h = Math.floor(sim.minutes / 60), m = sim.minutes % 60;
  $('simSummary').innerHTML = `<b>${sim.plates.length}</b> ${sim.plates.length === 1 ? 'printplaat' : 'printplaten'} · ca. <b>${h} u ${m} min</b> printtijd · <b>${fmt(sim.resinMl)} ml</b> hars (≈ €${fmt(sim.resinCost)})`
    + (sim.tooBig.length ? ` · <span style="color:var(--bad)">${sim.tooBig.length} past niet: ${sim.tooBig.map(i => esc(i.label)).join(', ')}</span>` : '');
  const P = sim.printer;
  $('simPlates').innerHTML = sim.plates.map((pl, i) => {
    const rects = pl.items.map(it => `<g><rect x="${it.at[0] + 1}" y="${it.at[1] + 1}" width="${it.w - 4}" height="${it.d - 4}" rx="3" fill="${PALETTE[it.product] ?? '#8aa1b1'}" fill-opacity=".55" stroke="${PALETTE[it.product] ?? '#8aa1b1'}"><title>${esc(it.label)} · ${it.mode} · ${fmt(it.h)} mm hoog</title></rect>
      <text x="${it.at[0] + 4}" y="${it.at[1] + Math.min(14, it.d - 6)}" font-size="${Math.max(5, Math.min(8, (it.w - 6) / 10))}" fill="#e8f2f8">${esc(it.label.slice(0, Math.max(6, Math.floor(it.w / 5))))}</text></g>`).join('');
    const modes = [...new Set(pl.items.map(it => it.mode))].join(', ');
    return `<div class="op-plate"><h3>Plaat ${i + 1}<span>${pl.items.length} st · ${pl.minutes} min · ${fmt(pl.height)} mm hoog · ${fmt(pl.resinMl)} ml</span></h3>
      <svg viewBox="0 0 ${P.x} ${P.y}" role="img" aria-label="Indeling printplaat ${i + 1}"><rect width="${P.x}" height="${P.y}" fill="none" stroke="#2d5068"/>${rects}</svg><p class="sub">Oriëntatie: ${esc(modes)}</p></div>`;
  }).join('');
}

// ---------- naamgeving ----------
function renderNaming() {
  const styles = R.totals.namingStyles;
  $('namingNote').textContent = styles.length > 1 ? `Er worden ${styles.length} verschillende naamopbouwen gebruikt (${styles.join(', ')}). Eén vaste opbouw maakt automatisch koppelen en zoeken betrouwbaarder: ordernummer · patiënt · werkstuk · kaak.` : 'Alle namen volgen dezelfde opbouw.';
  const rows = R.orders.map(o => { const p = R.patients.find(x => x.orders.includes(o)); return [o.key, suggestedName(o, p?.name ?? o.name.patient)]; }).sort((a, b) => a[1].localeCompare(b[1]));
  $('namingTable').querySelector('tbody').innerHTML = rows.map(([a, b]) => `<tr class="${a === b ? 'same' : ''}"><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join('');
  $('copyNames').onclick = async () => { try { await navigator.clipboard.writeText(rows.map(r => r.join('\t')).join('\n')); toast('Lijst gekopieerd.'); } catch { toast('Kopiëren niet toegestaan in deze browser.', true); } };
}

// ---------- export ----------
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
$('exportCsv').onclick = () => {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['ordernr', 'patiënt', 'order', 'werkstuk', 'kaak', 'elementen', 'levering', 'operator', 'bron', 'stl', 'volume_ml', 'gesloten', 'niveau', 'melding'].map(h => tr(h))]; // v71: in de gekozen taal
  for (const p of R.patients) for (const o of p.orders) {
    const vol = o.stl.reduce((s, x) => s + (x.metrics?.volume ?? 0), 0) / 1000, closed = o.stl.every(x => x.metrics?.watertight);
    const base = [p.orderNo, p.name, o.key, tr(PRODUCTS[o.product] ?? o.product), o.jaw, o.teeth.join(' '), o.delivery, o.operator, o.source, o.stl.length, vol.toFixed(2), tr(closed ? 'ja' : 'nee')];
    if (!o.issues.length) rows.push([...base, '', '']); else for (const [l, t] of o.issues) rows.push([...base, tr(l), tr(t)]);
  }
  download(`orders_${today}.csv`, '﻿' + rows.map(r => r.map(q).join(';')).join('\r\n'), 'text/csv');
};
$('exportJson').onclick = () => download(`orders_${today}.json`, JSON.stringify({ created: new Date().toISOString(), totals: R.totals, patients: R.patients.map(p => ({ orderNo: p.orderNo, name: p.name, jaws: p.jaws, orders: p.orders.map(o => ({ key: o.key, product: o.product, jaw: o.jaw, teeth: o.teeth, delivery: o.delivery, operator: o.operator, source: o.source, issues: o.issues, stl: o.stl.map(s => ({ file: s.file, ...s.metrics })) })) })) }, null, 1), 'application/json');

// ---------- 3D-voorbeeld ----------
let V = null;
async function showStl(name, buffer) {
  const THREE = await import('three'), { OrbitControls } = await import('../vendor/OrbitControls.js');
  const host = $('stlView'); $('stlModal').classList.remove('hide'); $('stlTitle').textContent = name;
  if (!V) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); renderer.setPixelRatio(Math.min(2, devicePixelRatio)); host.appendChild(renderer.domElement);
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, 1, 0.1, 5000);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.6)); const sun = new THREE.DirectionalLight(0xffffff, 1.6); camera.add(sun); sun.position.set(0.5, 1, 1); scene.add(camera);
    const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true;
    V = { THREE, renderer, scene, camera, controls, mesh: null };
    const size = () => { const r = host.getBoundingClientRect(); renderer.setSize(r.width, r.height, false); camera.aspect = r.width / Math.max(1, r.height); camera.updateProjectionMatrix(); };
    new ResizeObserver(size).observe(host);
    const loop = () => { if (!$('stlModal').classList.contains('hide')) { controls.update(); renderer.render(scene, camera); } requestAnimationFrame(loop); }; loop();
  }
  if (V.mesh) { V.scene.remove(V.mesh); V.mesh.geometry.dispose(); }
  const soup = parseSTL(buffer), g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(soup, 3)); g.computeVertexNormals(); g.computeBoundingBox();
  const m = R.orders.flatMap(o => o.stl).find(x => x.file === name)?.metrics, cls = m && classifyGeometry(m);
  const color = { beetwal: 0xc58be8, provisorium: 0xf4f0e6, fragment: 0xff7b86 }[cls] ?? (/lepel/i.test(name) ? 0xffb45c : 0x39c5ff);
  V.mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0, side: THREE.DoubleSide })); V.scene.add(V.mesh);
  const box = g.boundingBox, c = box.getCenter(new THREE.Vector3()), d = box.getSize(new THREE.Vector3()).length();
  V.controls.target.copy(c); V.camera.position.copy(c).add(new THREE.Vector3(0, -0.9, 1.2).normalize().multiplyScalar(d * 1.5)); V.camera.up.set(0, 0, 1); V.controls.update();
  $('stlInfo').textContent = m ? `${fmt(m.dims[0], 1)} × ${fmt(m.dims[1], 1)} × ${fmt(m.dims[2], 1)} mm · ${fmt(m.volume / 1000, 2)} ml · ${fmt(m.triangles)} driehoeken · ${m.watertight ? 'gesloten' : 'open'} · slepen = draaien, knijpen = zoomen` : '';
}
$('stlClose').onclick = () => $('stlModal').classList.add('hide');
$('stlModal').addEventListener('click', e => { if (e.target === $('stlModal')) $('stlModal').classList.add('hide'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('stlModal').classList.add('hide'); });

window.ddorders = { get R() { return R; }, ingest, fromZip }; // voor tests

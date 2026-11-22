// Digital Denture CAD 60 — hoofdmodule: koppelt interface, 3D-werkruimte en rekenmodules.
import * as THREE from 'three';
import { Viewer, makePolyline, makeDots, makeMesh, COLORS } from './viewer.js';
import { parseSTL, writeSTL, soupBounds, toBase64, fromBase64, concatSoups } from './stl.js';
import { weld, quality, repair, toSoup, flipSoup, applyMatrixToSoup, boundaryLoops } from './mesh.js';
import { shell } from './shell.js';
import { ContourSet } from './contour.js';
import { occlusalAxis, autoLandmarks, undercutMarks, vec } from './analysis.js';
import { archFrame, defaultFrame, placeTeeth, autoOcclude, contactMap, clearContactMap, framePoint, archPoint } from './setup.js';
import { FDI_UPPER, FDI_LOWER } from './teeth.js';
import { biteRim, gingivaBand, trayHandle, perforations, tissueStops } from './construct.js';
import { unionSoups, subtractSoups, loadManifold } from './csg.js';
import { demoJaw, demoAntagonist } from './demo.js';
import { makeZip } from './zip.js';
import { extractIntaglio } from './intaglio.js';
import { takeHandoff } from './handoff.js';
import { Sculpt, TOOLS } from './sculpt.js';

const VERSION = '61.0';
const $ = id => document.getElementById(id);
const num = id => { const v = $(id).valueAsNumber; return Number.isFinite(v) ? v : Number($(id).value); };
const fmt = (v, d = 1) => Number(v).toLocaleString('nl-NL', { minimumFractionDigits: d, maximumFractionDigits: d });
const int = v => Number(v).toLocaleString('nl-NL');

const STEPS = [['opdracht', 'Opdrachtbon'], ['scan', 'Scan & mesh'], ['analyse', 'Analyse'], ['lepel', 'Lepel'], ['beetplaat', 'Beetplaat'], ['opstelling', 'Opstelling'], ['basis', 'Basis'], ['bewerken', 'Bewerken'], ['controle', 'Controle'], ['productie', 'Productie']];
const CONTOUR_KINDS = ['lepel', 'beetplaat', 'basis'];
const LM_COLORS = { R: 0xff6b6b, M: 0xffd166, L: 0x4dabf7 };
const MARK_COLORS = { boundary: 0x55d8f5, bar: 0xff6877, reference: 0xffce72 };
const MODE_TEXT = { sculpt: 'Bewerken: sleep over het werkstuk · buiten het werkstuk draaien · Shift keert toevoegen/wegnemen om', contour: 'Omtrek tekenen: tik punten op de scan, tik op het eerste punt om te sluiten', landmark: 'Tik op de kam voor punt ', mark: 'Markeren: sleep over de scan', reference: 'Tik om een referentiepunt te zetten' };

const S = {
  scan: null, scanName: 'scan.stl', history: [], future: [],
  antagonist: null, antagonistName: null,
  axis: null, landmarks: {}, marks: [], marksRedo: [],
  contours: new ContourSet(), plates: {},
  teeth: [], teethHistory: [], teethFuture: [], teethInitial: null, frame: null,
  undercut: null, mode: 'orbit', modeArg: null, step: 'opdracht', selected: null, gizmoMode: null,
  selectedTeeth: new Set(), exported: false, checksOk: false,
};

const viewer = new Viewer($('viewport'));
window.ddcad = { S, viewer }; // voor ontwikkeling en tests

// ---------- algemene hulpmiddelen ----------
let toastTimer;
function toast(message, error = false) {
  const t = $('toast'); t.textContent = message; t.classList.toggle('error', error); t.classList.remove('hide');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hide'), error ? 6000 : 3200);
}
function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
async function busy(text, fn) {
  $('busyText').textContent = text; $('busy').classList.remove('hide');
  await new Promise(r => requestAnimationFrame(() => setTimeout(r, 20)));
  try { return await fn(); }
  catch (e) { console.error(e); status(e.message, true); toast(e.message, true); return undefined; }
  finally { $('busy').classList.add('hide'); }
}
function download(blobOrBuffer, name, type = 'application/octet-stream') {
  const blob = blobOrBuffer instanceof Blob ? blobOrBuffer : new Blob([blobOrBuffer], { type });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const safe = s => String(s || 'project').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 48);
const jaw = () => $('jaw').value === 'onder' ? 'lower' : 'upper';
const landmarksComplete = () => ['R', 'M', 'L'].every(k => S.landmarks[k]);
function result(id, html, ok = true) { $(id).innerHTML = `<span class="${ok ? 'ok' : 'err'}">${html}</span>`; }

// ---------- stappen ----------
function buildSteps() {
  for (const [i, [id, title]] of STEPS.entries()) {
    for (const host of [$('steps'), $('mobileSteps')]) {
      const b = document.createElement('button');
      b.className = 'step'; b.dataset.step = id;
      b.innerHTML = `<span class="dot">${i + 1}</span><span>${title}</span>`;
      b.onclick = () => { showStep(id); if (host.id === 'mobileSteps') $('right').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
      host.appendChild(host.id === 'steps' ? wrapLi(b) : b);
    }
  }
}
function wrapLi(b) { const li = document.createElement('li'); li.appendChild(b); return li; }
function showStep(id) {
  if (S.sculpt && id !== 'bewerken') finishSculpt(true);
  S.step = id;
  if (id === 'bewerken') fillSculptTargets();
  for (const p of document.querySelectorAll('.panel')) p.classList.toggle('active', p.dataset.panel === id);
  for (const b of document.querySelectorAll('[data-step]')) b.classList.toggle('active', b.dataset.step === id);
  $('contourBar').classList.toggle('hide', !CONTOUR_KINDS.includes(id));
  if (S.mode !== 'orbit' && !(S.mode === 'contour' && CONTOUR_KINDS.includes(id)) && !(S.mode === 'sculpt' && id === 'bewerken')) setMode('orbit');
  if (id !== 'opstelling') selectTooth(null);
  viewer.groups.teeth.visible = $('layerTeeth').checked && !(['basis', 'controle', 'productie'].includes(id) && (S.plates.monoblock || S.plates.basis));
  if (id === 'productie') renderOutputs();
  if (id === 'controle') runChecks();
  updateContourUI(); refreshScanColors(); refreshOverlay(); syncPlateVisibility(); updateDone();
}
function updateDone() {
  const done = {
    opdracht: !!$('caseName').value || S.selectedTeeth.size > 0, scan: !!S.scan, analyse: landmarksComplete(),
    lepel: !!S.plates.lepel, beetplaat: !!S.plates.beetplaat, opstelling: S.teeth.length > 0,
    basis: !!(S.plates.monoblock || S.plates.basis), controle: S.checksOk, productie: S.exported,
  };
  for (const b of document.querySelectorAll('[data-step]')) b.classList.toggle('done', !!done[b.dataset.step]);
  const p = $('caseName').value || 'zonder code';
  $('summary').textContent = `${p} · ${$('work').selectedOptions[0].text} · ${$('jaw').selectedOptions[0].text} · ${S.selectedTeeth.size} elementen`;
}

// ---------- opdrachtbon / FDI ----------
const ROWS = [[18, 17, 16, 15, 14, 13, 12, 11], [21, 22, 23, 24, 25, 26, 27, 28], [48, 47, 46, 45, 44, 43, 42, 41], [31, 32, 33, 34, 35, 36, 37, 38]];
function buildToothMap() {
  const host = $('toothmap');
  for (const pair of [[0, 1], [2, 3]]) {
    const row = document.createElement('div'); row.className = 'toothrow' + (pair[0] === 2 ? ' split' : '');
    for (const r of pair) for (const id of ROWS[r]) {
      const b = document.createElement('button'); b.className = 'tooth'; b.textContent = id; b.dataset.tooth = id;
      b.onclick = () => { S.selectedTeeth.has(id) ? S.selectedTeeth.delete(id) : S.selectedTeeth.add(id); updateTeethMap(); persist(); };
      row.appendChild(b);
    }
    host.appendChild(row);
  }
}
function updateTeethMap() {
  const upper = jaw() === 'upper';
  for (const id of [...S.selectedTeeth]) if ((id < 30) !== upper) S.selectedTeeth.delete(id);
  for (const b of document.querySelectorAll('[data-tooth]')) { const id = +b.dataset.tooth; b.disabled = (id < 30) !== upper; b.classList.toggle('selected', S.selectedTeeth.has(id)); }
  const ids = [...S.selectedTeeth].sort((a, b) => a - b);
  $('selection').textContent = 'Geselecteerd: ' + (ids.join(', ') || 'geen (opstelling gebruikt de hele kaak)');
  updateDone();
}
$('jaw').addEventListener('change', updateTeethMap);
$('selectJaw').onclick = () => { for (const id of jaw() === 'upper' ? FDI_UPPER : FDI_LOWER) S.selectedTeeth.add(id); updateTeethMap(); persist(); };
$('clearTeeth').onclick = () => { S.selectedTeeth.clear(); updateTeethMap(); persist(); };

// ---------- instellingen bewaren ----------
const STORE = 'ddcad60-settings';
function settings() { const o = {}; for (const e of document.querySelectorAll('[data-persist]')) o[e.id] = e.type === 'checkbox' ? e.checked : e.value; return o; }
function applySettings(o) { for (const [id, v] of Object.entries(o || {})) { const e = $(id); if (!e || !e.hasAttribute('data-persist')) continue; if (e.type === 'checkbox') e.checked = !!v; else e.value = v; } syncConceptUI(); }
function persist() { try { localStorage.setItem(STORE, JSON.stringify({ v61: true, settings: settings(), teeth: [...S.selectedTeeth] })); } catch { /* geen opslag */ } }
for (const e of document.querySelectorAll('[data-persist]')) e.addEventListener('change', () => { persist(); updateDone(); });

// ---------- scan ----------
function setScan(soup, name, { reset = true } = {}) {
  S.scan = soup; S.scanName = name || S.scanName;
  viewer.setScan(soup, { keepView: !reset });
  $('emptyHint').classList.toggle('hide', !!soup);
  if (reset) {
    S.history = []; S.future = []; S.landmarks = {}; S.marks = []; S.marksRedo = []; S.axis = null; S.frame = null;
    S.contours.reset(); clearPlates(); clearTeeth();
  } else reopenContours();
  S.undercut = null;
  viewer.setScanOpacity($('layerScanLight').checked);
  updateScanInfo(); refreshScanColors(); refreshOverlay(); updateDone();
}
function reopenContours() { for (const s of S.contours.shapes.values()) Object.assign(s, { facets: [], polygon: null, project: null, surface: null }); updateContourUI(); }
function updateScanInfo() {
  if (!S.scan) { $('scanInfo').textContent = 'Nog geen scan geladen.'; return; }
  const b = soupBounds(S.scan), d = b.size.map(v => fmt(v)).join(' × ');
  const max = Math.max(...b.size);
  const unit = max > 250 ? ' ⚠ Zeer groot: staat de scan in millimeters?' : max < 10 ? ' ⚠ Zeer klein: controleer de eenheden.' : '';
  $('scanInfo').textContent = `${S.scanName} · ${int(S.scan.length / 9)} driehoeken · ${d} mm.${unit}`;
}
async function loadScanFile(file) {
  await busy('STL inlezen…', async () => {
    const soup = parseSTL(await file.arrayBuffer());
    setScan(soup, file.name);
    let closed = false;
    try { closed = soup.length / 9 < 1_500_000 && quality(weld(soup, 1e-5)).open === 0; } catch { /* alleen hint */ }
    $('intaglioInfo').textContent = closed ? 'Dit is een gesloten model. Is het een bestaande lepel/beetplaat? Haal dan hierboven de weefselzijde eruit.' : '';
    status(`Scan geladen: ${file.name} · ${int(soup.length / 9)} driehoeken.${closed ? ' Gesloten model: kies bij Scan & mesh "Weefselzijde uit product halen" om er een nieuwe plaat op te maken.' : ''}`);
    if (S.step === 'opdracht') showStep('scan');
  });
}
$('intaglioBtn').onclick = () => busy('Weefselzijde zoeken…', async () => {
  if (!S.scan) throw Error('Laad eerst een gesloten product (STL).');
  const q = quality(weld(S.scan, 1e-5));
  if (q.open > 0) throw Error('Deze STL is al open (een scan of oppervlak). Weefselzijde halen werkt op een gesloten product.');
  const before = S.scan, name = S.scanName;
  const { soup, report } = extractIntaglio(S.scan, { side: +$('intaglioSide').value });
  if (soup.length / 9 < 500) throw Error('Geen bruikbare weefselzijde gevonden. Kies de andere zijde.');
  setScan(soup, name.replace(/\.stl$/i, '') + '_weefselzijde.stl');
  S.history = [{ soup: before, aux: snapshotAux() }]; S.future = [];
  const holes = boundaryLoops(weld(soup, 1e-5)).loops.length - 1;
  // De occlusale richting is bekend (van het weefsel af); zet meteen de referentiepunten zodat beetwal en handvat werken.
  let lmNote = '';
  try {
    S.axis = [0, 0, -(+$('intaglioSide').value)];
    const lm = autoLandmarks(S.scan, { ...occlusalAxisCached(), axis: S.axis });
    S.landmarks = { R: lm.R, M: lm.M, L: lm.L }; S.frame = null; computeFrame(false);
    updateLandmarkInfo(); updateAxisInfo(); refreshOverlay(); updateDone();
    lmNote = ' Referentiepunten automatisch gezet (controleer bij Analyse).';
  } catch (e) { lmNote = ' Referentiepunten niet automatisch te bepalen: zet ze bij Analyse.'; }
  $('intaglioInfo').textContent = `Weefselzijde: ${int(report.kept)} van ${int(report.input)} facetten${report.patched ? `, ${int(report.patched)} ondersnijdingsvlakken meegenomen` : ''}${holes > 0 ? ` · ${holes} doorgaande openingen (perforaties) worden bij de plaat gedicht` : ' · één doorlopende rand'}. ↶ Terug zet het product terug.${lmNote}`;
  status('Weefselzijde klaar. Ga naar Lepel of Beetplaat: de rand volgt het originele product, er hoeft geen omtrek getekend te worden.');
});
$('fileScan').addEventListener('change', e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) loadScanFile(f); });
$('demoBtn').onclick = () => busy('Demo-kaak maken…', async () => {
  $('jaw').value = 'boven'; updateTeethMap();
  setScan(demoJaw(), 'demo_bovenkaak.stl');
  status('Synthetische tandeloze bovenkaak geladen. Ga naar Analyse voor de referentiepunten.');
});
// Slepen-en-neerzetten van STL-bestanden.
$('viewport').addEventListener('dragover', e => e.preventDefault());
$('viewport').addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f && /\.stl$/i.test(f.name)) loadScanFile(f); });

function snapshotAux() { return JSON.parse(JSON.stringify({ landmarks: S.landmarks, marks: S.marks, axis: S.axis, contours: S.contours.toJSON() })); }
function restoreAux(a) { S.landmarks = a.landmarks; S.marks = a.marks; S.axis = a.axis; S.contours.reset(); for (const c of a.contours) { const s = S.contours.ensure(c.kind); s.points = c.points; } }
function transformScan(matrix, label, { winding = false } = {}) {
  if (!S.scan) return status('Laad eerst een scan.', true);
  S.history.push({ soup: S.scan, aux: snapshotAux() }); if (S.history.length > 8) S.history.shift(); S.future = [];
  const soup = winding ? flipSoup(S.scan) : applyMatrixToSoup(S.scan, matrix.elements);
  if (!winding) {
    const tp = p => p && new THREE.Vector3(...p).applyMatrix4(matrix).toArray();
    for (const k of Object.keys(S.landmarks)) S.landmarks[k] = tp(S.landmarks[k]);
    for (const m of S.marks) m.points = m.points.map(tp);
    for (const s of S.contours.shapes.values()) s.points = s.points.map(tp);
    if (S.axis) S.axis = new THREE.Vector3(...S.axis).transformDirection(matrix).toArray();
  }
  const hadWork = Object.keys(S.plates).length || S.teeth.length;
  clearPlates(); clearTeeth();
  setScan(soup, S.scanName, { reset: false });
  status(label + (hadWork ? ' Werkstukken en opstelling zijn gewist; genereer ze opnieuw.' : ''));
}
const center = () => { const b = soupBounds(S.scan); return new THREE.Vector3(...b.center); };
const about = (m) => { const c = center(); return new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(m).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z)); };
$('meshMove').onclick = () => { const v = ['moveX', 'moveY', 'moveZ'].map(num); if (!v.every(Number.isFinite)) return status('Ongeldige verplaatsing.', true); transformScan(new THREE.Matrix4().makeTranslation(...v), `Scan verplaatst ${v.join(' / ')} mm.`); };
$('meshRotate').onclick = () => { const deg = num('rotateDegrees'), axis = [[1, 0, 0], [0, 1, 0], [0, 0, 1]][+$('rotateAxis').value]; if (!Number.isFinite(deg)) return; transformScan(about(new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(...axis), deg * Math.PI / 180)), `Scan ${deg}° geroteerd.`); };
$('meshScaleBtn').onclick = () => { const k = num('meshScale'); if (!(k > 0 && k <= 100)) return status('Ongeldige schaalfactor.', true); transformScan(about(new THREE.Matrix4().makeScale(k, k, k)), `Scan geschaald met factor ${k}.`); };
$('meshMirror').onclick = () => { const s = [1, 1, 1]; s[+$('meshAxis').value] = -1; transformScan(about(new THREE.Matrix4().makeScale(...s)), 'Scan gespiegeld.'); };
$('meshFlip').onclick = () => transformScan(null, 'Normaalrichting omgekeerd.', { winding: true });
$('meshCenter').onclick = () => { const c = center(); transformScan(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z), 'Scan gecentreerd rond de oorsprong.'); };
$('meshUndo').onclick = () => { const h = S.history.pop(); if (!h) return; S.future.push({ soup: S.scan, aux: snapshotAux() }); restoreAux(h.aux); setScan(h.soup, S.scanName, { reset: false }); status('Bewerking teruggedraaid.'); };
$('meshRedo').onclick = () => { const h = S.future.pop(); if (!h) return; S.history.push({ soup: S.scan, aux: snapshotAux() }); restoreAux(h.aux); setScan(h.soup, S.scanName, { reset: false }); status('Bewerking hersteld.'); };
$('meshExport').onclick = () => { if (!S.scan) return status('Laad eerst een scan.', true); download(writeSTL(S.scan, 'Scan ' + S.scanName), 'SCAN_' + safe(S.scanName.replace(/\.stl$/i, '')) + '.stl'); };
function qaText(q) {
  return [`Driehoeken: ${int(q.faces)} · punten: ${int(q.vertices)} · delen: ${q.components}`,
    `Afmetingen: ${q.dimensions.map(v => fmt(v)).join(' × ')} mm`,
    `Oppervlak: ${fmt(q.area)} mm²${q.open === 0 ? ` · volume: ${fmt(Math.abs(q.volume))} mm³` : ''}`,
    `Open randen: ${int(q.open)} (${q.holes} lus${q.holes === 1 ? '' : 'sen'}) · niet-manifold: ${q.nonManifold}`,
    `Omgekeerde buren: ${q.flipped} · platte facetten: ${q.degenerate}`,
    q.watertight ? '✓ Gesloten en manifold' : q.holes === 1 && !q.nonManifold && !q.flipped && !q.degenerate ? '✓ Schoon open oppervlak met één buitenrand (normaal voor een kaakscan)' : '⚠ Meshfouten gevonden: gebruik Repareer'].join('\n');
}
$('meshQA').onclick = () => busy('Mesh analyseren…', async () => { if (!S.scan) throw Error('Laad eerst een scan.'); $('meshReport').textContent = qaText(quality(weld(S.scan, 1e-4))); });
$('meshRepair').onclick = () => busy('Mesh repareren…', async () => {
  if (!S.scan) throw Error('Laad eerst een scan.');
  const { mesh, report } = repair(S.scan, { fill: $('repairFill').checked, keepLargest: true });
  S.history.push({ soup: S.scan, aux: snapshotAux() }); S.future = [];
  setScan(toSoup(mesh), S.scanName, { reset: false });
  $('meshReport').textContent = `Reparatie: ${report.invalid} ongeldig, ${report.flat} plat, ${report.duplicate} dubbel verwijderd · ${report.flips} facetten omgedraaid · ${report.filled} gaten gedicht${report.outward ? ' · naar buiten gericht' : ''}.\n\n` + qaText(quality(mesh));
  status('Mesh gerepareerd. Controleer het resultaat.');
});
// Antagonist
function setAntagonist(soup, name) { S.antagonist = soup; S.antagonistName = name; viewer.setAntagonist(soup, $('layerAntagonist').checked); $('antInfo').textContent = soup ? `${name} · ${int(soup.length / 9)} driehoeken` : 'Geen antagonist geladen.'; if (soup) $('ant').value = 'aanwezig'; }
$('fileAntagonist').addEventListener('change', e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) busy('Antagonist inlezen…', async () => { setAntagonist(parseSTL(await f.arrayBuffer()), f.name); status('Antagonist geladen.'); }); });
$('antDemo').onclick = () => { if (S.scanName !== 'demo_bovenkaak.stl') toast('De demo-antagonist past alleen bij de demo-kaak.'); setAntagonist(demoAntagonist(), 'demo_antagonist.stl'); };
$('antRemove').onclick = () => setAntagonist(null, null);

// ---------- weergave ----------
function viewDir(name) {
  const N = new THREE.Vector3(...(S.axis || (S.frame?.N) || [0, 0, 1]));
  const Y = S.frame ? new THREE.Vector3(...S.frame.Y) : new THREE.Vector3(0, 1, 0);
  const X = new THREE.Vector3().crossVectors(Y, N);
  const map = { occlusal: [N, Y], front: [Y, N], right: [X.clone().negate(), N], left: [X, N] };
  if (jaw() === 'upper') map.right = [X, N], map.left = [X.clone().negate(), N];
  const [d, up] = map[name];
  viewer.view(d.toArray(), up.toArray());
}
for (const b of document.querySelectorAll('[data-view]')) b.onclick = () => viewDir(b.dataset.view);
$('fitBtn').onclick = () => viewer.fit();
$('zoomIn').onclick = () => viewer.zoom(0.8);
$('zoomOut').onclick = () => viewer.zoom(1.25);
$('layerScan').onchange = e => { viewer.groups.scan.visible = e.target.checked; viewer.render(); };
$('layerScanLight').onchange = e => viewer.setScanOpacity(e.target.checked);
$('layerAntagonist').onchange = e => { viewer.groups.antagonist.visible = e.target.checked; viewer.render(); };
$('layerPlates').onchange = e => { viewer.groups.plates.visible = e.target.checked; viewer.render(); };
$('layerTeeth').onchange = e => { viewer.groups.teeth.visible = e.target.checked; viewer.render(); };
$('focusBtn').onclick = () => { document.body.classList.toggle('focus'); setTimeout(() => viewer.resize(), 50); };
$('helpBtn').onclick = () => $('helpDialog').showModal();

// ---------- modi en aanwijzen ----------
function setMode(mode, arg = null) {
  S.mode = mode; S.modeArg = arg;
  viewer.controls.enableRotate = mode === 'orbit' || mode === 'sculpt';
  $('viewport').classList.toggle('drawing', mode !== 'orbit');
  $('modeChip').classList.toggle('hide', mode === 'orbit');
  $('modeText').textContent = mode === 'landmark' ? MODE_TEXT.landmark + ({ R: 'rechts distaal', M: 'midden (incisief)', L: 'links distaal' })[arg] : mode === 'mark' ? (arg === 'reference' ? MODE_TEXT.reference : MODE_TEXT.mark) : MODE_TEXT[mode] || '';
  $('contourToggle').setAttribute('aria-pressed', String(mode === 'contour'));
  $('contourToggle').textContent = mode === 'contour' ? '↻ Draaien' : '✏️ Teken omtrek';
  for (const b of document.querySelectorAll('[data-landmark]')) b.setAttribute('aria-pressed', String(mode === 'landmark' && b.dataset.landmark === arg));
  for (const b of document.querySelectorAll('[data-mark]')) b.setAttribute('aria-pressed', String(mode === 'mark' && b.dataset.mark === arg));
}
$('modeExit').onclick = () => setMode('orbit');

const pointers = new Map();
let press = null, stroke = null, overlayQueued = false;
const canvas = viewer.canvas;
canvas.addEventListener('pointerdown', e => {
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (S.mode === 'sculpt') { if (pointers.size === 1 && e.button === 0) sculptDown(e); else sculptUp(); return; }
  if (viewer.gizmo.dragging || viewer.gizmo.axis) { press = null; return; }
  press = pointers.size === 1 ? { x: e.clientX, y: e.clientY, id: e.pointerId, type: e.pointerType } : null;
  if (S.mode === 'mark' && S.modeArg !== 'reference' && pointers.size === 1 && e.button === 0) {
    const hit = viewer.pick(e.clientX, e.clientY);
    if (hit) { stroke = { kind: S.modeArg, points: [hit.point.toArray()] }; S.marks.push(stroke); S.marksRedo = []; refreshOverlay(); }
  }
});
canvas.addEventListener('pointermove', e => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (S.mode === 'sculpt') { sculptMove(e); return; }
  if (!stroke || pointers.size !== 1) return;
  const hit = viewer.pick(e.clientX, e.clientY);
  if (!hit) return;
  const last = stroke.points[stroke.points.length - 1];
  if (hit.point.distanceTo(new THREE.Vector3(...last)) > 0.3) { stroke.points.push(hit.point.toArray()); if (!overlayQueued) { overlayQueued = true; requestAnimationFrame(() => { overlayQueued = false; refreshOverlay(); }); } }
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (S.mode === 'sculpt') { sculptUp(); press = null; return; }
  if (stroke) { if (stroke.points.length < 2) S.marks.pop(); stroke = null; updateMarkInfo(); refreshOverlay(); press = null; return; }
  if (press && press.id === e.pointerId && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 8 && e.type === 'pointerup') handleTap(e, press.type);
  press = null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

function handleTap(e, type) {
  if (S.mode === 'contour') return addContourPoint(e, type);
  if (S.mode === 'landmark') {
    const hit = viewer.pick(e.clientX, e.clientY);
    if (!hit) return status('Tik op het scanoppervlak.', true);
    S.landmarks[S.modeArg] = hit.point.toArray(); S.frame = null;
    const next = ['R', 'M', 'L'].find(k => !S.landmarks[k]);
    if (next) setMode('landmark', next); else { setMode('orbit'); computeFrame(true); }
    updateLandmarkInfo(); refreshOverlay(); updateDone(); return;
  }
  if (S.mode === 'mark' && S.modeArg === 'reference') {
    const hit = viewer.pick(e.clientX, e.clientY);
    if (hit) { S.marks.push({ kind: 'reference', points: [hit.point.toArray()] }); S.marksRedo = []; updateMarkInfo(); refreshOverlay(); }
    return;
  }
  if (S.teeth.length && viewer.groups.teeth.visible) {
    const hit = viewer.pick(e.clientX, e.clientY, S.teeth);
    if (hit) { if (S.step !== 'opstelling') showStep('opstelling'); selectTooth(hit.object); return; }
    if (S.step === 'opstelling') selectTooth(null);
  }
}

// ---------- overlay en kleuren ----------
function refreshOverlay() {
  viewer.clearGroup('overlay');
  const g = viewer.groups.overlay;
  const lmPts = ['R', 'M', 'L'].filter(k => S.landmarks[k]);
  for (const k of lmPts) g.add(makeDots([new THREE.Vector3(...S.landmarks[k])], LM_COLORS[k], 15));
  if (S.step === 'analyse' && S.scan) {
    const ax = S.axis || occlusalAxisCached().axis, b = viewer.bounds, c = b.getCenter(new THREE.Vector3()), len = b.getSize(new THREE.Vector3()).length() * 0.35;
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(...ax), c, len, 0x46c8d5, len * 0.15, len * 0.07);
    arrow.traverse(o => { if (o.material) { o.material.depthTest = false; o.material.transparent = true; } o.renderOrder = 12; });
    g.add(arrow);
  }
  for (const m of S.marks) {
    const pts = m.points.map(p => new THREE.Vector3(...p));
    if (m.kind === 'reference') g.add(makeDots(pts, MARK_COLORS.reference, 11));
    else if (pts.length > 1) g.add(makePolyline(pts, MARK_COLORS[m.kind]));
  }
  if (CONTOUR_KINDS.includes(S.step)) {
    const s = S.contours.get(S.step);
    if (s?.points.length) {
      const pts = s.points.map(p => new THREE.Vector3(...p)), color = new THREE.Color(...COLORS[S.step]);
      if (pts.length > 1) g.add(makePolyline(pts, color, { closed: s.facets.length > 0 }));
      if (!s.facets.length || S.mode === 'contour') g.add(makeDots(pts, color, 8, 0xffffff));
    }
  }
  if (S.frame && ['opstelling', 'beetplaat', 'analyse'].includes(S.step)) {
    const f = S.frame, pts = [];
    for (let i = 0; i <= 60; i++) { const [x, y] = archPoint(-1 + 2 * i / 60, { width: f.width, depth: f.depth, form: $('archForm').value }); pts.push(new THREE.Vector3(...framePoint(f, x, y))); }
    const line = makePolyline(pts, 0x9fe3ea); line.material.opacity = 0.6; g.add(line);
  }
  viewer.render();
}
let axisCache = null;
function occlusalAxisCached() { if (!axisCache || axisCache.soup !== S.scan) axisCache = { soup: S.scan, info: occlusalAxis(S.scan) }; return axisCache.info; }
function refreshScanColors() {
  if (!viewer.scanMesh) return;
  const n = S.scan.length / 9;
  let marks = null;
  const showContours = CONTOUR_KINDS.includes(S.step);
  if (showContours) for (const [i, kind] of CONTOUR_KINDS.entries()) {
    const s = S.contours.get(kind);
    if (!s?.facets.length || kind !== S.step) continue;
    marks ??= new Uint8Array(n); for (const f of s.facets) marks[f] = i + 1;
  }
  if (S.undercut && S.step === 'analyse') { marks ??= new Uint8Array(n); for (let f = 0; f < n; f++) if (S.undercut[f]) marks[f] = 4; }
  viewer.colorFaces(marks, [COLORS.lepel, COLORS.beetplaat, COLORS.basis, COLORS.undercut]);
}

// ---------- analyse ----------
function updateAxisInfo() { const a = S.axis; $('axisInfo').textContent = a ? `Occlusale richting: (${a.map(v => fmt(v, 2)).join(', ')})` : 'Automatisch bepaald uit de scan.'; }
$('axisAuto').onclick = () => { if (!S.scan) return status('Laad eerst een scan.', true); S.axis = occlusalAxisCached().axis; S.frame = null; computeFrame(); updateAxisInfo(); refreshOverlay(); };
$('axisView').onclick = () => { S.axis = viewer.camera.position.clone().sub(viewer.controls.target).normalize().toArray(); S.frame = null; computeFrame(); updateAxisInfo(); refreshOverlay(); };
$('axisFlip').onclick = () => { if (!S.scan) return; S.axis = (S.axis || occlusalAxisCached().axis).map(v => -v); S.frame = null; computeFrame(); updateAxisInfo(); refreshOverlay(); };
$('lmAuto').onclick = () => busy('Kamlijn zoeken…', async () => {
  if (!S.scan) throw Error('Laad eerst een scan.');
  const info = { ...occlusalAxisCached() }; if (S.axis) info.axis = S.axis;
  const lm = autoLandmarks(S.scan, info);
  S.landmarks = { R: lm.R, M: lm.M, L: lm.L }; S.axis ??= info.axis; S.frame = null;
  computeFrame(true); updateLandmarkInfo(); updateAxisInfo(); refreshOverlay(); updateDone();
  status('Referentiepunten automatisch bepaald. Controleer ze en verplaats ze zo nodig met de knoppen Rechts/Midden/Links.');
});
for (const b of document.querySelectorAll('[data-landmark]')) b.onclick = () => { if (!S.scan) return status('Laad eerst een scan.', true); setMode(S.mode === 'landmark' && S.modeArg === b.dataset.landmark ? 'orbit' : 'landmark', b.dataset.landmark); };
$('lmClear').onclick = () => { S.landmarks = {}; S.frame = null; updateLandmarkInfo(); refreshOverlay(); updateDone(); };
function computeFrame(report = false) {
  if (!landmarksComplete()) { S.frame = null; return null; }
  try {
    S.frame = archFrame(S.landmarks, jaw(), S.axis || occlusalAxisCached().axis);
    if (report && S.frame.swapped) toast('Let op: rechts en links lijken verwisseld ten opzichte van de kaakoriëntatie. De opstelling volgt de anatomie.');
  } catch (e) { S.frame = null; status(e.message, true); }
  updateLandmarkInfo();
  return S.frame;
}
function updateLandmarkInfo() {
  const have = ['R', 'M', 'L'].filter(k => S.landmarks[k]);
  $('lmInfo').textContent = !have.length ? 'Nog geen punten.' : S.frame ? `Boog: breedte ${fmt(S.frame.width)} mm, diepte ${fmt(S.frame.depth)} mm.` : `${have.length}/3 punten gezet.`;
}
$('undercutRun').onclick = () => busy('Ondersnijdingen berekenen…', async () => {
  if (!viewer.scanMesh) throw Error('Laad eerst een scan.');
  const r = undercutMarks(viewer.scanMesh, S.axis || occlusalAxisCached().axis);
  S.undercut = r.marks; refreshScanColors();
  $('undercutInfo').textContent = `${int(r.count)} facetten in ondersnijding (${fmt(r.area)} mm²). Rood = niet bereikbaar langs de invoerrichting.`;
});
$('undercutClear').onclick = () => { S.undercut = null; refreshScanColors(); };
for (const b of document.querySelectorAll('[data-mark]')) b.onclick = () => { if (!S.scan) return status('Laad eerst een scan.', true); setMode(S.mode === 'mark' && S.modeArg === b.dataset.mark ? 'orbit' : 'mark', b.dataset.mark); };
$('markUndo').onclick = () => { if (S.marks.length) S.marksRedo.push(S.marks.pop()); updateMarkInfo(); refreshOverlay(); };
$('markRedo').onclick = () => { if (S.marksRedo.length) S.marks.push(S.marksRedo.pop()); updateMarkInfo(); refreshOverlay(); };
$('markClear').onclick = () => { S.marks = []; S.marksRedo = []; updateMarkInfo(); refreshOverlay(); };
function updateMarkInfo() { const c = k => S.marks.filter(m => m.kind === k).length; $('markInfo').textContent = `Randlijnen: ${c('boundary')} · stegen: ${c('bar')} · referentiepunten: ${c('reference')}. Ze liggen op het scanoppervlak en draaien mee.`; }

// ---------- omtrek ----------
function updateContourUI() {
  const kind = S.step; if (!CONTOUR_KINDS.includes(kind)) return;
  const s = S.contours.get(kind);
  $('contourUndo').disabled = !s?.points.length;
  $('contourRedo').disabled = !S.contours.canRedo(kind);
  $('contourClear').disabled = !s?.points.length;
  $('contourCrop').disabled = !s?.facets.length;
  const el = $('contourStatus');
  el.dataset.error = 'false';
  el.textContent = !S.scan ? 'Laad eerst een scan.' : s?.facets.length ? `Omtrek gesloten · ${int(s.facets.length)} facetten geselecteerd.` : s?.points.length ? `${s.points.length} punten. Tik op het eerste (witte) punt om te sluiten.` : 'Geen omtrek: de hele scan wordt gebruikt (moet al uitgesneden zijn).';
}
function contourError(msg) { const el = $('contourStatus'); el.textContent = msg; el.dataset.error = 'true'; }
function addContourPoint(e, type) {
  const kind = S.step, s = S.contours.get(kind);
  try {
    if (s?.facets.length) return contourError('Omtrek is gesloten. Gebruik Terug om te openen of Wis.');
    if (s?.points.length >= 3) {
      const project = viewer.projector(), [px, py] = project(...s.points[0]), r = canvas.getBoundingClientRect();
      if (Math.hypot(px - (e.clientX - r.left), py - (e.clientY - r.top)) <= (type === 'touch' ? 22 : 13)) {
        S.contours.close(kind, viewer); delete S.plates[kind];
        setMode('orbit'); updateContourUI(); refreshScanColors(); refreshOverlay(); return;
      }
    }
    const hit = viewer.pick(e.clientX, e.clientY);
    if (!hit) return contourError('Tik op het zichtbare scanoppervlak.');
    S.contours.addPoint(kind, hit.point.toArray());
    updateContourUI(); refreshOverlay();
  } catch (err) { contourError(err.message); }
}
$('contourToggle').onclick = () => { if (!S.scan) return contourError('Laad eerst een scan.'); setMode(S.mode === 'contour' ? 'orbit' : 'contour'); };
$('contourUndo').onclick = () => { S.contours.undo(S.step); updateContourUI(); refreshScanColors(); refreshOverlay(); };
$('contourRedo').onclick = () => { S.contours.redoStep(S.step); updateContourUI(); refreshScanColors(); refreshOverlay(); };
$('contourClear').onclick = () => { S.contours.clear(S.step); updateContourUI(); refreshScanColors(); refreshOverlay(); };
$('contourCrop').onclick = () => busy('Uitsnijden…', async () => { const surf = S.contours.surface(S.step, S.scan); download(writeSTL(surf), `UITSNEDE_${S.step}_${safe(S.scanName.replace(/\.stl$/i, ''))}.stl`); status(`Uitgesneden oppervlak: ${int(surf.length / 9)} facetten.`); });

function surfaceFor(kind) {
  if (!S.scan) throw Error('Laad eerst een scan.');
  const s = S.contours.get(kind);
  if (s?.points.length && !s.facets.length) throw Error('Sluit eerst de omtrek door op het eerste punt te tikken.');
  return s?.facets.length ? S.contours.surface(kind, S.scan) : S.scan;
}

// ---------- werkstukken ----------
// Laat onderranden van wallen/handvatten op de scan aansluiten: halverwege de plaatdikte, nooit door het pasvlak.
function conformTo(sink) {
  const mesh = viewer.scanMesh; if (!mesh) return null;
  const ray = new THREE.Raycaster(); ray.firstHitOnly = true;
  return (q, n) => {
    const N = new THREE.Vector3(...n).normalize();
    ray.set(new THREE.Vector3(...q).addScaledVector(N, 40), N.clone().negate());
    const hit = ray.intersectObject(mesh, false)[0];
    return hit ? hit.point.addScaledVector(N, sink).toArray() : null;
  };
}
function showPlate(kind, soup, color) {
  const old = viewer.groups.plates.getObjectByName(kind);
  if (old) { viewer.groups.plates.remove(old); old.geometry.dispose(); old.material.dispose(); }
  if (soup) { const m = makeMesh(soup, color, { opacity: kind === 'basisTeeth' ? 1 : 0.9, roughness: kind === 'basisTeeth' ? 0.32 : 0.45 }); m.name = kind; viewer.groups.plates.add(m); }
  syncPlateVisibility();
}
// Toon per stap alleen het bijbehorende werkstuk; in de latere stappen de prothese.
function syncPlateVisibility() {
  const show = { bewerken: S.sculpt ? ['sculpt'] : null, lepel: ['lepel'], beetplaat: ['beetplaat'], basis: ['basis', 'basisTeeth'], opstelling: [], controle: ['basis', 'lepel', 'beetplaat'], productie: ['basis', 'lepel', 'beetplaat'] }[S.step];
  for (const child of viewer.groups.plates.children) child.visible = show ? show.includes(child.name) : true;
  if (S.step === 'controle' || S.step === 'productie') {
    const work = $('work').value, pick = work === 'lepel' ? 'lepel' : work === 'beetplaat' ? 'beetplaat' : 'basis';
    for (const child of viewer.groups.plates.children) child.visible = child.name === pick || (pick === 'basis' && child.name === 'basisTeeth');
  }
  viewer.render();
}
function clearPlates() { S.plates = {}; viewer.clearGroup('plates'); for (const id of ['lepelResult', 'beetResult', 'basisResult']) $(id).innerHTML = ''; }
function plateSummary(soup) {
  const q = quality(weld(soup, 1e-6));
  const state = q.watertight ? 'gesloten ✓'
    : q.open === 0 && q.flipped === 0 ? `gesloten, ${int(q.nonManifold)} niet-manifold rand${q.nonManifold === 1 ? '' : 'en'} (delen raken elkaar; controleer in de slicer)`
    : `⚠ niet volledig gesloten (${int(q.open)} open randen)`;
  return { q, text: `${int(q.faces)} facetten · ${state} · volume ${fmt(Math.abs(q.volume))} mm³` };
}
function plateLink(kind, label) { return `<a class="download" href="#" data-download="${kind}">↓ ${label}</a>`; }
document.addEventListener('click', e => { const a = e.target.closest('[data-download]'); if (!a) return; e.preventDefault(); const p = S.plates[a.dataset.download]; if (p) download(writeSTL(p.soup, p.name), p.file); });
function needFrame(feature) { if (computeFrame() || S.frame) return true; toast(`${feature} overgeslagen: zet eerst de referentiepunten (stap Analyse).`); return false; }

$('lepelBuild').onclick = () => busy('Lepel berekenen…', async () => {
  const surface = surfaceFor('lepel'), gap = num('lepelGap'), wall = num('lepelWall'), reverse = $('lepelReverse').checked;
  const rep = {};
  let soup = shell(surface, { gap, wall, reverse }, rep);
  const extras = [], notes = [];
  if ($('lepelHandle').checked && needFrame('Handvat')) { extras.push(trayHandle(S.frame, { base: gap, height: num('handleHeight'), width: num('handleWidth'), conform: conformTo(gap + wall * 0.5) })); notes.push('handvat'); }
  if ($('lepelStops').checked && gap > 0 && needFrame('Weefselstops')) { extras.push(...tissueStops(['R', 'M', 'L'].map(k => S.landmarks[k]), S.frame.N, { gap, wall })); notes.push('3 weefselstops'); }
  const cutters = $('lepelPerforated').checked && needFrame('Perforaties') ? perforations(S.frame, { form: $('archForm').value }) : [];
  if (cutters.length) notes.push(cutters.length + ' perforaties');
  if (extras.length || cutters.length) {
    await loadManifold();
    soup = (await unionSoups([soup, ...extras])).soup;
    if (cutters.length) soup = await subtractSoups(soup, cutters);
  }
  const { text } = plateSummary(soup);
  S.plates.lepel = { soup, name: 'Individuele lepel', file: `LEPEL_${safe($('caseName').value)}.stl` };
  showPlate('lepel', soup, COLORS.plate.lepel);
  result('lepelResult', `Lepel klaar: ${text}${rep.holesFilled ? ` · ${rep.holesFilled} gaten in de scan gedicht` : ''}${notes.length ? ' · ' + notes.join(', ') : ''}.<br>${plateLink('lepel', 'Lepel-STL')}`);
  status('Lepel gegenereerd.'); updateDone();
});
$('biteFit').addEventListener('change', () => { $('biteDraft').disabled = $('biteFit').value !== 'block'; });
$('beetBuild').onclick = () => busy('Beetplaat berekenen…', async () => {
  const surface = surfaceFor('beetplaat'), gap = num('beetGap'), wall = num('beetWall'), reverse = $('beetReverse').checked;
  const draft = $('biteFit').value === 'block' ? num('biteDraft') : null, rep = {};
  let soup = shell(surface, { gap, wall, reverse, draftAngle: draft }, rep);
  const extras = [], notes = [];
  if ($('rimOn').checked && needFrame('Beetwal')) { extras.push(biteRim(S.frame, { width: num('rimWidth'), anteriorWidth: num('rimFrontWidth'), height: num('rimHeight'), embed: 3, form: $('archForm').value, conform: conformTo(gap + wall * 0.5) })); notes.push(`beetwal ${fmt(num('rimHeight'))} mm`); }
  if ($('beetHandle').checked && needFrame('Handvat')) { extras.push(trayHandle(S.frame, { base: gap + wall, height: num('handleHeight'), width: num('handleWidth'), labial: 6, conform: conformTo(gap + wall * 0.5) })); notes.push('handvat'); }
  if (extras.length) {
    await loadManifold();
    soup = (await unionSoups([soup, ...extras])).soup;
  }
  const { text } = plateSummary(soup);
  S.plates.beetplaat = { soup, name: 'Beetplaat', file: `BEETPLAAT_${safe($('caseName').value)}.stl` };
  showPlate('beetplaat', soup, COLORS.plate.beetplaat);
  result('beetResult', `Beetplaat klaar: ${text}${draft ? ` · uitblokken ${draft}° (${rep.changed} punten, max ${fmt(rep.maxLift, 2)} mm)` : ''}${notes.length ? ' · ' + notes.join(', ') : ''}.<br>${plateLink('beetplaat', 'Beetplaat-STL')}`);
  status('Beetplaat gegenereerd.'); updateDone();
});

// ---------- tandopstelling ----------
const toothMaterial = () => new THREE.MeshStandardMaterial({ color: COLORS.tooth, roughness: 0.32, metalness: 0 });
function clearTeeth() { selectTooth(null); viewer.clearGroup('teeth'); S.teeth = []; S.teethHistory = []; S.teethFuture = []; S.teethInitial = null; renderToothList(); }
function teethSnapshot() { return S.teeth.map(t => ({ fdi: t.userData.fdi, p: t.position.toArray(), q: t.quaternion.toArray() })); }
function applyTeethSnapshot(snap) { for (const s of snap) { const t = S.teeth.find(o => o.userData.fdi === s.fdi); if (t) { t.position.fromArray(s.p); t.quaternion.fromArray(s.q); t.updateMatrixWorld(); } } viewer.render(); }
function pushTeethHistory() { S.teethHistory.push(teethSnapshot()); if (S.teethHistory.length > 60) S.teethHistory.shift(); S.teethFuture = []; invalidateTeethDependents(); }
function invalidateTeethDependents() { if (S.plates.monoblock || S.plates.basis) { delete S.plates.monoblock; delete S.plates.basis; delete S.plates.elementen; showPlate('basis', null); showPlate('basisTeeth', null); $('basisResult').innerHTML = '<span class="err">Opstelling gewijzigd: genereer de prothese opnieuw.</span>'; } }
function syncConceptUI() { $('customConcept').classList.toggle('hide', $('concept').value !== 'custom'); }
$('concept').addEventListener('change', syncConceptUI);
function buildTeeth() {
  const ids = S.selectedTeeth.size ? [...S.selectedTeeth] : (jaw() === 'upper' ? FDI_UPPER : FDI_LOWER);
  let frame = computeFrame();
  if (!frame) { if (S.scan) throw Error('Zet eerst de drie referentiepunten op de kam (stap Analyse → Automatisch).'); frame = S.frame = defaultFrame(jaw()); }
  const placed = placeTeeth(ids, frame, {
    form: $('archForm').value, scale: num('toothScale') / 100, shape: $('anteriorShape').value, concept: $('concept').value,
    occlusalHeight: num('occlHeight'), gap: num('basisGap'), wall: num('basisWall'),
    custom: { spee: num('cSpee'), wilson: num('cWilson'), labial: num('cLabial'), cusp: num('cCusp') },
  }, viewer.scanMesh);
  clearTeeth();
  for (const t of placed) {
    const mesh = new THREE.Mesh(Viewer.geometryFromSoup(t.soup), toothMaterial());
    mesh.geometry.computeBoundsTree();
    mesh.position.copy(t.position); mesh.quaternion.copy(t.quaternion);
    mesh.userData = { fdi: t.fdi, dims: t.dims, root: t.root, soup: t.soup, mesial: t.mesial, buccal: t.buccal };
    mesh.name = 'tand_' + t.fdi;
    viewer.groups.teeth.add(mesh); S.teeth.push(mesh);
  }
  S.teethInitial = teethSnapshot();
  invalidateTeethDependents();
  renderToothList(); refreshOverlay();
  $('teethInfo').textContent = `${placed.length} elementen opgesteld · ${$('concept').selectedOptions[0].text} · boog ${fmt(frame.width)} × ${fmt(frame.depth)} mm.`;
  status('Tanden opgesteld. Tik op een tand om hem aan te passen.'); updateDone();
}
$('teethBuild').onclick = () => busy('Tanden opstellen…', async () => buildTeeth());
function renderToothList() {
  const host = $('toothList'); host.innerHTML = '';
  for (const t of [...S.teeth].sort((a, b) => a.userData.fdi - b.userData.fdi)) {
    const b = document.createElement('button'); b.textContent = t.userData.fdi; b.classList.toggle('selected', S.selected === t);
    b.onclick = () => selectTooth(S.selected === t ? null : t); host.appendChild(b);
  }
  if (!S.teeth.length) host.innerHTML = '<span class="sub">Nog geen opstelling.</span>';
}
function selectTooth(obj) {
  if (S.selected) S.selected.material.emissive?.setHex(0x000000);
  S.selected = obj;
  if (obj) { obj.material.emissive.setHex(0x5a3a00); viewer.attachGizmo(S.gizmoMode ? obj : null, S.gizmoMode || 'translate'); status(`Element ${obj.userData.fdi} geselecteerd · kroon ${fmt(obj.userData.dims.md)} × ${fmt(obj.userData.dims.bl)} × ${fmt(obj.userData.dims.height)} mm.`); }
  else viewer.attachGizmo(null);
  renderToothList(); viewer.render();
}
function setGizmo(mode) {
  S.gizmoMode = S.gizmoMode === mode ? null : mode;
  $('gizmoMove').setAttribute('aria-pressed', String(S.gizmoMode === 'translate'));
  $('gizmoRotate').setAttribute('aria-pressed', String(S.gizmoMode === 'rotate'));
  if (S.selected) viewer.attachGizmo(S.gizmoMode ? S.selected : null, S.gizmoMode || 'translate');
  if (S.gizmoMode) viewer.gizmo.setSpace('local');
}
$('gizmoMove').onclick = () => setGizmo('translate');
$('gizmoRotate').onclick = () => setGizmo('rotate');
$('toothDeselect').onclick = () => selectTooth(null);
viewer.addEventListener('gizmo', e => { if (e.detail.dragging) pushTeethHistory(); else clearContactMap(S.teeth); });
for (const b of document.querySelectorAll('[data-nudge]')) b.onclick = () => {
  const t = S.selected; if (!t) return status('Selecteer eerst een element.', true);
  const N = new THREE.Vector3(...S.frame.N), d = { mesial: t.userData.mesial, distal: t.userData.mesial.clone().negate(), buccal: t.userData.buccal, lingual: t.userData.buccal.clone().negate(), up: N, down: N.clone().negate() }[b.dataset.nudge];
  pushTeethHistory(); t.position.addScaledVector(d, 0.25); t.updateMatrixWorld(); clearContactMap([t]); viewer.render();
};
$('teethUndo').onclick = () => { const h = S.teethHistory.pop(); if (!h) return; S.teethFuture.push(teethSnapshot()); applyTeethSnapshot(h); };
$('teethRedo').onclick = () => { const h = S.teethFuture.pop(); if (!h) return; S.teethHistory.push(teethSnapshot()); applyTeethSnapshot(h); };
$('teethReset').onclick = () => { if (!S.teethInitial) return; pushTeethHistory(); applyTeethSnapshot(S.teethInitial); clearContactMap(S.teeth); };
$('autoOcclude').onclick = () => busy('Occlusie zoeken…', async () => {
  if (!S.teeth.length) throw Error('Stel eerst de tanden op.');
  if (!viewer.antagonistMesh) throw Error('Laad eerst een antagonist (stap Scan & mesh).');
  pushTeethHistory();
  const rep = autoOcclude(S.teeth, viewer.antagonistMesh, S.frame.N, num('occlClearance'));
  const moved = rep.filter(r => r.moved !== null), missed = rep.filter(r => r.moved === null).map(r => r.fdi);
  const cm = contactMap(S.teeth, viewer.antagonistMesh, S.frame.N);
  $('occlInfo').textContent = `${moved.length} elementen in contact gebracht (gem. verplaatsing ${fmt(moved.reduce((s, r) => s + r.moved, 0) / Math.max(1, moved.length), 2)} mm).` + (missed.length ? `\nGeen antagonist boven: ${missed.join(', ')}.` : '') + '\n' + contactText(cm);
  viewer.render();
});
function contactText(cm) { return cm.sort((a, b) => a.fdi - b.fdi).map(c => `${c.fdi}: ${Number.isFinite(c.min) ? (c.min < 0 ? 'penetratie ' + fmt(-c.min, 2) : fmt(c.min, 2)) + ' mm' : 'geen antagonist binnen 3 mm'}`).join(' · ') + '\nKleur: rood = penetratie · oranje < 0,1 · geel < 0,3 · groen < 0,8 mm.'; }
$('contactMap').onclick = () => busy('Contactkaart berekenen…', async () => {
  if (!S.teeth.length || !viewer.antagonistMesh) throw Error('Nodig: opstelling en antagonist.');
  $('occlInfo').textContent = contactText(contactMap(S.teeth, viewer.antagonistMesh, S.frame.N)); viewer.render();
});
$('contactClear').onclick = () => { clearContactMap(S.teeth); viewer.render(); };
$('exportSetup').onclick = () => {
  if (!S.teeth.length) return status('Stel eerst de tanden op.', true);
  download(JSON.stringify({ software: 'Digital Denture CAD ' + VERSION, type: '3D_SETUP', concept: $('concept').value, archForm: $('archForm').value, jaw: jaw(), frame: S.frame, teeth: S.teeth.map(t => ({ fdi: t.userData.fdi, matrix: t.matrixWorld.toArray(), dims: t.userData.dims })) }, null, 2), `opstelling_${safe($('caseName').value)}.json`, 'application/json');
};
function teethWorldSoups() { return S.teeth.map(t => { t.updateMatrixWorld(); return { fdi: t.userData.fdi, soup: applyMatrixToSoup(t.userData.soup, t.matrixWorld.elements) }; }); }

// ---------- prothesebasis ----------
$('basisBuild').onclick = () => busy('Prothese berekenen (booleaanse bewerkingen)…', async () => {
  const surface = surfaceFor('basis'), gap = num('basisGap'), wall = num('basisWall'), reverse = $('basisReverse').checked, rep = {};
  const base = shell(surface, { gap, wall, reverse }, rep);
  await loadManifold();
  const parts = [base], notes = [];
  const teeth = teethWorldSoups();
  if ($('gingivaOn').checked && teeth.length && S.frame) {
    const N = S.frame.N, O = S.frame.O;
    const cervical = S.teeth.map(t => vec.dot(vec.sub(t.localToWorld(new THREE.Vector3(0, 0, 0)).toArray(), O), N));
    const top = cervical.reduce((s, v) => s + v, 0) / cervical.length + num('gingivaOver');
    parts.push(gingivaBand(S.frame, { width: num('gingivaWidth'), top, embed: 3, form: $('archForm').value, conform: conformTo(gap + wall * 0.5) }));
    notes.push(`gingivaband tot ${fmt(top)} mm`);
  } else if (!teeth.length) notes.push('zonder tanden (alleen basis)');
  const teethTrimmed = teeth;
  if ($('coupling').value === 'monoblock' || !teeth.length) {
    const mono = (await unionSoups([...parts, ...teeth.map(t => t.soup)])).soup;
    S.plates.monoblock = { soup: mono, name: 'Monoblock prothese', file: `MONOBLOCK_${safe($('caseName').value)}.stl` };
    delete S.plates.basis;
    // Weergave: basis in gingivakleur, tanden in tandkleur (export blijft één monoblock).
    const display = teeth.length ? await subtractSoups(mono, teeth.map(t => t.soup)) : mono;
    showPlate('basis', display, COLORS.plate.basis);
    showPlate('basisTeeth', teeth.length ? concatSoups(teeth.map(t => t.soup)) : null, COLORS.tooth);
    const { text } = plateSummary(mono);
    result('basisResult', `Monoblock klaar: ${text}${notes.length ? ' · ' + notes.join(', ') : ''}.<br>${plateLink('monoblock', 'Monoblock-STL')}`);
  } else {
    const g = num('socketGap');
    const expanded = S.teeth.map(t => {
      const d = t.userData.dims, s = 1 + 2 * g / Math.min(d.md, d.bl);
      const m = t.matrixWorld.clone().multiply(new THREE.Matrix4().makeScale(s, 1 + g / d.height, s));
      return applyMatrixToSoup(t.userData.soup, m.elements);
    });
    const u = await unionSoups(parts);
    const basis = await subtractSoups(u.soup, expanded);
    S.plates.basis = { soup: basis, name: 'Prothesebasis met sockets', file: `BASIS_${safe($('caseName').value)}.stl` };
    delete S.plates.monoblock;
    showPlate('basis', basis, COLORS.plate.basis);
    showPlate('basisTeeth', concatSoups(teeth.map(t => t.soup)), COLORS.tooth);
    const { text } = plateSummary(basis);
    result('basisResult', `Basis met ${teeth.length} sockets klaar: ${text} · socketspeling ${fmt(g, 2)} mm${notes.length ? ' · ' + notes.join(', ') : ''}.<br>${plateLink('basis', 'Basis-STL')}`);
  }
  if (teethTrimmed.length) S.plates.elementen = { soup: concatSoups(teethTrimmed.map(t => t.soup)), name: 'Elementen', file: `ELEMENTEN_${safe($('caseName').value)}.stl`, parts: teethTrimmed };
  viewer.groups.teeth.visible = false;
  status('Prothese gegenereerd.'); updateDone();
});

// ---------- controle ----------
function runChecks() {
  const items = [];
  const add = (cls, text) => items.push([cls, text]);
  add(S.scan ? 'ok' : 'warn', S.scan ? `Scan geladen (${int(S.scan.length / 9)} driehoeken)` : 'Geen scan geladen');
  add($('caseName').value ? 'ok' : 'warn', $('caseName').value ? 'Projectcode ingevuld' : 'Projectcode ontbreekt');
  add(landmarksComplete() ? 'ok' : 'warn', landmarksComplete() ? 'Kamlijn-referentiepunten gezet' : 'Referentiepunten ontbreken');
  add($('landmarksReviewed').checked ? 'ok' : 'warn', $('landmarksReviewed').checked ? 'Anatomische referenties beoordeeld' : 'Anatomische beoordeling niet bevestigd');
  add($('undercutsReviewed').checked ? 'ok' : 'warn', $('undercutsReviewed').checked ? 'Ondersnijdingen beoordeeld' : 'Ondersnijdingen niet beoordeeld');
  const work = $('work').value;
  if (work === 'lepel') add(S.plates.lepel ? 'ok' : 'warn', S.plates.lepel ? 'Lepel gegenereerd' : 'Lepel nog niet gegenereerd');
  if (work === 'beetplaat') add(S.plates.beetplaat ? 'ok' : 'warn', S.plates.beetplaat ? 'Beetplaat gegenereerd' : 'Beetplaat nog niet gegenereerd');
  if (work === 'prothese' || work === 'partieel') {
    add(S.teeth.length ? 'ok' : 'warn', S.teeth.length ? `${S.teeth.length} elementen opgesteld` : 'Geen tandopstelling');
    add(S.plates.monoblock || S.plates.basis ? 'ok' : 'warn', S.plates.monoblock || S.plates.basis ? 'Prothesebasis gegenereerd' : 'Prothesebasis nog niet gegenereerd');
    add(S.antagonist ? 'ok' : 'info', S.antagonist ? 'Antagonist aanwezig: occlusie controleerbaar' : 'Geen antagonist: occlusie niet te controleren');
    add($('splitReviewed').checked ? 'ok' : 'warn', $('splitReviewed').checked ? 'Scheidingslijn beoordeeld' : 'Scheidingslijn niet beoordeeld');
  }
  for (const [k, p] of Object.entries(S.plates)) if (p.soup) { const q = quality(weld(p.soup, 1e-6)); add(q.watertight ? 'ok' : 'warn', `${p.name}: ${q.watertight ? 'gesloten mesh' : `${q.open} open randen, ${q.nonManifold} niet-manifold`}`); }
  add('info', 'Geen klinische validatie: controleer alle bestanden in slicer/CAM en klinisch');
  $('checks').innerHTML = items.map(([c, t]) => `<li class="${c}">${t}</li>`).join('');
  S.checksOk = !items.some(([c]) => c === 'warn'); updateDone();
}
$('runChecks').onclick = runChecks;

// ---------- productie ----------
function outputList() {
  const P = S.plates, list = [];
  const add = (key, label, available, files) => list.push({ key, label, available, files });
  add('lepel', 'Lepel.stl', !!P.lepel, () => [[`Lepel.stl`, P.lepel.soup]]);
  add('beetplaat', 'Beetplaat.stl', !!P.beetplaat, () => [[`Beetplaat.stl`, P.beetplaat.soup]]);
  add('monoblock', 'Monoblock.stl (basis + tanden)', !!P.monoblock, () => [[`Monoblock.stl`, P.monoblock.soup]]);
  add('basis', 'Basis.stl (met sockets)', !!P.basis, () => [[`Basis.stl`, P.basis.soup]]);
  add('elementen', 'Elementen.stl (alle tanden)', !!P.elementen, () => [[`Elementen.stl`, P.elementen.soup]]);
  add('losse', 'Losse elementen per FDI', !!P.elementen, () => P.elementen.parts.map(p => [`elementen/element_${p.fdi}.stl`, p.soup]));
  add('scan', 'Scan (referentie).stl', !!S.scan, () => [[`Scan_referentie.stl`, S.scan]]);
  add('antagonist', 'Antagonist (referentie).stl', !!S.antagonist, () => [[`Antagonist_referentie.stl`, S.antagonist]]);
  return list;
}
function renderOutputs() {
  const host = $('outputs'), prev = new Set([...host.querySelectorAll('input:checked')].map(i => i.value));
  host.innerHTML = '';
  for (const o of outputList()) {
    const l = document.createElement('label'); l.className = 'check' + (o.available ? '' : ' unavailable');
    l.innerHTML = `<input type="checkbox" value="${o.key}" ${o.available ? '' : 'disabled'} ${o.available && (prev.has(o.key) || !prev.size) && !['scan', 'antagonist'].includes(o.key) ? 'checked' : ''}> ${o.label}${o.available ? '' : ' — nog niet gegenereerd'}`;
    host.appendChild(l);
  }
}
$('exportZip').onclick = () => busy('Productiepakket samenstellen…', async () => {
  const chosen = new Set([...$('outputs').querySelectorAll('input:checked')].map(i => i.value));
  const outs = outputList().filter(o => o.available && chosen.has(o.key));
  if (!outs.length) throw Error('Kies minstens één beschikbaar bestand.');
  const dir = `${safe($('caseName').value)}_${jaw() === 'upper' ? 'bovenkaak' : 'onderkaak'}/`;
  const files = [], report = [`Digital Denture CAD ${VERSION} — productierapport`, `Project: ${$('caseName').value || '-'} · ${new Date().toLocaleString('nl-NL')}`, `Bestemming: ${$('destination').selectedOptions[0].text}`, ''];
  for (const o of outs) for (const [name, soup] of o.files()) {
    files.push({ name: dir + name, data: writeSTL(soup, name) });
    const q = quality(weld(soup, 1e-6));
    report.push(`${name}: ${int(q.faces)} driehoeken · ${q.dimensions.map(v => fmt(v)).join(' × ')} mm · ${q.watertight ? `gesloten, volume ${fmt(Math.abs(q.volume))} mm³` : `NIET gesloten (${q.open} open randen)`}`);
  }
  report.push('', 'Geen klinische validatie. Controleer alle bestanden vóór productie.');
  if ($('includeProject').checked) { files.push({ name: dir + 'rapport.txt', data: report.join('\n') }); files.push({ name: dir + 'project.ddcad.json', data: JSON.stringify(projectData(false)) }); }
  download(makeZip(files), `${safe($('caseName').value)}_productie.zip`);
  S.exported = true; updateDone();
  result('exportResult', `${files.length} bestanden in ZIP gezet.`);
});

// ---------- project opslaan / openen ----------
function projectData(includeScan = true) {
  return {
    format: 'ddcad-project', version: VERSION, saved: new Date().toISOString(), settings: settings(), selectedTeeth: [...S.selectedTeeth],
    landmarks: S.landmarks, axis: S.axis, marks: S.marks, contours: S.contours.toJSON(), teeth: S.teeth.length ? teethSnapshot() : null, step: S.step,
    scanName: S.scanName, scan: includeScan && S.scan ? toBase64(writeSTL(S.scan)) : null,
    antagonistName: S.antagonistName, antagonist: includeScan && S.antagonist ? toBase64(writeSTL(S.antagonist)) : null,
  };
}
$('saveProject').onclick = () => busy('Project opslaan…', async () => { download(JSON.stringify(projectData(true)), `${safe($('caseName').value)}.ddcad.json`, 'application/json'); status('Project opgeslagen, inclusief scan.'); });
$('openProject').addEventListener('change', e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) busy('Project openen…', async () => {
  const d = JSON.parse(await f.text());
  if (d.format !== 'ddcad-project' && d.format !== 'denture-cad-project-v1') throw Error('Onbekend projectbestand.');
  applySettings(d.settings); S.selectedTeeth = new Set((d.selectedTeeth || d.settings?.elementen || []).map(Number)); updateTeethMap();
  if (d.scan) setScan(parseSTL(fromBase64(d.scan)), d.scanName);
  if (d.antagonist) setAntagonist(parseSTL(fromBase64(d.antagonist)), d.antagonistName);
  S.landmarks = d.landmarks || {}; S.axis = d.axis || null; S.marks = d.marks || [];
  S.contours.reset(); for (const c of d.contours || []) S.contours.ensure(c.kind).points = c.points;
  computeFrame(); updateLandmarkInfo(); updateAxisInfo(); updateMarkInfo();
  if (d.teeth && (S.frame || !S.scan)) { buildTeeth(); applyTeethSnapshot(d.teeth); }
  showStep(STEPS.some(s => s[0] === d.step) ? d.step : 'opdracht');
  status(d.scan ? 'Project geopend. Omtrekken zijn heropend: sluit ze opnieuw voordat je werkstukken genereert.' : 'Instellingen geladen. Open de STL-scan opnieuw.');
}); });

// ---------- navigatie en sneltoetsen ----------
$('prevStep').onclick = () => { const i = STEPS.findIndex(s => s[0] === S.step); showStep(STEPS[Math.max(0, i - 1)][0]); };
$('nextStep').onclick = () => { const i = STEPS.findIndex(s => s[0] === S.step); showStep(STEPS[Math.min(STEPS.length - 1, i + 1)][0]); };
document.addEventListener('keydown', e => {
  const t = e.target;
  if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (mod && k === 's') { e.preventDefault(); $('saveProject').click(); return; }
  if (mod && (k === 'z' || k === 'y')) {
    e.preventDefault();
    const redo = k === 'y' || e.shiftKey;
    const map = { scan: ['meshUndo', 'meshRedo'], analyse: ['markUndo', 'markRedo'], opstelling: ['teethUndo', 'teethRedo'], bewerken: ['sculptUndo', 'sculptRedo'], lepel: ['contourUndo', 'contourRedo'], beetplaat: ['contourUndo', 'contourRedo'], basis: ['contourUndo', 'contourRedo'] }[S.step];
    if (map) $(map[redo ? 1 : 0]).click();
    return;
  }
  if (mod) return;
  if (S.sculpt && S.step === 'bewerken') {
    if (k === '[' || k === ']') { const r = $('sculptRadius'); r.value = Math.max(0.5, Math.min(15, +r.value + (k === ']' ? 0.5 : -0.5))); r.dispatchEvent(new Event('input')); return; }
    const tk = { a: 'add', r: 'remove', s: 'smooth', v: 'flatten', d: 'drag' }[k]; if (tk) return setSculptTool(tk);
  }
  if (k === 'escape') { if (S.mode !== 'orbit') setMode('orbit'); else selectTooth(null); return; }
  if (k === 'f') return $('focusBtn').click();
  if (k === '?') return $('helpBtn').click();
  if (k === '0') return viewer.fit();
  const views = { 1: 'occlusal', 2: 'front', 3: 'right', 4: 'left' };
  if (views[k]) return viewDir(views[k]);
  if (S.step === 'opstelling' && k === 'g') return setGizmo('translate');
  if (S.step === 'opstelling' && k === 'r') return setGizmo('rotate');
});


// ---------- vrij bewerken (penselen) ----------
const SCULPT_KINDS = { lepel: 'Lepel', beetplaat: 'Beetplaat', monoblock: 'Monoblock prothese', basis: 'Prothesebasis' };
const sculptGap = kind => kind === 'lepel' ? num('lepelGap') : kind === 'beetplaat' ? num('beetGap') : num('basisGap');
let sculptTool = 'add', sculptStroke = null, sculptQueued = null, sculptCursor = null;
function fillSculptTargets() {
  const sel = $('sculptTarget'), prev = sel.value;
  const kinds = Object.keys(SCULPT_KINDS).filter(k => S.plates[k]?.soup);
  sel.innerHTML = kinds.map(k => `<option value="${k}">${SCULPT_KINDS[k]}</option>`).join('') || '<option value="">Nog geen werkstuk gegenereerd</option>';
  if (kinds.includes(prev)) sel.value = prev; else if (kinds.includes($('work').value)) sel.value = $('work').value;
  $('sculptStart').disabled = !kinds.length || !!S.sculpt;
  if (!kinds.length) $('sculptInfo').textContent = 'Genereer eerst een lepel, beetplaat of prothesebasis.';
}
function setSculptTool(t) {
  sculptTool = t;
  for (const b of document.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
  updateSculptLabels();
}
for (const b of document.querySelectorAll('[data-tool]')) b.onclick = () => setSculptTool(b.dataset.tool);
function sculptParams() {
  const r = +$('sculptRadius').value, k = +$('sculptStrength').value / 100;
  // toevoegen/wegnemen: max 0,3 mm per streek; gladmaken/vlakmaken: fractie
  return { radius: r, strength: ['add', 'remove'].includes(sculptTool) ? 0.3 * k : k };
}
function updateSculptLabels() {
  $('sculptRadiusVal').textContent = fmt(+$('sculptRadius').value);
  const k = +$('sculptStrength').value;
  $('sculptStrengthVal').textContent = ['add', 'remove'].includes(sculptTool) ? `${fmt(0.3 * k / 100, 2)} mm per streek` : sculptTool === 'drag' ? '(niet van toepassing)' : `${k}%`;
  if (sculptCursor) sculptCursor.scale.setScalar(+$('sculptRadius').value);
}
$('sculptRadius').addEventListener('input', updateSculptLabels);
$('sculptStrength').addEventListener('input', updateSculptLabels);
updateSculptLabels();
const sculptMirror = () => $('sculptMirror').checked && (S.frame || computeFrame()) ? { O: S.frame.O, X: S.frame.X } : null;
$('sculptMirror').addEventListener('change', () => { if ($('sculptMirror').checked && !(S.frame || computeFrame())) toast('Symmetrie werkt pas als de referentiepunten gezet zijn (stap Analyse).'); });

$('sculptStart').onclick = () => busy('Werkstuk klaarmaken voor bewerken…', async () => {
  const kind = $('sculptTarget').value, plate = S.plates[kind];
  if (!plate?.soup) throw Error('Kies een gegenereerd werkstuk.');
  let protect = null, gap = sculptGap(kind) || 0;
  const bvh = viewer.scanMesh?.geometry?.boundsTree;
  if ($('sculptProtect').checked && bvh) {
    const q = new THREE.Vector3(), target = {}, lim = gap + 0.25;
    protect = (i, x, y, z) => !!bvh.closestPointToPoint(q.set(x, y, z), target, 0, lim);
  }
  const sc = new Sculpt(plate.soup, { protect });
  const g = new THREE.BufferGeometry();
  g.setIndex(new THREE.BufferAttribute(sc.indices, 1));
  g.setAttribute('position', new THREE.BufferAttribute(sc.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(sc.normals, 3));
  g.computeBoundsTree();
  const color = COLORS.plate[kind === 'monoblock' ? 'basis' : kind] ?? COLORS.plate.basis;
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0 }));
  mesh.name = 'sculpt'; viewer.groups.plates.add(mesh);
  S.sculpt = { kind, sc, mesh, original: plate.soup, color, thick: false };
  sculptCursor = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide }));
  sculptCursor.renderOrder = 10; sculptCursor.visible = false; viewer.scene.add(sculptCursor); updateSculptLabels();
  $('sculptTools').classList.remove('hide'); $('sculptStart').disabled = true; $('sculptTarget').disabled = true;
  setMode('sculpt'); syncPlateVisibility(); viewer.render(); updateSculptInfo();
});
function updateSculptInfo(extra = '') {
  const s = S.sculpt; if (!s) return;
  $('sculptUndo').disabled = !s.sc.canUndo; $('sculptRedo').disabled = !s.sc.canRedo;
  $('sculptInfo').textContent = `${SCULPT_KINDS[s.kind]} · ${int(s.sc.count)} punten${s.sc.lockedCount ? ` · ${int(s.sc.lockedCount)} beschermd (pasvlak)` : ''} · ${s.sc.undoStack.length} bewerking(en).${extra}`;
}
function sculptSync(full = false) {
  const s = S.sculpt, g = s.mesh.geometry;
  if (g.attributes.position.array !== s.sc.positions) g.setAttribute('position', new THREE.BufferAttribute(s.sc.positions, 3));
  g.attributes.normal.array.set(s.sc.normals); g.attributes.normal.needsUpdate = true;
  g.attributes.position.needsUpdate = true;
  if (full) { g.boundsTree.refit(); g.computeBoundingSphere(); g.computeBoundingBox(); }
  viewer.render();
}
function sculptCommit() {
  const s = S.sculpt; if (!s) return;
  S.plates[s.kind].soup = s.sc.toSoup(); S.checksOk = false; S.exported = false;
  if (s.thick) { s.thick = false; showThickness(false); }
  updateSculptInfo(); updateDone();
}
function hitSculpt(e) { return S.sculpt ? viewer.pick(e.clientX, e.clientY, [S.sculpt.mesh]) : null; }
function sculptDown(e) {
  const hit = hitSculpt(e); if (!hit) return; // buiten het werkstuk: gewoon draaien
  viewer.controls.enabled = false;
  const s = S.sculpt, P = sculptParams(), invert = e.shiftKey && ['add', 'remove'].includes(sculptTool);
  const tool = invert ? (sculptTool === 'add' ? 'remove' : 'add') : sculptTool;
  s.sc.begin();
  const p = hit.point.toArray(), n = hit.normal ? hit.normal.toArray() : [0, 0, 1];
  sculptStroke = { tool, last: p, P };
  if (tool === 'drag') {
    s.sc.grab(p, P.radius, sculptMirror());
    const camDir = new THREE.Vector3(); viewer.camera.getWorldDirection(camDir);
    sculptStroke.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, hit.point); sculptStroke.origin = hit.point.clone();
  } else { s.sc.dab(tool, p, n, { ...P, mirror: sculptMirror() }); sculptSync(); }
}
function sculptMove(e) {
  if (!S.sculpt) return;
  const ev = { clientX: e.clientX, clientY: e.clientY };
  if (sculptQueued) { sculptQueued = ev; return; }
  sculptQueued = ev;
  requestAnimationFrame(() => {
    const q = sculptQueued; sculptQueued = null; if (!S.sculpt || !q) return;
    const s = S.sculpt, st = sculptStroke;
    if (st?.tool === 'drag') {
      viewer.raycaster.setFromCamera(viewer.ndc(q.clientX, q.clientY), viewer.camera);
      const pt = new THREE.Vector3(); if (!viewer.raycaster.ray.intersectPlane(st.plane, pt)) return;
      s.sc.dragTo(pt.sub(st.origin).toArray()); s.sc.normals = s.sc.normals; sculptSync(); return;
    }
    const hit = hitSculpt(q);
    if (sculptCursor) {
      sculptCursor.visible = !!hit;
      if (hit) { sculptCursor.position.copy(hit.point); if (hit.normal) sculptCursor.lookAt(hit.point.clone().add(hit.normal)); sculptCursor.position.addScaledVector(hit.normal ?? new THREE.Vector3(), 0.05); }
    }
    if (st && hit && pointers.size === 1) {
      const p = hit.point.toArray();
      if (Math.hypot(p[0] - st.last[0], p[1] - st.last[1], p[2] - st.last[2]) >= st.P.radius * 0.25) {
        s.sc.dab(st.tool, p, hit.normal ? hit.normal.toArray() : [0, 0, 1], { ...st.P, mirror: sculptMirror() }); st.last = p; sculptSync();
      }
    } else viewer.render();
  });
}
function sculptUp() {
  viewer.controls.enabled = true;
  if (!sculptStroke || !S.sculpt) { sculptStroke = null; return; }
  if (sculptStroke.tool === 'drag') S.sculpt.sc.release(); else S.sculpt.sc.end();
  sculptStroke = null; sculptSync(true); sculptCommit();
}
$('sculptUndo').onclick = () => { if (S.sculpt?.sc.undo()) { sculptSync(true); sculptCommit(); } };
$('sculptRedo').onclick = () => { if (S.sculpt?.sc.redo()) { sculptSync(true); sculptCommit(); } };

// Diktekaart: per punt loodrecht het materiaal in meten tot de andere kant.
function showThickness(on) {
  const s = S.sculpt; if (!s) return;
  const g = s.mesh.geometry, mat = s.mesh.material;
  $('thickLegend').classList.toggle('hide', !on);
  if (!on) { mat.vertexColors = false; mat.color.set(s.color); mat.needsUpdate = true; g.deleteAttribute('color'); viewer.render(); return; }
  const min = num('thickMin') || 1.5, warn = min + 0.4, sc = s.sc, p = sc.positions, n = sc.normals;
  $('thickMinVal').textContent = fmt(min); $('thickWarnVal').textContent = fmt(warn);
  const col = new Float32Array(p.length), ray = new THREE.Raycaster(); ray.firstHitOnly = false;
  const o = new THREE.Vector3(), d = new THREE.Vector3();
  // randband: punten die direct aan het (beschermde) pasvlak grenzen = zijkant van de plaatrand
  // randband: twee ringen punten naast het (beschermde) pasvlak = zijkant en afronding van de plaatrand
  // (afstandsgebaseerd: alles binnen 2,2 mm van de pasvlakrand, onafhankelijk van de mesh-dichtheid)
  const border = new Uint8Array(sc.count), src = new Int32Array(sc.count).fill(-1), queue = [];
  for (let i = 0; i < sc.count; i++) if (!sc.locked[i]) for (let q = sc.nbStart[i]; q < sc.nbStart[i + 1]; q++) if (sc.locked[sc.nb[q]]) { border[i] = 1; src[i] = i; queue.push(i); break; }
  const dist2 = (a, b) => (p[a * 3] - p[b * 3]) ** 2 + (p[a * 3 + 1] - p[b * 3 + 1]) ** 2 + (p[a * 3 + 2] - p[b * 3 + 2]) ** 2;
  for (let h = 0; h < queue.length; h++) {
    const i = queue[h];
    for (let q = sc.nbStart[i]; q < sc.nbStart[i + 1]; q++) { const v = sc.nb[q]; if (sc.locked[v] || border[v]) continue; if (dist2(v, src[i]) < 2.2 * 2.2) { border[v] = 1; src[v] = src[i]; queue.push(v); } }
  }
  // 1) ruwe dikte per punt (treffers op eigen buurvlakken < 0,15 mm negeren)
  const T = new Float32Array(sc.count).fill(Infinity);
  for (let i = 0; i < sc.count; i++) {
    if (sc.locked[i] || border[i]) continue;
    d.set(-n[i * 3], -n[i * 3 + 1], -n[i * 3 + 2]); o.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
    ray.set(o, d); ray.near = 0.15; ray.far = warn + 0.5;
    const hit = ray.intersectObject(s.mesh, false)[0]; if (hit) T[i] = hit.distance;
  }
  // 2) middelen met de buren: één scheve normaal in een plooitje geeft geen vals alarm
  let thin = 0, minSeen = Infinity;
  for (let i = 0; i < sc.count; i++) {
    let c = [0.27, 0.78, 0.55];
    if (sc.locked[i] || border[i]) c = [0.55, 0.62, 0.68];
    else {
      let sum = Math.min(T[i], warn + 0.5), cnt = 1;
      for (let q = sc.nbStart[i]; q < sc.nbStart[i + 1]; q++) { const v = sc.nb[q]; if (!sc.locked[v] && !border[v]) { sum += Math.min(T[v], warn + 0.5); cnt++; } }
      const t = Math.max(T[i] === Infinity ? warn + 0.5 : T[i], sum / cnt);
      if (t < warn + 0.5) { minSeen = Math.min(minSeen, t); if (t < min) { c = [0.95, 0.33, 0.38]; thin++; } else if (t < warn) c = [0.97, 0.72, 0.3]; }
    }
    col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3)); mat.vertexColors = true; mat.color.set(0xffffff); mat.needsUpdate = true; s.thick = true; viewer.render();
  updateSculptInfo(thin ? ` ⚠ ${int(thin)} punten dunner dan ${fmt(min)} mm (dunste ${fmt(minSeen, 2)} mm).` : ` Dikte overal ≥ ${fmt(min)} mm.`);
}
$('sculptThick').onclick = () => busy('Dikte meten…', async () => showThickness(!S.sculpt?.thick));

function finishSculpt(keep) {
  const s = S.sculpt; if (!s) return;
  if (sculptStroke) sculptUp();
  if (!keep) S.plates[s.kind].soup = s.original;
  viewer.groups.plates.remove(s.mesh); s.mesh.geometry.disposeBoundsTree(); s.mesh.geometry.dispose(); s.mesh.material.dispose();
  if (sculptCursor) { viewer.scene.remove(sculptCursor); sculptCursor.geometry.dispose(); sculptCursor.material.dispose(); sculptCursor = null; }
  S.sculpt = null;
  const kind = s.kind, soup = S.plates[kind].soup;
  if (kind === 'monoblock') { showPlate('basis', soup, COLORS.plate.basis); showPlate('basisTeeth', null); }
  else showPlate(kind, soup, COLORS.plate[kind] ?? COLORS.plate.basis);
  $('sculptTools').classList.add('hide'); $('sculptTarget').disabled = false; $('thickLegend').classList.add('hide');
  if (S.mode === 'sculpt') setMode('orbit');
  fillSculptTargets();
  const { text } = plateSummary(soup);
  $('sculptInfo').textContent = keep ? `Bewerking bewaard. ${SCULPT_KINDS[kind]}: ${text}.` : 'Bewerking geannuleerd; het werkstuk is teruggezet.';
  syncPlateVisibility(); updateDone();
}
$('sculptDone').onclick = () => finishSculpt(true);
$('sculptCancel').onclick = () => finishSculpt(false);

// beetwal-velden alleen tonen als de wal aan staat
const syncRimFields = () => $('rimFields').classList.toggle('hide', !$('rimOn').checked);
$('rimOn').addEventListener('change', syncRimFields);

// ---------- start ----------
buildSteps(); buildToothMap();
try { const saved = JSON.parse(localStorage.getItem(STORE) || 'null'); if (saved) { if (!saved.v61 && saved.settings) saved.settings.rimOn = false; applySettings(saved.settings); S.selectedTeeth = new Set(saved.teeth || []); } } catch { /* geen opslag */ }
updateTeethMap(); syncConceptUI(); updateAxisInfo(); updateLandmarkInfo(); updateMarkInfo(); renderToothList();
$('biteDraft').disabled = $('biteFit').value !== 'block';
syncRimFields();
showStep('opdracht');
loadManifold().catch(() => toast('Booleaanse module kon niet laden; handvat, beetwal en monoblock zijn dan niet beschikbaar.', true));
if (new URLSearchParams(location.search).has('demo')) $('demoBtn').click();
// Overdracht vanuit het orderoverzicht: product openen, weefselzijde halen en opdrachtbon invullen.
if (new URLSearchParams(location.search).has('handoff')) takeHandoff().then(item => {
  history.replaceState(null, '', location.pathname);
  if (!item) return status('Geen bestand ontvangen uit het orderoverzicht (verlopen?). Open het opnieuw.', true);
  return busy('Bestand uit orderoverzicht openen…', async () => {
    const soup = parseSTL(item.buffer);
    if (item.caseName) $('caseName').value = item.caseName;
    if (item.jaw === 'ok' || item.jaw === 'bk') { $('jaw').value = item.jaw === 'ok' ? 'onder' : 'boven'; updateTeethMap(); }
    if (item.product === 'lepel' || item.product === 'beetplaat') $('work').value = item.product;
    else if (item.product === 'beetwal') $('work').value = 'beetplaat';
    persist();
    setScan(soup, item.name);
    showStep('scan');
  }).then(() => { if (item.extract && S.scan) $('intaglioBtn').click(); });
}).catch(e => status('Overdracht mislukt: ' + e.message, true));

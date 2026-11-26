// Digital Denture CAD 65 — hoofdmodule: koppelt interface, 3D-werkruimte en rekenmodules.
import { tr } from './i18n.js'; // v71: taalkeuze (moet als eerste: vertaalt de pagina vóór de rest opbouwt)
import { openStlPreview } from './preview.js';
import { initHandleTools } from './steps/handle-tools.js';
import * as THREE from 'three';
import { Viewer, makePolyline, makeDots, makeMesh, COLORS } from './viewer.js';
import { parseSTL, writeSTL, soupBounds, toBase64, fromBase64, concatSoups } from './stl.js';
import { fitReport, weld, quality, repair, toSoup, flipSoup, applyMatrixToSoup, boundaryLoops, loopLength } from './mesh.js';
import { shell, shellAsync } from './shell.js';
import { selfIntersections } from './meshcheck.js';
import { ContourSet, editableOutline, untangle } from './contour.js';
import { simplifySoup, simplifyText, SCAN_LIMIT } from './decimate.js';
import { occlusalAxis, autoLandmarks, undercutMarks, vec } from './analysis.js';
import { archFrame, defaultFrame, placeTeeth, autoOcclude, contactMap, clearContactMap, framePoint, archPoint } from './setup.js';
import { FDI_UPPER, FDI_LOWER, formArch } from './teeth.js';
import { biteRim, capUnderRim, gingivaBand, trayHandle, handleGeometry, HANDLE_DEFAULT, perforations, tissueStops } from './construct.js';
import { unionSoups, subtractSoups, loadManifold, unionSubtract, unionSubtractClip, clipToOutline } from './csg.js';
import { demoJaw, demoAntagonist, anatomicJaw } from './demo.js';
import { makeZip } from './zip.js';
import { extractIntaglio } from './intaglio.js';
import { takeHandoff } from './handoff.js';
import { Sculpt, TOOLS } from './sculpt.js';
import { analyzeScan, repairScan, extendBorder, keepComponentNear } from './prep.js';
import { trimByOutline, trimByEdge, axisBasis } from './trim.js';
import { WaxLayer } from './wax.js';
import { splitParts, partZone, keepOutlineClear, barBlocks, footprintField, wallAroundRelief } from './parts.js';
import { tidyBorder } from './border.js';
import { initSetupTools, geometrySoup } from './setup-tools.js';
import { VERSION } from './version.js';
import { initScanTools } from './steps/scan-tools.js';
import { initContourTools } from './steps/contour-tools.js';
import { smoothOutline, cleanRim } from './scan-edit.js';
import { bowIdeal } from './library.js';
import { analyseArch, proposeOutline, tissueZones, idealizeScan, ZONE_LABEL, RULES, crestArch, setupArch, occlusalPlaneRule, staticsReport } from './anatomy.js';

const $ = id => document.getElementById(id);
const num = id => { const v = $(id).valueAsNumber; return Number.isFinite(v) ? v : Number($(id).value); };
const fmt = (v, d = 1) => Number(v).toLocaleString('nl-NL', { minimumFractionDigits: d, maximumFractionDigits: d });
const int = v => Number(v).toLocaleString('nl-NL');

const STEPS = [['opdracht', 'Opdrachtbon'], ['scan', 'Scan & mesh'], ['analyse', 'Analyse'], ['lepel', 'Lepel'], ['beetplaat', 'Beetplaat'], ['opstelling', 'Opstelling'], ['basis', 'Basis'], ['bewerken', 'Bewerken'], ['controle', 'Controle'], ['productie', 'Productie']];
const CONTOUR_KINDS = ['lepel', 'beetplaat', 'basis'];
// Per werkstuk alleen de stappen die erbij horen: lepel = plaat (met of zonder handvat), beetplaat = alleen de plaat,
// prothese = basis met elementen.
const WORK_STEPS = {
  lepel: ['opdracht', 'scan', 'analyse', 'lepel', 'bewerken', 'controle', 'productie'],
  beetplaat: ['opdracht', 'scan', 'analyse', 'beetplaat', 'bewerken', 'controle', 'productie'],
  prothese: ['opdracht', 'scan', 'analyse', 'opstelling', 'basis', 'bewerken', 'controle', 'productie'],
};
const workSteps = () => WORK_STEPS[$('work').value === 'partieel' ? 'prothese' : $('work').value] ?? STEPS.map(x => x[0]);
const isDenture = () => ['prothese', 'partieel'].includes($('work').value);
const LM_COLORS = { R: 0xff6b6b, M: 0xffd166, L: 0x4dabf7 };
const MARK_COLORS = { boundary: 0x55d8f5, bar: 0xff6877, reference: 0xffce72 };
const MODE_SHORT = { handle: '✋ Handvat · sleep de oranje bol', contour: '✏️ Tekenen · twee vingers = draaien/zoomen', scanedit: 'Scan bewerken · Esc = stoppen', sculpt: 'Bewerken · buiten het werkstuk draaien', wax: 'Was · buiten de scan draaien', grind: 'Inslijpen · buiten de elementen draaien' };
const MODE_TEXT = { handle: 'Handvat vormen: sleep de oranje bol · twee vingers op het handvat = breedte/zijwaarts · buiten het handvat draaien', scanedit: 'Scan bewerken: zie de aanwijzing onderaan · Esc = stoppen', grind: 'Inslijpen: sleep over een element (kleur = contact met de tegenkaak) · buiten de elementen draaien', wax: 'Was bewerken: sleep over scan of was · buiten de scan draaien · Shift keert toevoegen/wegnemen om', contourHint: ' · slepen = draaien, knijpen/scrollen = zoomen', sculpt: 'Bewerken: sleep over het werkstuk · buiten het werkstuk draaien · Shift keert toevoegen/wegnemen om', contour: 'Tekenen: trek de lijn met vinger of muis · begin óp de lijn = dat stuk overtekenen · tik = punt · twee vingers of rechtermuisknop = draaien · knijpen/scrollen = zoomen', landmark: 'Tik op de kam voor punt ', mark: 'Markeren: sleep over de scan', reference: 'Tik om een referentiepunt te zetten' };

const S = {
  scan: null, scanName: 'scan.stl', history: [], future: [], parts: [], // v72: parts = losse onderdelen (steg)
  antagonist: null, antagonistName: null,
  axis: null, landmarks: {}, marks: [], marksRedo: [],
  contours: new ContourSet(), plates: {},
  teeth: [], teethHistory: [], teethFuture: [], teethInitial: null, frame: null,
  undercut: null, mode: 'orbit', modeArg: null, step: 'opdracht', selected: null, gizmoMode: null,
  selectedTeeth: new Set(), exported: false, checksOk: false,
};

const viewer = new Viewer($('viewport'));
let tools = null; // opstelgereedschap (v65), wordt onderaan gestart
let scanTools = null; // scanbewerking (v65.3)
let contourTools = null, handleTools = null; // omtrek tekenen/slepen (v67)
window.ddcad = { S, viewer, get buildBasis() { return buildBasis; }, get tools() { return tools; }, get handleTools() { return handleTools; }, setPartMode: (i, m) => setPartMode(i, m), get scanForPlates() { return scanForPlates; }, get surfaceFor() { return surfaceFor; } }; // voor ontwikkeling en tests

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
// Even ademhalen tussen zware rekenstappen (v68): de browser verwerkt aanrakingen/klikken en tekent de voortgang,
// zodat Edge/Chrome niet meer 'Deze pagina reageert niet' tonen. Ook in een tabblad op de achtergrond gaat hij door.
function tick(text) {
  if (text) $('busyText').textContent = text;
  return new Promise(r => { let done = false; const go = () => { if (!done) { done = true; setTimeout(r, 0); } }; requestAnimationFrame(go); setTimeout(go, 60); });
}
const WHERE = /iPhone|iPad|iPod/.test(navigator.userAgent) ? 'Bestanden → Downloads' : /Android/.test(navigator.userAgent) ? 'Mijn bestanden → Downloads' : 'je map Downloads';
// Als de app als claude.ai-artifact draait, gaan downloads via de downloads-capability (alleen toegestane
// extensies: STL wordt dan in een ZIP verpakt). Anders de gewone browserdownload.
let artifactDownloads = null;
if (window.claude?.use) window.claude.use('downloads').then(d => { artifactDownloads = d; }).catch(() => {});
const ARTIFACT_EXT = /\.(zip|json|txt|csv|md|png|jpg|jpeg|svg|pdf|html)$/i;
function download(blobOrBuffer, name, type = 'application/octet-stream') {
  if (artifactDownloads) {
    let data = blobOrBuffer instanceof Blob ? blobOrBuffer : new Blob([blobOrBuffer], { type }), file = name;
    const go = async () => {
      if (!ARTIFACT_EXT.test(file)) { const bytes = new Uint8Array(await data.arrayBuffer()); data = new Blob([makeZip([{ name, data: bytes }])]); file = name.replace(/\.[^.]+$/, '') + '.zip'; }
      try { await artifactDownloads.save({ filename: file, data }); toast(`Opgeslagen: ${file}`); }
      catch (e) { if (e?.code !== 'declined') toast(`Downloaden lukt hier niet (${e?.code ?? e}).`, true); }
    };
    go(); return;
  }
  const blob = blobOrBuffer instanceof Blob ? blobOrBuffer : new Blob([blobOrBuffer], { type });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`Opgeslagen: ${name} (${fmt(blob.size / 1048576, 1)} MB) → ${WHERE}`);
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
      b.onclick = () => { chooseWorkFor(id); showStep(id); if (host.id === 'mobileSteps') $('right').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
      host.appendChild(host.id === 'steps' ? wrapLi(b) : b);
    }
  }
}
// Een werkstukstap aantikken kiest dat werkstuk (Lepel, Beetplaat of Prothese via Opstelling/Basis).
function chooseWorkFor(id) {
  const w = $('work').value, want = id === 'lepel' || id === 'beetplaat' ? id : (id === 'opstelling' || id === 'basis') && !isDenture() ? 'prothese' : null;
  if (!want || want === w) return;
  $('work').value = want; persist(); syncWorkSteps();
  status(`Werkstuk gewisseld naar ${$('work').selectedOptions[0].text}.`);
}
function wrapLi(b) { const li = document.createElement('li'); li.appendChild(b); return li; }
function showStep(id) {
  if (S.sculpt && id !== 'bewerken') finishSculpt(true);
  if (id !== 'productie') stopPreview();
  S.step = id;
  if (id === 'bewerken') fillSculptTargets();
  for (const p of document.querySelectorAll('.panel')) p.classList.toggle('active', p.dataset.panel === id);
  for (const b of document.querySelectorAll('[data-step]')) b.classList.toggle('active', b.dataset.step === id);
  $('contourBar').classList.toggle('hide', !CONTOUR_KINDS.includes(id));
  if (S.mode !== 'orbit' && !(S.mode === 'contour' && CONTOUR_KINDS.includes(id)) && !(S.mode === 'sculpt' && id === 'bewerken') && !(S.mode === 'wax' && id === 'analyse')) setMode('orbit');
  if (id !== 'opstelling') selectTooth(null);
  tools?.onStep(id);
  if (id !== 'scan') scanTools?.off();
  applyLayers();
  if (id === 'productie') renderOutputs();
  if (id === 'controle') runChecks();
  updateContourUI(); refreshScanColors(); refreshOverlay(); syncPlateVisibility(); updateDone();
  syncHeaderNav();
  autoStep(id);
}
// Bij het openen van Lepel/Beetplaat/Basis zonder werkstuk: zelf de rand volgens de anatomie zetten en het werkstuk maken.
let autoStepBusy = false;
function autoStep(id) {
  if (autoStepBusy || S.autoRunning || !S.scan || !['lepel', 'beetplaat', 'basis'].includes(id) || !$('autoOnStep')?.checked) return;
  if (S.plates[id] || (id === 'basis' && S.plates.monoblock)) return;
  if (id === 'basis' && !S.teeth.length) return;
  const hasContour = !!S.contours.get(id)?.closed;
  autoStepBusy = true;
  setTimeout(() => busy(`Rand ${id === 'basis' ? 'basis' : id} automatisch…`, async () => {
    try {
      const t0 = performance.now();
      // scan voorbereiden alleen als er nog niets aan gedaan is (was en bewerkingen blijven altijd behouden)
      if (S.prepared !== S.scan && !S.frame) { await prepareScan({ forKind: id }); S.prepared = S.scan; }
      await tick('Referentiepunten op de kam…'); ensureFrame();
      if (!hasContour) { await tick(`Rand ${id === 'basis' ? 'basis' : id} bepalen…`); autoContour(id); }
      await tick(`${id === 'lepel' ? 'Lepel' : id === 'beetplaat' ? 'Beetplaat' : 'Prothesebasis'} opbouwen…`);
      await ({ lepel: buildLepel, beetplaat: buildBeet, basis: buildBasis })[id]();
      console.info(`automatisch ${id}: ${Math.round(performance.now() - t0)} ms`);
      const edge = S.contours.get(id)?.edge;
      status(`${id === 'lepel' ? 'Lepel' : id === 'beetplaat' ? 'Beetplaat' : 'Prothesebasis'} automatisch gemaakt: ${edge ? `rand langs de scanrand${edge.inset ? ` (${fmt(edge.inset)} mm erbinnen)` : ' (plaatrand = scanrand)'}` : 'rand volgens de anatomie'}. Sleep de lijn om de rand aan te passen (of ✏️ Teken om een stuk over te tekenen) en tik daarna op Genereer.`);
    } finally { autoStepBusy = false; }
  }), 50);
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
function persist() { try { localStorage.setItem(STORE, JSON.stringify({ v61: true, v63: true, settings: settings(), teeth: [...S.selectedTeeth] })); } catch { /* geen opslag */ } }
for (const e of document.querySelectorAll('[data-persist]')) e.addEventListener('change', () => { persist(); updateDone(); });

// ---------- scan ----------
const SIMPLIFIED = new WeakMap(); // scan → rapport van het vereenvoudigen (nauwkeurigheidsmelding bij het werkstuk)
const ORIGINALS = new WeakSet();  // onbewerkte scans zoals geopend (terugzetten daarnaartoe = niet vereenvoudigd)
function setScan(soup, name, { reset = true, designedFrom = null, keepWax = false, parts = null } = {}) {
  // een bewerking op een vereenvoudigde scan blijft 'vereenvoudigd' (zelfde foutgrens t.o.v. het origineel)
  if (soup && !reset && S.scan && !SIMPLIFIED.has(soup) && !ORIGINALS.has(soup) && SIMPLIFIED.has(S.scan)) SIMPLIFIED.set(soup, SIMPLIFIED.get(S.scan));
  if (soup && reset) ORIGINALS.add(soup);
  // keepWax: de scanpunten zelf zijn niet verschoven (repareren/bijsnijden): was per punt overnemen in plaats van wissen
  if (S.wax && S.wax.soup !== soup && keepWax && soup && !reset && S.wax.stats().points) { S.wax = S.wax.transferTo(soup); S.waxSoup = S.wax.stats().points ? S.wax.waxedSoup() : null; S.waxMoved = true; }
  else if (S.wax && S.wax.soup !== soup) { S.wax = null; S.waxSoup = null; viewer.clearGroup('wax'); }
  S.scan = soup; S.scanName = name || S.scanName; S.designedFrom = designedFrom;
  viewer.setScan(soup, { keepView: !reset });
  $('emptyHint').classList.toggle('hide', !!soup);
  if (reset) {
    S.history = []; S.future = []; S.landmarks = {}; S.marks = []; S.marksRedo = []; S.axis = null; S.frame = null;
    S.contours.reset(); clearPlates(); clearTeeth();
    S.parts = parts ?? [];
  } else reopenContours();
  viewer.setParts(S.parts); updatePartsUI();
  S.undercut = null;
  if (S.waxMoved) { S.waxMoved = false; showWax(); }
  applyLayers();
  updateScanInfo(); refreshScanColors(); refreshOverlay(); updateDone();
  syncHeaderNav(); // v72: ↶ ↷ op het beeld tonen zodra er een scan is
}
function reopenContours() { for (const k of S.contours.shapes.keys()) S.contours.invalidate(k); updateContourUI(); }
function updateScanInfo() {
  if (!S.scan) { $('scanInfo').textContent = 'Nog geen scan geladen.'; return; }
  const b = soupBounds(S.scan), d = b.size.map(v => fmt(v)).join(' × ');
  const max = Math.max(...b.size);
  const unit = max > 250 ? ' ⚠ Zeer groot: staat de scan in millimeters?' : max < 10 ? ' ⚠ Zeer klein: controleer de eenheden.' : '';
  $('scanInfo').textContent = `${S.scanName} · ${int(S.scan.length / 9)} driehoeken · ${d} mm.${unit}`;
}
// ---------- vereenvoudigen (grote scans) ----------
// Scans van labscanners hebben vaak 1–3 miljoen facetten; een plaat daarop is te zwaar. Vereenvoudigen met een harde
// foutgrens (decimate.js): rand exact, alleen originele punten, elk weggehaald punt binnen de tolerantie.
function simplifyOptions(forPlates = false) {
  const tol = Math.min(0.05, Math.max(0.002, num('simpTol') || 0.01)), target = Math.max(20000, Math.round(num('simpTarget') || 300000));
  // alleen als het anders niet onder de grens komt mag de tolerantie (voor een plaat) oplopen tot 0,025 mm
  return { tolerance: tol, targetFaces: Math.min(target, forPlates ? SCAN_LIMIT : Infinity), maxFaces: SCAN_LIMIT, maxTolerance: forPlates ? Math.max(tol, 0.025) : tol };
}
function simplifyReport(rep, prefix = '') {
  const txt = prefix + simplifyText(rep) + (rep.tolerance > num('simpTol') + 1e-9 ? ` · tolerantie verhoogd tot ${fmt(rep.tolerance, 3)} mm om onder ${int(SCAN_LIMIT)} te komen` : '') + '. ↶ Terug zet de originele scan terug.';
  $('simpReport').textContent = txt;
  return txt;
}
// Vervangt de scan door een vereenvoudigde versie; de originele scan blijft in de geschiedenis (↶).
function reduceScan({ forPlates = false } = {}) {
  if (!S.scan) throw Error('Laad eerst een scan.');
  const opts = simplifyOptions(forPlates);
  if (S.scan.length / 9 <= opts.targetFaces) { $('simpReport').textContent = `De scan heeft ${int(S.scan.length / 9)} facetten: dat is al niet meer dan het streefaantal.`; return null; }
  const r = simplifySoup(S.scan, { ...opts, lockFrom: S.designedFrom });
  if (r.report.after >= r.report.before) { $('simpReport').textContent = 'Binnen deze afwijking valt er niets weg te halen.'; return null; }
  const prev = SIMPLIFIED.get(S.scan); // twee keer vereenvoudigd: de afwijkingen tellen hooguit op
  SIMPLIFIED.set(r.soup, prev ? { ...r.report, maxDeviation: r.report.maxDeviation + prev.maxDeviation, before: prev.before } : r.report);
  const wax = S.wax?.stats().points;
  S.history.push({ soup: S.scan, aux: snapshotAux() }); noteAction('scan'); if (S.history.length > 8) S.history.shift(); S.future = [];
  setScan(r.soup, S.scanName, { reset: false, designedFrom: r.lockFrom });
  if (wax) toast('Let op: de was hoorde bij de oude scan en is verwijderd. Breng hem opnieuw aan (Analyse).', true);
  simplifyReport(r.report);
  return r;
}
// Vóór elke plaat: past de scan niet, dan eerst vereenvoudigen (anders lukt de plaat niet).
function ensureWorkableScan() {
  const src = scanForPlates();
  if (!src || src.length / 9 <= SCAN_LIMIT) return;
  const r = reduceScan({ forPlates: true });
  if (r) toast(`De scan was te groot voor een plaat en is vereenvoudigd: ${simplifyText(r.report)}.`);
}
$('simpRun').onclick = () => busy('Scan vereenvoudigen…', async () => {
  const keep = keepDesign(), r = reduceScan();
  if (!r) return;
  status(`Scan vereenvoudigd: ${simplifyText(r.report)}.`);
  restoreDesign(keep);
});
// Bij het openen: een zware scan meteen vereenvoudigen (instelbaar). Geeft { soup, original, text }.
function autoSimplify(soup) {
  if (!$('simpAuto').checked || soup.length / 9 <= SCAN_LIMIT) return { soup, original: null, text: '' };
  const r = simplifySoup(soup, simplifyOptions(true));
  SIMPLIFIED.set(r.soup, r.report);
  return { soup: r.soup, original: soup, text: simplifyReport(r.report, 'Automatisch vereenvoudigd: '), report: r.report };
}
async function loadScanFile(file) {
  await busy('STL inlezen…', async () => {
    let soup = parseSTL(await file.arrayBuffer());
    const raw = soup.length / 9;
    // v72: gesloten onderdelen (steg) naast de kaak apart zetten, vóór vereenvoudigen en voorbereiden
    const sp = splitParts(soup); soup = sp.scan;
    const parts = sp.parts.map(p => ({ ...p, id: ++PART_SEQ, mode: 'scan' }));
    ORIGINALS.add(soup);
    if ($('simpAuto').checked && raw > SCAN_LIMIT) { $('busyText').textContent = `Grote scan (${int(raw)} facetten) vereenvoudigen…`; await new Promise(r => setTimeout(r, 30)); }
    const auto = autoSimplify(soup); soup = auto.soup;
    setScan(soup, file.name, { parts });
    if (auto.original) S.history = [{ soup: auto.original, aux: snapshotAux() }];
    else $('simpReport').textContent = '';
    let closed = false;
    try { closed = soup.length / 9 < 1_500_000 && quality(weld(soup, 1e-5)).open === 0; } catch { /* alleen hint */ }
    $('intaglioInfo').textContent = closed ? 'Dit is een gesloten model. Is het een bestaande lepel/beetplaat? Haal dan hierboven de weefselzijde eruit.' : '';
    status(`Scan geladen: ${file.name} · ${int(raw)} driehoeken${auto.original ? ` → ${int(soup.length / 9)} (vereenvoudigd, max. afwijking ${fmt(auto.report.maxDeviation, 3)} mm; ↶ Terug bij Scan & mesh = origineel)` : ''}.${closed ? ' Gesloten model: kies bij Scan & mesh "Weefselzijde uit product halen" om er een nieuwe plaat op te maken.' : ''}${parts.length ? ' ' + partsLoadedText(parts) : ''}`);
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
  S.history = [{ soup: before, aux: snapshotAux() }]; S.future = []; noteAction('scan');
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
  const j = jaw(), { soup } = anatomicJaw({ jaw: j, torus: j === 'upper' });
  setScan(soup, j === 'upper' ? 'demo_bovenkaak.stl' : 'demo_onderkaak.stl');
  status(`Anatomische demo-${j === 'upper' ? 'bovenkaak (met torus)' : 'onderkaak'} geladen, met vestibulum en frenula. Kies Analyse → 🧭 Analyseer kaak, of bij Lepel/Beetplaat → 🧭 Automatisch.`);
});
// Slepen-en-neerzetten van STL-bestanden.
$('viewport').addEventListener('dragover', e => e.preventDefault());
$('viewport').addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f && /\.stl$/i.test(f.name)) loadScanFile(f); });

function snapshotAux() { const a = JSON.parse(JSON.stringify({ landmarks: S.landmarks, marks: S.marks, axis: S.axis, contours: S.contours.toJSON(), designedFrom: S.designedFrom ?? null })); a.parts = S.parts; return a; }
function restoreAux(a) { S.designedFrom = a.designedFrom ?? null; S.landmarks = a.landmarks; S.marks = a.marks; S.axis = a.axis; S.contours.reset(); for (const c of a.contours) { const s = S.contours.ensure(c.kind); s.points = c.points; s.closed = !!c.closed; s.axis = c.axis ?? null; s.edge = c.edge ?? null; }  if (a.parts) S.parts = a.parts; }
// Scan bewerken zonder het ontwerp kwijt te raken: de opstelling blijft (bij verplaatsen/draaien/schalen gaat hij mee)
// en lepel, beetplaat en basis worden daarna automatisch opnieuw gegenereerd op de bijgewerkte scan.
function keepDesign(matrix = null) {
  const kinds = ['lepel', 'beetplaat', 'basis'].filter(k => k === 'basis' ? S.plates.basis || S.plates.monoblock : S.plates[k]);
  const teeth = [...S.teeth, ...(S.opp || [])];
  if (matrix && teeth.length) {
    if (matrix.determinant() < 0) clearTeeth(); // spiegelen: elementen zouden binnenstebuiten raken
    else { tools?.centric(); for (const t of teeth) { t.applyMatrix4(matrix); t.updateMatrixWorld(); } }
  }
  return { kinds };
}
function restoreDesign(keep) {
  if (S.frame && landmarksComplete()) { const f = computeFrame(); if (f) S.frame = f; }
  tools?.resetRows();
  if (!keep?.kinds.length) { viewer.render(); return; }
  // terug naar de zware originele scan: niet meteen opnieuw bouwen (dat zou hem direct weer vereenvoudigen)
  if (S.scan && S.scan.length / 9 > SCAN_LIMIT) { viewer.render(); status(`Originele scan terug (${int(S.scan.length / 9)} facetten). De werkstukken blijven zoals ze waren; bij Genereer wordt de scan eerst vereenvoudigd.`); return; }
  const build = { lepel: buildLepel, beetplaat: buildBeet, basis: buildBasis };
  setTimeout(() => busy('Werkstukken opnieuw maken op de bijgewerkte scan…', async () => {
    for (const k of keep.kinds) { if (k === 'basis' && !S.teeth.length) continue; if (!S.contours.get(k)?.closed) autoContour(k); await build[k](); }
    status(`Scan bijgewerkt; ${keep.kinds.map(k => k === 'basis' ? 'prothesebasis' : k).join(', ')} opnieuw gemaakt. De opstelling is behouden.`);
  }), 30);
}
function transformScan(matrix, label, { winding = false } = {}) {
  if (!S.scan) return status('Laad eerst een scan.', true);
  S.history.push({ soup: S.scan, aux: snapshotAux() }); noteAction('scan'); if (S.history.length > 8) S.history.shift(); S.future = [];
  const soup = winding ? flipSoup(S.scan) : applyMatrixToSoup(S.scan, matrix.elements);
  if (!winding) {
    const tp = p => p && new THREE.Vector3(...p).applyMatrix4(matrix).toArray();
    for (const k of Object.keys(S.landmarks)) S.landmarks[k] = tp(S.landmarks[k]);
    for (const m of S.marks) m.points = m.points.map(tp);
    for (const s of S.contours.shapes.values()) s.points = s.points.map(tp);
    if (S.axis) S.axis = new THREE.Vector3(...S.axis).transformDirection(matrix).toArray();
    // v72: onderdelen (steg) bewegen mee; spiegelen keert de facetten om, dan weer naar buiten richten
    if (S.parts.length) S.parts = S.parts.map(p => { const t = applyMatrixToSoup(p.soup, matrix.elements); return { ...p, soup: matrix.determinant() < 0 ? flipSoup(t) : t }; });
  }
  const keep = keepDesign(matrix);
  setScan(soup, S.scanName, { reset: false });
  status(label);
  restoreDesign(keep);
}
const center = () => { const b = soupBounds(S.scan); return new THREE.Vector3(...b.center); };
const about = (m) => { const c = center(); return new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(m).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z)); };
$('meshMove').onclick = () => { const v = ['moveX', 'moveY', 'moveZ'].map(num); if (!v.every(Number.isFinite)) return status('Ongeldige verplaatsing.', true); transformScan(new THREE.Matrix4().makeTranslation(...v), `Scan verplaatst ${v.join(' / ')} mm.`); };
$('meshRotate').onclick = () => { const deg = num('rotateDegrees'), axis = [[1, 0, 0], [0, 1, 0], [0, 0, 1]][+$('rotateAxis').value]; if (!Number.isFinite(deg)) return; transformScan(about(new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(...axis), deg * Math.PI / 180)), `Scan ${deg}° geroteerd.`); };
$('meshScaleBtn').onclick = () => { const k = num('meshScale'); if (!(k > 0 && k <= 100)) return status('Ongeldige schaalfactor.', true); transformScan(about(new THREE.Matrix4().makeScale(k, k, k)), `Scan geschaald met factor ${k}.`); };
$('meshMirror').onclick = () => { const s = [1, 1, 1]; s[+$('meshAxis').value] = -1; transformScan(about(new THREE.Matrix4().makeScale(...s)), 'Scan gespiegeld.'); };
$('meshFlip').onclick = () => transformScan(null, 'Normaalrichting omgekeerd.', { winding: true });
$('meshCenter').onclick = () => { const c = center(); transformScan(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z), 'Scan gecentreerd rond de oorsprong.'); };
$('meshUndo').onclick = () => { const h = S.history.pop(); if (!h) return status('Niets om terug te zetten in de scan.'); S.future.push({ soup: S.scan, aux: snapshotAux() }); const keep = keepDesign(); restoreAux(h.aux); setScan(h.soup, S.scanName, { reset: false }); status('Scanbewerking teruggedraaid.'); restoreDesign(keep); };
$('meshRedo').onclick = () => { const h = S.future.pop(); if (!h) return status('Niets om opnieuw te doen in de scan.'); S.history.push({ soup: S.scan, aux: snapshotAux() }); const keep = keepDesign(); restoreAux(h.aux); setScan(h.soup, S.scanName, { reset: false }); status('Scanbewerking hersteld.'); restoreDesign(keep); };
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
  S.history.push({ soup: S.scan, aux: snapshotAux() }); noteAction('scan'); S.future = [];
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
// Lagen: elke laag apart aan/uit en met een fader voor de doorzichtigheid.
const LAYERS = { Scan: 'scan', Parts: 'parts', Wax: 'wax', Plates: 'plates', Teeth: 'teeth', Antagonist: 'antagonist' };
function setGroupOpacity(group, op) {
  group.traverse(o => { if (!o.isMesh || !o.material) return; const m = o.material; m.userData.baseOpacity ??= m.opacity ?? 1; const v = Math.min(1, m.userData.baseOpacity * op); m.opacity = v; m.transparent = v < 0.999; m.depthWrite = v >= 0.6; m.needsUpdate = true; });
}
function applyLayers() {
  for (const [id, g] of Object.entries(LAYERS)) {
    const group = viewer.groups[g]; if (!group) continue;
    let on = $('layer' + id).checked;
    if (g === 'teeth') on = on && isDenture() && !(['basis', 'controle', 'productie'].includes(S.step) && (S.plates.monoblock || S.plates.basis));
    group.visible = on; setGroupOpacity(group, num('op' + id) / 100);
    if (g === 'teeth' && viewer.groups.oppTeeth) { viewer.groups.oppTeeth.visible = $('layerTeeth').checked && isDenture() && (S.step === 'opstelling' || on); setGroupOpacity(viewer.groups.oppTeeth, num('opTeeth') / 100); }
  }
  viewer.render();
}
for (const id of Object.keys(LAYERS)) { $('layer' + id).addEventListener('change', applyLayers); $('op' + id).addEventListener('input', applyLayers); }
$('focusBtn').onclick = () => { document.body.classList.toggle('focus'); setTimeout(() => viewer.resize(), 50); };
$('helpBtn').onclick = () => $('helpDialog').showModal();

// ---------- modi en aanwijzen ----------
function setMode(mode, arg = null) {
  S.mode = mode; S.modeArg = arg;
  // Draaien blijft mogelijk tijdens tekenen/punten zetten: slepen = draaien, tikken = punt. Alleen markeren met slepen blokkeert draaien.
  viewer.controls.enableRotate = !(mode === 'mark' && arg !== 'reference');
  $('viewport').classList.toggle('drawing', mode !== 'orbit');
  $('modeChip').classList.toggle('hide', mode === 'orbit');
  const narrow = matchMedia('(max-width: 850px)').matches;
  if (narrow && MODE_SHORT[mode]) $('modeText').textContent = MODE_SHORT[mode];
  else $('modeText').textContent = (mode === 'landmark' ? MODE_TEXT.landmark + ({ R: 'rechts distaal', M: 'midden (incisief)', L: 'links distaal' })[arg] : mode === 'mark' ? (arg === 'reference' ? MODE_TEXT.reference : MODE_TEXT.mark) : MODE_TEXT[mode] || '') + (mode === 'landmark' || (mode === 'mark' && arg === 'reference') ? MODE_TEXT.contourHint : '');
  $('contourToggle').setAttribute('aria-pressed', String(mode === 'contour'));
  if (viewer.scanMesh) refreshScanOutside(); // tijdens tekenen de hele scan zien
  $('waxEdit').setAttribute('aria-pressed', String(mode === 'wax'));
  $('contourToggle').textContent = mode === 'contour' ? '✓ Klaar' : '✏️ Teken';
  contourTools?.onMode(mode);
  if (mode !== 'handle') handleTools?.stop?.();
  for (const id of ['handleEdit', 'beetHandleEdit']) { const b = $(id); if (b) { b.setAttribute('aria-pressed', String(mode === 'handle')); b.textContent = mode === 'handle' ? '✓ Klaar met handvat' : '✋ Handvat vormen'; } }
  for (const b of document.querySelectorAll('[data-landmark]')) b.setAttribute('aria-pressed', String(mode === 'landmark' && b.dataset.landmark === arg));
  for (const b of document.querySelectorAll('[data-mark]')) b.setAttribute('aria-pressed', String(mode === 'mark' && b.dataset.mark === arg));
}
$('modeExit').onclick = () => setMode('orbit');

const pointers = new Map();
let press = null, stroke = null, overlayQueued = false;
const canvas = viewer.canvas;
// ---------- omtrek bewerken met vinger of muis: zie steps/contour-tools.js ----------
S.coarsePointer = matchMedia('(pointer: coarse)').matches;
const _snapV = new THREE.Vector3(), _snapT = {};
function snapToScan(p) { const tree = viewer.scanMesh?.geometry.boundsTree; if (!tree) return p; _snapV.set(p[0], p[1], p[2]); const hit = tree.closestPointToPoint(_snapV, _snapT, 0, 5); return hit ? _snapT.point.toArray() : p; }
function dropPlate(kind) {
  const had = kind === 'basis' ? S.plates.basis || S.plates.monoblock : S.plates[kind];
  delete S.plates[kind]; showPlate(kind, null);
  const el = $({ lepel: 'lepelResult', beetplaat: 'beetResult', basis: 'basisResult' }[kind]);
  if (had && el) el.innerHTML = `<span class="warn">Omtrek gewijzigd: tik op <b>Genereer ${kind === 'lepel' ? 'lepel' : kind === 'beetplaat' ? 'beetplaat' : 'prothese'}</b> voor het nieuwe werkstuk (en de STL).</span>`;
}
function finishContourEdit(kind, msg) {
  const s = S.contours.get(kind);
  if (s) s.edge = null; // met de hand aangepast: vanaf nu een gewone omtrek (uitsnede langs de lijn)
  try { S.contours.close(kind, s.axis ?? contourAxis(), { record: false }); }
  catch (err) { S.contours.undo(kind); S.contours.redo.set(kind, []); contourError(err.message + ' De wijziging is teruggedraaid.'); refreshOverlay(); return false; }
  dropPlate(kind);
  updateContourUI(); refreshScanColors(); refreshOverlay();
  if (msg) status(msg);
  return true;
}

canvas.addEventListener('pointerdown', e => {
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (S.mode === 'sculpt') { if (pointers.size === 1 && e.button === 0) sculptDown(e); else sculptUp(); return; }
  if (S.mode === 'wax') { if (pointers.size === 1 && e.button === 0) waxDown(e); else waxUp(); return; }
  if (viewer.gizmo.dragging || viewer.gizmo.axis) { press = null; return; }
  press = pointers.size === 1 ? { x: e.clientX, y: e.clientY, id: e.pointerId, type: e.pointerType } : null;
  if (S.mode === 'mark' && S.modeArg !== 'reference' && pointers.size === 1 && e.button === 0) {
    const hit = viewer.pick(e.clientX, e.clientY);
    if (hit) { stroke = { kind: S.modeArg, points: [hit.point.toArray()] }; S.marks.push(stroke); S.marksRedo = []; noteAction('mark'); refreshOverlay(); }
  }
});
canvas.addEventListener('pointermove', e => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (S.mode === 'sculpt') { sculptMove(e); return; }
  if (S.mode === 'wax') { waxMove(e); return; }
  if (!stroke || pointers.size !== 1) return;
  const hit = viewer.pick(e.clientX, e.clientY);
  if (!hit) return;
  const last = stroke.points[stroke.points.length - 1];
  if (hit.point.distanceTo(new THREE.Vector3(...last)) > 0.3) { stroke.points.push(hit.point.toArray()); if (!overlayQueued) { overlayQueued = true; requestAnimationFrame(() => { overlayQueued = false; refreshOverlay(); }); } }
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (S.mode === 'sculpt') { sculptUp(); press = null; return; }
  if (S.mode === 'wax') { waxUp(); press = null; return; }
  if (stroke) { if (stroke.points.length < 2) S.marks.pop(); stroke = null; updateMarkInfo(); refreshOverlay(); press = null; return; }
  if (press && press.id === e.pointerId && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 8 && e.type === 'pointerup') handleTap(e, press.type);
  press = null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

function handleTap(e, type) {
  if (S.mode === 'contour') return; // tekenen en tikken op de omtrek: steps/contour-tools.js
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
    if (hit) { S.marks.push({ kind: 'reference', points: [hit.point.toArray()] }); S.marksRedo = []; noteAction('mark'); updateMarkInfo(); refreshOverlay(); }
    return;
  }
  if (tools?.handleTap(e)) return;
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
  if (CONTOUR_KINDS.includes(S.step)) contourTools?.draw(g);
  if (S.frame && ['opstelling', 'beetplaat', 'analyse'].includes(S.step)) {
    const f = S.frame, pts = [], arch = currentArchFn();
    for (let i = 0; i <= 60; i++) { const [x, y] = arch(-1 + 2 * i / 60); pts.push(new THREE.Vector3(...framePoint(f, x, y))); }
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
    if (!s?.closed || kind !== S.step) continue;
    try { S.contours.surface(kind, S.scan); } catch { continue; }
    marks ??= new Uint8Array(n); for (const f of s.facets) marks[f] = i + 1;
  }
  if (S.anatomy?.zones && S.step === 'analyse' && $('anaShow').checked && S.anatomy.soup === S.scan) { marks ??= new Uint8Array(n); for (let f = 0; f < n; f++) if (S.anatomy.zones[f]) marks[f] = 4 + S.anatomy.zones[f]; }
  if (S.undercut && S.step === 'analyse') { marks ??= new Uint8Array(n); for (let f = 0; f < n; f++) if (S.undercut[f]) marks[f] = 4; }
  // aangevuld (niet gescand, ontworpen) deel altijd zichtbaar in paars
  if (S.designedFrom != null && S.designedFrom < n) { marks ??= new Uint8Array(n); for (let f = S.designedFrom; f < n; f++) marks[f] = marks[f] && marks[f] <= 3 ? 11 : 10; }
  viewer.colorFaces(marks, [COLORS.lepel, COLORS.beetplaat, COLORS.basis, COLORS.undercut, ...ZONE_COLORS, [0.72, 0.58, 0.96], [0.52, 0.36, 0.88]]);
  refreshScanOutside();
}
// v68: met een werkstuk de scan buiten de plaatrand doorschijnend (laag 'Scan buiten de rand'): plaatrand en scanrand
// vallen samen; met de fader is de originele scan terug te zien (100) of helemaal weg (0).
function refreshScanOutside() {
  if (!viewer.scanMesh) return;
  const work = $('work').value, kind = CONTOUR_KINDS.includes(S.step) ? S.step : ['controle', 'productie'].includes(S.step) ? (work === 'lepel' ? 'lepel' : work === 'beetplaat' ? 'beetplaat' : 'basis') : null;
  const s = kind && S.contours.get(kind), plate = kind && (kind === 'basis' ? S.plates.basis || S.plates.monoblock : S.plates[kind]);
  if (!s?.closed || !plate || !$('layerOutside').checked || S.mode === 'contour') return viewer.setScanOutside(null);
  try { S.contours.surface(kind, S.scan); } catch { return viewer.setScanOutside(null); }
  const n = S.scan.length / 9, out = new Uint8Array(n).fill(1);
  for (const f of s.facets) if (f < n) out[f] = 0;
  viewer.setScanOutside(out, num('opOutside') / 100);
}
$('layerOutside').addEventListener('change', refreshScanOutside);
$('opOutside').addEventListener('input', refreshScanOutside);

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
$('markUndo').onclick = () => { if (S.marks.length) { S.marksRedo.push(S.marks.pop()); status('Markering teruggedraaid.'); } else status('Niets om terug te zetten.'); updateMarkInfo(); refreshOverlay(); };
$('markRedo').onclick = () => { if (S.marksRedo.length) { S.marks.push(S.marksRedo.pop()); status('Markering hersteld.'); } updateMarkInfo(); refreshOverlay(); };
$('markClear').onclick = () => { S.marks = []; S.marksRedo = []; updateMarkInfo(); refreshOverlay(); };
function updateMarkInfo() { const c = k => S.marks.filter(m => m.kind === k).length; $('markInfo').textContent = `Randlijnen: ${c('boundary')} · stegen: ${c('bar')} · referentiepunten: ${c('reference')}. Ze liggen op het scanoppervlak en draaien mee.`; }

// ---------- omtrek ----------
function updateContourUI() {
  const kind = S.step; if (!CONTOUR_KINDS.includes(kind)) return;
  const s = S.contours.get(kind);
  $('contourUndo').disabled = !S.contours.canUndo(kind);
  $('contourRedo').disabled = !S.contours.canRedo(kind);
  $('contourClear').disabled = !s?.points.length;
  $('contourCrop').disabled = !s?.closed;
  $('contourSmooth').disabled = !s?.closed;
  const el = $('contourStatus');
  el.dataset.error = 'false';
  const pen = S.mode === 'contour';
  el.textContent = !S.scan ? 'Laad eerst een scan.'
    : s?.closed ? (pen ? 'Overtekenen: begin óp de lijn, teken de nieuwe rand en eindig weer óp de lijn. Een hele rondgang = nieuwe omtrek. ✓ Klaar om te stoppen.'
      : `Omtrek gesloten. Pak de lijn op elke plek en sleep (vinger of muis); de gele zone gaat mee (meeneemzone). ✏️ Teken = stuk overtekenen · 〰 Glad = gladstrijken.`)
    : s?.points.length ? `${s.points.length} punten. Teken verder en eindig bij het witte beginpunt (of tik erop) om te sluiten.`
    : pen ? 'Trek de omtrek in één beweging rond het plaatgebied en eindig bij je beginpunt. Tikken zet losse punten.' : 'Nog geen omtrek: kies 🧭 Automatisch, of ✏️ Teken en trek de lijn rond het plaatgebied.';
}
function contourError(msg) { const el = $('contourStatus'); el.textContent = msg; el.dataset.error = 'true'; }
// Insteekas voor de uitsnede: occlusale as van het boogframe, anders de automatisch bepaalde as.
function contourAxis() { return (S.frame?.N ?? S.axis ?? occlusalAxisCached().axis).slice(); }
function closeContourFromAbove(kind) { S.contours.close(kind, contourAxis()); }
$('contourToggle').onclick = () => { if (!S.scan) return contourError('Laad eerst een scan.'); setMode(S.mode === 'contour' ? 'orbit' : 'contour'); updateContourUI(); refreshOverlay(); };
$('contourSmooth').onclick = () => contourTools?.smoothAll();
$('contourUndo').onclick = () => { S.contours.undo(S.step); updateContourUI(); refreshScanColors(); refreshOverlay(); };
$('contourRedo').onclick = () => { S.contours.redoStep(S.step); updateContourUI(); refreshScanColors(); refreshOverlay(); };
$('contourClear').onclick = () => { S.contours.clear(S.step); updateContourUI(); refreshScanColors(); refreshOverlay(); };
$('contourCrop').onclick = () => busy('Uitsnijden…', async () => { const surf = S.contours.surface(S.step, S.scan); download(writeSTL(surf), `UITSNEDE_${S.step}_${safe(S.scanName.replace(/\.stl$/i, ''))}.stl`); status(`Uitgesneden oppervlak: ${int(surf.length / 9)} facetten.`); });

function surfaceFor(kind) {
  if (!S.scan) throw Error('Laad eerst een scan.');
  const s = S.contours.get(kind);
  if (s?.points.length && !s.closed) throw Error('Sluit eerst de omtrek door op het eerste punt te tikken.');
  if (!s?.closed) throw Error('Er is nog geen omtrek. Tik op 🧭 Automatisch of teken de omtrek: zonder omtrek wordt geen plaat gemaakt.');
  return S.contours.surface(kind, scanBase(), S.designedFrom ?? null);
}
// Scan + was (als er was ligt); zelfde facetvolgorde als de scan.
function scanBase() { return S.wax && S.wax.soup === S.scan && S.waxSoup ? S.waxSoup : S.scan; }
const scanForPlates = scanBase;

// ---------- v72: losse onderdelen (steg) ----------
// Bij het openen worden gesloten delen naast de kaak (een steg op implantaten) apart gezet (parts.js). Per onderdeel:
// 'scan' = het werkstuk gaat eroverheen (onder het onderdeel opgevuld langs de insteekas, zoals uitblokken),
// 'apart' = het werkstuk ligt alleen op de kaak. De keuze is terug te draaien (↶) en gaat mee in het project.
let PART_SEQ = 0;
const includedParts = () => S.parts.filter(p => p.mode !== 'apart');
const partWord = p => p.kind === 'steg' ? 'steg' : 'onderdeel';
const partDe = p => p.kind === 'steg' ? 'de steg' : 'het onderdeel';
// Over de steg (zoals in het lab): plaat op het tandvlees ∪ kap over de steg − uitsparing (de steg met alles eronder,
// schroefkanalen dicht). Zo zit er nooit plaatmateriaal onder de steg en klemt het werkstuk niet vast (parts.js).
// De kap wordt bijgesneden tot 0,4 mm binnen de omtrek: voorbij de plaatrand is geen scan, en daar schampte de kap
// anders net langs de dunne plaatrand (niet-manifold randen).
const PART_BLOCKS = new WeakMap();
async function partBlocks(kind, surface, gap, wall) {
  const inc = includedParts(); if (!inc.length || !surface) return null;
  const axis = contourAxis(), s = S.contours.get(kind), key = [kind, gap, wall, ...axis.map(x => x.toFixed(4)), s?.points?.length ?? 0].join('|');
  let c = PART_BLOCKS.get(surface);
  if (!c || c.parts !== S.parts || c.key !== key) {
    const r = barBlocks(inc.map(p => p.soup), axis, { gap, wall, scan: surface });
    if (r && s?.closed && s.points?.length > 2) { await loadManifold(); try { r.cap = await clipToOutline(r.cap, s.points, s.axis, { inset: gap > 0.05 ? 1.2 : 0.4 }); } catch (e) { console.warn('kap bijsnijden', e); } }
    c = { parts: S.parts, key, r }; PART_BLOCKS.set(surface, c);
  }
  return c.r;
}
function partsLoadedText(parts) {
  const n = parts.length, stegs = parts.filter(p => p.kind === 'steg').length;
  return `${n === 1 ? (stegs ? 'Steg' : 'Los onderdeel') : `${n} losse onderdelen`} apart gezet (${int(parts.reduce((a, p) => a + p.faces, 0))} facetten): het werkstuk gaat er nu overheen. Kies bij Scan & mesh of bij het werkstuk 'Zonder steg' voor een werkstuk alleen op de kaak.`;
}
function partSuffix() { if (!S.parts.length) return ''; const w = partWord(S.parts[0]); return includedParts().length ? `_over_${w}` : `_zonder_${w}`; }
function partNote(wall = null) {
  if (!S.parts.length) return '';
  const inc = includedParts(), w = partWord(S.parts[0]), de = partDe(S.parts[0]);
  const fail = inc.length && S.surroundFail && S.surroundFail === S.scan ? ` · <span class="warn">de scan houdt vlak naast ${de} op en kon daar niet worden aangevuld: controleer de plaat rond ${de}</span>` : ''; // v73
  return inc.length ? ` · over ${de}${wall ? `: kap van ${fmt(wall, 1)} mm, de ruimte onder ${de} uitgespaard (geen ondersnijding)` : ''}${fail}` : ` · zonder ${w} (alleen op de kaak)`;
}
// v73: wanddikte rond de holte voor de steg (prothese): zitten de tanden te dicht op de steg, dan worden ze uitgehold
// tot een dun schaaltje. Melden met de dunste plek en het element daar.
function wallNote(soup, relief, surface) {
  const w = wallAroundRelief(soup, relief, surface, contourAxis()); if (!w || (!w.top && !w.side)) return '';
  const de = partDe(S.parts[0]), topMin = w.top?.p5 ?? Infinity, sideMin = w.side?.p5 ?? Infinity; // 5%-waarde: een snijrand loopt altijd naar 0
  const at = topMin < 1.5 ? w.top.at : sideMin < 1 ? w.side.at : null;
  let tooth = ''; if (at && S.teeth.length) { let best = Infinity; for (const t of S.teeth) { const d = t.position.distanceTo(new THREE.Vector3(...at)); if (d < best) { best = d; tooth = t.userData.fdi; } } }
  const nums = `${w.top ? `${fmt(topMin, 1)} mm boven ${de}` : ''}${w.top && w.side ? ', ' : ''}${w.side ? `${fmt(sideMin, 1)} mm opzij` : ''}`;
  if (!at) return ` · materiaal rond ${de}: ${nums} (95% van de wand)`;
  return ` · <span class="warn">te weinig materiaal rond ${de}: ${nums}${tooth ? ` (bij element ${tooth})` : ''}. Daar wordt de prothese uitgehold. Zet het occlusievlak hoger, stel de elementen meer naar buiten op of kies ${S.parts[0].kind === 'steg' ? 'een lagere steg' : 'een lager onderdeel'}.</span>`;
}
// v73: losse elementen (sockets of export 'Elementen') mogen niet in de ruimte van de steg steken: daar inkorten
async function teethClearOfParts(teeth, relief, { measure = false } = {}) {
  let cut = 0, thin = null; const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < relief.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], relief[i + k]); hi[k] = Math.max(hi[k], relief[i + k]); }
  const out = [];
  for (const t of teeth) {
    let hit = false; for (let i = 0; i < t.soup.length && !hit; i += 3) hit = t.soup[i] >= lo[0] && t.soup[i] <= hi[0] && t.soup[i + 1] >= lo[1] && t.soup[i + 1] <= hi[1] && t.soup[i + 2] >= lo[2] && t.soup[i + 2] <= hi[2];
    if (!hit) { out.push(t); continue; }
    try {
      const r = await subtractSoups(t.soup, [relief]);
      if (r?.length && Math.abs(quality(weld(r, 1e-6)).volume - quality(weld(t.soup, 1e-6)).volume) > 0.05) {
        out.push({ ...t, soup: r }); cut++;
        if (measure) { const w = wallAroundRelief(r, relief, null, contourAxis()), m = Math.min(w?.top?.p5 ?? Infinity, w?.side?.p5 ?? Infinity); if (m < (thin?.d ?? Infinity)) thin = { d: m, fdi: t.fdi }; }
        continue;
      }
    } catch (e) { console.warn('element inkorten', e); }
    out.push(t);
  }
  return { teeth: out, cut, thin };
}
// v73: de beetwal blijft minstens 'Wal boven de kap' mm boven de kap over de steg. Ligt de kap hoger dan de gekozen of
// berekende walhoogte min die marge, dan gaat de hele wal evenveel omhoog (het occlusievlak blijft evenwijdig, geen bult
// in de wal). Geeft { height, lift, text }.
function rimOverCap(height, capSoup, opts) {
  const over = Math.max(0, num('rimOverCap') || 0), hAt = typeof height === 'function' ? height : () => height;
  const cu = capUnderRim(S.frame, capSoup, opts), de = partDe(S.parts[0]);
  let lift = 0, top = -Infinity, tight = Infinity;
  cu.ts.forEach((t, i) => { const c = cu.top[i]; if (c === -Infinity) return; top = Math.max(top, c); tight = Math.min(tight, hAt(t) - c); lift = Math.max(lift, c + over - hAt(t)); });
  lift = lift > 0.05 ? Math.ceil(lift * 10) / 10 : 0;
  const h = !lift ? height : typeof height === 'function' ? t => height(t) + lift : height + lift;
  const parts = [];
  if (top > -Infinity) parts.push(lift ? `${lift > 3 ? '<span class="warn">' : ''}wal ${fmt(lift, 1)} mm hoger gezet: de kap over ${de} komt tot ${fmt(top, 1)} mm boven de kam, de wal blijft ${fmt(over, 1)} mm erboven${lift > 3 ? '. Weinig ruimte boven de steg: controleer de beethoogte bij het passen</span>' : ''}` : `wal minstens ${fmt(tight, 1)} mm boven de kap over ${de}`);
  // een kap naast de wal (steg linguaal of buccaal van de wal) die tot in de marge boven de wal komt: alleen melden
  let side = -Infinity; cu.ts.forEach((t, i) => { if (cu.beside[i] > hAt(t) + lift - over) side = Math.max(side, cu.beside[i]); });
  if (side > -Infinity) parts.push(`<span class="warn">let op: de kap over ${de} ligt deels naast de wal en komt daar tot ${fmt(side, 1)} mm boven de kam</span>`);
  return parts.length ? { height: h, lift, text: parts.join(' · ') } : null;
}
// v73: zo ver blijft de omtrek van een steg af. De kap (ruimte + 0,3 mm speling + wand) moet na het bijsnijden (0,4 mm
// binnen de omtrek, bij afdrukruimte 1,2 mm) nog helemaal binnen de plaat liggen, met 0,5 mm over. Lepel 2 + 0,3 + 2,5 +
// 1,2 + 0,5 = 6,5 mm; beetplaat 0 + 0,3 + 2 + 0,4 + 0,5 = 3,2 mm. Was 3 mm voor alles: bij een lepel lag de kap dan
// net te smal en sneed de uitsparing door de zijkant (niet-manifold randen).
function partClear(kind, min = false) {
  const [gap, wall] = kind === 'lepel' ? [num('lepelGap'), num('lepelWall')] : kind === 'beetplaat' ? [num('beetGap'), num('beetWall')] : [num('basisGap'), num('basisWall')];
  // min: wat er minstens moet zijn (kap met 1,5 mm wand), ook als de omtrek daarvoor voorbij de plooi moet
  return min ? (gap || 0) + 0.3 + Math.min(1.5, wall || 2) + (gap > 0.05 ? 1.2 : 0.4) : Math.max(3, (gap || 0) + 0.3 + (wall || 2) + (gap > 0.05 ? 1.2 : 0.4) + 0.5);
}
// Diepte langs de as van het hoogste scanpunt boven (u, w) (voor nieuwe omtrekpunten rond een steg), of null.
function scanDepthAt(axis) {
  const tree = viewer.scanMesh?.geometry.boundsTree; if (!tree) return null;
  const b = axisBasis(axis), N = new THREE.Vector3(...b.N), ray = new THREE.Ray();
  return (u, w) => { ray.origin.set(...[0, 1, 2].map(k => b.U[k] * u + b.V[k] * w + b.N[k] * 500)); ray.direction.copy(N).negate(); const hit = tree.raycastFirst(ray, THREE.DoubleSide); return hit ? hit.point.dot(N) : null; };
}
// v73: houdt de scan vlak naast de steg op (minder dan de benodigde afstand), dan is er rond de steg geen tandvlees
// om de plaat op te bouwen: de omtrek kwam dan buiten de scan en de lepel kreeg niet-manifold randen of zelfs een
// vlies over de tongruimte. De scanrand wordt daar vloeiend verlengd (zoals 'aanvullen'; paars = ontworpen), met een
// zachte overgang naar de rest van de rand. Geeft { gapBefore, length, faces } of null (niet nodig).
const SURROUND_DONE = new WeakMap();
function surroundParts(kinds = CONTOUR_KINDS) {
  const inc = includedParts(); if (!inc.length || !S.scan) return null;
  const clear = Math.max(...kinds.map(partClear)), key = clear.toFixed(2) + '|' + inc.map(p => p.id).join(',');
  if (SURROUND_DONE.get(S.scan) === key) return null;
  const axis = contourAxis(), F = footprintField(inc.map(p => p.soup), axis, clear + 8), b = F.basis;
  const m = weld(S.scan, 1e-6), { loops } = boundaryLoops(m);
  if (!loops.length) return null;
  const P = m.positions, lens = loops.map(l => loopLength(m, l)), loop = loops[lens.indexOf(Math.max(...lens))]; // zoals extendBorder: de langste rand
  let minD = Infinity; for (const v of loop) { const d = F.at(...b.project([P[v * 3], P[v * 3 + 1], P[v * 3 + 2]])).d; if (d < minD) minD = d; }
  SURROUND_DONE.set(S.scan, key);
  if (!(minD < clear + 0.5)) return null;
  const full = clear + 2 - Math.max(0, minD), lo = clear + 0.5, hi = clear + 4;
  const weight = p => { const d = F.at(...b.project(p)).d; if (d <= lo) return 1; if (d >= hi) return 0; const t = (hi - d) / (hi - lo); return t * t * (3 - 2 * t); };
  // De aanvulling mag zichzelf en de scan niet snijden. Loopt de scanrand onder de steg door (daar is niets gescand),
  // dan kan een lange aanvulling omklappen: dan korter proberen. Lukt het niet, dan eerst losse flarden scan vlak naast
  // de steg (smaller dan 3 mm) weghalen en gaten onder de steg dichten (vanaf zo'n flard klapte de aanvulling terug
  // over de scan) en opnieuw. Lukt het dan nog niet: niet aanvullen, maar het melden.
  const tryExtend = src => { for (const f of [1, 0.65, 0.4]) {
    const e = extendBorder(src, { length: full * f, step: 0.5, weight });
    if (!e.report.added) return null;
    const si = selfIntersections(weld(e.soup, 1e-6), { maxPairs: 5e6 });
    let bad = 0; for (let t = e.report.designedFrom; t < si.faces.length; t++) bad += si.faces[t];
    if (!bad) return { e, length: full * f };
  } return null; };
  let src = S.scan, srcDesigned = S.designedFrom ?? null, tidy = null, got = tryExtend(src);
  if (!got) {
    const near = partZone(inc.map(p => p.soup), axis, 2);
    tidy = tidyBorder(S.scan, { designedFrom: srcDesigned, fringe: 1.5, notchWidth: 0, protect: p => !near(p), holeSize: 0, holeNear: near });
    if (tidy.report.fringeFaces || tidy.report.holes) { src = tidy.soup; srcDesigned = tidy.designedFrom; got = tryExtend(src); }
  }
  if (!got) { S.surroundFail = S.scan; return { failed: true, gapBefore: Math.max(0, minD), clear }; }
  const ext = got.e, length = got.length;
  S.history.push({ soup: S.scan, aux: snapshotAux() }); noteAction('scan'); if (S.history.length > 8) S.history.shift(); S.future = [];
  setScan(ext.soup, S.scanName, { reset: false, designedFrom: Math.min(srcDesigned ?? Infinity, ext.report.designedFrom), keepWax: true });
  SURROUND_DONE.set(S.scan, key);
  return { gapBefore: Math.max(0, minD), length, clear, faces: ext.report.added, shorter: length < full - 0.05, flaps: tidy?.report.fringeFaces ?? 0, holes: tidy?.report.holes ?? 0 };
}
const surroundText = r => { const de = partDe(S.parts[0]); return r.failed
  ? `<span class="warn">de scan houdt ${fmt(r.gapBefore, 1)} mm naast ${de} op (nodig is ${fmt(r.clear, 1)} mm) en de rand kon daar niet zonder kruisen worden aangevuld: scan het tandvlees rond ${de} mee, of teken de omtrek zelf</span>`
  : `scanrand rond ${de} aangevuld (paars = ontworpen, niet gescand): de scan hield ${fmt(r.gapBefore, 1)} mm naast ${de} op, nodig is ${fmt(r.clear, 1)} mm${r.shorter ? ` · ${fmt(r.length, 1)} mm verlengd, verder klapte de aanvulling om` : ''}${r.flaps ? ` · eerst ${int(r.flaps)} facetten losse flarden naast ${de} weggehaald` : ''}${r.holes ? ` · ${r.holes === 1 ? '1 gat' : `${r.holes} gaten`} onder ${de} gedicht` : ''}`; };
function updatePartsUI() {
  const has = S.parts.length > 0;
  $('partsBox').classList.toggle('hide', !has);
  for (const e of document.querySelectorAll('.part-field, .parts-layer')) e.classList.toggle('hide', !has);
  if (!has) { $('partsList').innerHTML = ''; return; }
  $('partsList').innerHTML = S.parts.map((p, i) => {
    const w = partWord(p), de = partDe(p), name = p.kind === 'steg' ? 'Steg' : `Onderdeel ${i + 1}`;
    return `<div class="part-row"><div class="part-title"><b>${name}</b><span class="sub">${int(p.faces)} facetten · ${p.size.map(v => fmt(v)).join(' × ')} mm</span></div>`
      + `<div class="seg" role="group" aria-label="${name}"><button type="button" data-part="${i}" data-pmode="scan" aria-pressed="${p.mode !== 'apart'}">Over ${de}</button><button type="button" data-part="${i}" data-pmode="apart" aria-pressed="${p.mode === 'apart'}">Zonder ${w}</button></div>`
      + `<a class="download" href="#" data-part-dl="${i}">↓ ${name} als STL</a></div>`;
  }).join('');
  const mode = includedParts().length === S.parts.length ? 'scan' : includedParts().length ? '' : 'apart';
  for (const id of ['lepelPart', 'beetPart', 'basisPart']) { const sel = $(id); sel.value = mode || 'scan'; for (const o of sel.options) o.textContent = o.value === 'scan' ? `Over ${partDe(S.parts[0])} (hoort bij de scan)` : `Zonder ${partWord(S.parts[0])} (alleen op de kaak)`; }
}
function setPartMode(i, mode) {
  const list = i == null ? S.parts.map((_, k) => k) : [i];
  if (!list.some(k => S.parts[k] && S.parts[k].mode !== mode)) return;
  S.history.push({ soup: S.scan, aux: snapshotAux() }); noteAction('scan'); if (S.history.length > 8) S.history.shift(); S.future = [];
  S.parts = S.parts.map((p, k) => list.includes(k) ? { ...p, mode } : p);
  const keep = keepDesign();
  viewer.setParts(S.parts); updatePartsUI(); showWax(); refreshOverlay();
  const w = partWord(S.parts[list[0]]), de = partDe(S.parts[list[0]]);
  status(mode === 'apart' ? `Zonder ${w}: lepel, beetplaat en basis liggen alleen op de kaak. ${de[0].toUpperCase() + de.slice(1)} blijft doorzichtig zichtbaar.` : `Over ${de}: lepel, beetplaat en basis krijgen een kap over ${de}; de ruimte eronder wordt uitgespaard.`);
  restoreDesign(keep);
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-pmode]'); if (b) { setPartMode(+b.dataset.part, b.dataset.pmode); return; }
  const a = e.target.closest('[data-part-dl]'); if (!a) return; e.preventDefault();
  const i = +a.dataset.partDl, p = S.parts[i]; if (!p) return;
  download(writeSTL(p.soup, p.kind === 'steg' ? 'Steg' : 'Onderdeel'), `${p.kind === 'steg' ? 'STEG' : 'ONDERDEEL' + (i + 1)}_${safe(S.scanName.replace(/(_voorbereid)?\.stl$/i, ''))}.stl`);
});
for (const id of ['lepelPart', 'beetPart', 'basisPart']) $(id).addEventListener('change', e => setPartMode(null, e.target.value));
// Alles wat door het pasvlak heen steekt (wortels van tanden, onderkant van wal/gingivaband/handvat) wegsnijden met
// een 'weefselblok' waarvan één zijde exact het scanoppervlak is (iets ruimer dan de omtrek). Zo blijft het pasvlak gelijk aan de scan.
// Weefselblok: wat door het pasvlak steekt (onderkant van beetwal, handvat, gingivaband) wordt weggesneden.
// v68: een blok wordt pas gemaakt als de vorige poging mislukte. v70: dun blok (2,5 mm) via het iso-oppervlak; het oude
// blok (normaal-offset, 8 mm) sneed zichzelf aan de weefselkant van een smalle kam of tussen tanden duizenden keren.
// deep: het oude, diepe blok, voor de prothese (de gingivaband steekt daar nog tot 9 mm onder de scan).
// v73: alleen de makers; samenvoegen + aftrekken + wegsnijden gebeurt in één keer (unionSubtractClip) en elk blok wordt
// hooguit één keer gemaakt (de prothese bouwt bij een terugval van de gingiva opnieuw).
function tissueMakers(kind, reverse, { deep = false } = {}) {
  const s = S.contours.get(kind); if (!s?.closed) return [];
  const src = scanForPlates(), memo = [];
  const makers = (deep ? [[1.5, 8, 'normal'], [1, 4, 'normal'], [0.6, 2.5, 'normal']] : [[1.5, 2.5, 'iso'], [1, 1.5, 'iso'], [0.6, 2.5, 'normal']]).map(([margin, wall, method], i) => async () => {
    if (memo[i]) return memo[i];
    if (i) await tick('Weefselblok opnieuw proberen…');
    const wide = s.edge ? trimByEdge(src, { inset: 0, splitAt: S.designedFrom ?? null }).soup : trimByOutline(src, s.points, s.axis, { margin }).soup;
    return (memo[i] = await shellAsync(wide, { gap: 0.005, wall, reverse: !reverse, method, quick: method === 'iso' }, {}, () => tick()));
  });
  return makers;
}
const clipWarn = () => toast('Let op: delen die door het pasvlak steken konden niet automatisch worden weggesneden. Controleer het pasvlak.', true);
// v69: zelfdoorsnijding van de scan zelf (één keer per scan)
const SCAN_SI = new WeakMap();
function scanSelfIntersections() { if (!S.scan) return 0; let v = SCAN_SI.get(S.scan); if (v === undefined) { v = selfIntersections(weld(S.scan, 1e-6), { maxPairs: 5e6 }).pairs; SCAN_SI.set(S.scan, v); } return v; }
// v69: de kartelige scanrand wordt in het raakvlak gladgestreken (hooguit 0,3 mm); die laatste strook niet meetellen
const rimBandOf = rep => rep?.rimSmoothed > 0.02 ? 0.5 : 0;
function waxNote() { const st = S.wax && S.wax.soup === S.scan ? S.wax.stats() : null; return (st?.points ? ` · was op ${int(st.points)} punten (max ${fmt(st.max, 2)} mm): daar ligt de plaat bewust vrij van de scan` : ''); }
// Pasvlak-controle: afstand scan → plaat t.o.v. de ingestelde ruimte; het aangevulde (ontworpen) deel telt niet mee.
S.fit = {};
function fitCheck(kind, surface, soup, gap, rimSeal = 0, rimBand = 0) {
  const s = S.contours.get(kind); let skip = s?.splitIndex != null && s.splitIndex < surface.length / 9 ? s.splitIndex : null;
  // v72: onder een steg die bij de scan hoort is bewust ruimte uitgespaard: daar niet meten
  const inc = includedParts(); let barTail = '';
  if (inc.length) {
    const zone = partZone(inc.map(p => p.soup), contourAxis(), 0.5), keep = [], n = surface.length / 9; let kept = 0;
    for (let t = 0; t < n; t++) {
      if (skip != null && t === skip) skip = kept;
      const c = [0, 1, 2].map(k => (surface[t * 9 + k] + surface[t * 9 + 3 + k] + surface[t * 9 + 6 + k]) / 3);
      if (zone(c)) continue; keep.push(t); kept++;
    }
    if (keep.length < n) { const sub = new Float32Array(keep.length * 9); keep.forEach((t, i) => sub.set(surface.subarray(t * 9, t * 9 + 9), i * 9)); surface = sub; barTail = ` · ruimte onder ${partDe(inc[0])} niet meegeteld`; }
  }
  const f = fitReport(surface, soup, gap, { skipFrom: skip, rimSeal, rimBand });
  S.fit[kind] = f ? { ...f, gap, designed: skip != null } : null;
  if (!f) return '';
  const tail = (skip != null ? ' · aangevuld deel niet meegeteld' : '') + (rimBand > 0 ? ` · kartelige scanrand gladgestreken (laatste ${fmt(rimBand, 1)} mm niet meegeteld)` : '') + barTail;
  if (!gap) { const ok = f.p99 <= 0.05; return ` · <span class="${ok ? 'ok' : 'err'}">pasvlak ${Math.round(f.within * 1000) / 10}% binnen 0,05 mm van de scan, 99% ≤ ${fmt(f.p99, 3)} mm</span>${tail}`; }
  const ok = f.closeP99 <= 0.05;
  return ` · <span class="${ok ? 'ok' : 'err'}">afdrukruimte ${fmt(gap, 2)} mm: ${Math.round(f.within * 1000) / 10}% binnen 0,05 mm, nergens meer dan ${fmt(f.closeP99, 3)} mm te dicht (99%)</span>${f.bridged > 0.005 ? ` · ${Math.round(f.bridged * 1000) / 10}% overbrugd (smalle plooien)` : ''}${tail}`;
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
  if (soup) { const m = makeMesh(soup, color, { opacity: kind === 'basis' || kind === 'basisTeeth' ? 1 : 0.9, roughness: kind === 'basisTeeth' ? 0.32 : 0.45 }); m.name = kind; viewer.groups.plates.add(m); }
  syncPlateVisibility(); applyLayers(); refreshScanOutside();
}
// Toon per stap alleen het bijbehorende werkstuk; in de latere stappen de prothese.
function syncPlateVisibility() {
  const show = { bewerken: S.sculpt ? ['sculpt'] : null, lepel: ['lepel'], beetplaat: ['beetplaat'], basis: ['basis', 'basisTeeth'], opstelling: [], controle: ['basis', 'lepel', 'beetplaat'], productie: ['basis', 'lepel', 'beetplaat'] }[S.step];
  for (const child of viewer.groups.plates.children) child.visible = show ? show.includes(child.name) : true;
  if (S.step === 'scan' || S.step === 'analyse') { for (const child of viewer.groups.plates.children) child.visible = false; } // scan zelf goed zien bij bewerken
  else if (['controle', 'productie', 'opdracht'].includes(S.step)) { // alleen het werkstuk dat nu gekozen is
    const work = $('work').value, pick = work === 'lepel' ? 'lepel' : work === 'beetplaat' ? 'beetplaat' : 'basis';
    for (const child of viewer.groups.plates.children) child.visible = child.name === pick || (pick === 'basis' && child.name === 'basisTeeth');
  }
  viewer.render();
}
function clearPlates() { S.plates = {}; viewer.clearGroup('plates'); for (const id of ['lepelResult', 'beetResult', 'basisResult']) $(id).innerHTML = ''; }
function plateSummary(soup) {
  const q = quality(weld(soup, 1e-6));
  // v69: alleen platte (nul-oppervlak) driehoekjes van het samenvoegen = gewoon gesloten; dat gaf eerst de verwarrende
  // melding '0 niet-manifold randen'
  const state = q.watertight || (q.open === 0 && q.flipped === 0 && q.nonManifold === 0) ? `gesloten ✓${q.degenerate ? ` (${int(q.degenerate)} plat driehoekje${q.degenerate === 1 ? '' : 's'} van het samenvoegen, onschadelijk)` : ''}`
    : q.open === 0 && q.flipped === 0 ? `gesloten, ${int(q.nonManifold)} niet-manifold rand${q.nonManifold === 1 ? '' : 'en'} (delen raken elkaar; controleer in de slicer)`
    : `⚠ niet volledig gesloten (${int(q.open)} open randen)`;
  const loose = q.components > 1 ? ` · ⚠ ${q.components} losse delen (raakt handvat of wal de plaat niet? verklein de afstand of schakel het onderdeel uit)` : '';
  return { q, text: `${int(q.faces)} facetten · ${state}${loose} · volume ${fmt(Math.abs(q.volume))} mm³` };
}
function plateLink(kind, label) { return `<a class="download" href="#" data-download="${kind}">↓ ${label}</a>`; }
document.addEventListener('click', e => { const a = e.target.closest('[data-download]'); if (!a) return; e.preventDefault(); const p = S.plates[a.dataset.download]; if (p) download(writeSTL(p.soup, p.name), p.file); });
function needFrame(feature) { if (computeFrame() || S.frame) return true; toast(`${feature} overgeslagen: zet eerst de referentiepunten (stap Analyse).`); return false; }

// v68: waarschuwing als de buitenkant in smalle ruimtes (tussen tanden, diepe plooien) te dicht bij de scan komt
const thinNote = rep => rep?.thin > 0.003 ? ` · <span class="err">⚠ op ${fmt(rep.thin * 100, 1)}% van de buitenkant minder dan ⅓ van de dikte tot de scan: in smalle ruimtes (tussen tanden) schiet de buitenkant over de scan heen. Vul die ruimtes eerst met was (Analyse) of kies een kleinere afstand/dikte</span>` : '';
const reducedNote = rep => {
  const sc = S.scan && SIMPLIFIED.get(S.scan);
  return (sc ? ` · scan vereenvoudigd (${int(sc.before)} → ${int(sc.after)} facetten): elk origineel scanpunt binnen ${fmt(sc.maxDeviation, 3)} mm` : '')
    + (rep?.reduced ? ` · oppervlak vereenvoudigd (${int(rep.reduced.before)} → ${int(rep.reduced.after)} facetten, max. ${fmt(rep.reduced.maxDeviation, 3)} mm)` : '');
};
async function buildLepel() {
  ensureWorkableScan();
  const surface = surfaceFor('lepel'), gap = num('lepelGap'), wall = num('lepelWall'), reverse = $('lepelReverse').checked;
  const rep = {};
  await tick(gap > 0 ? `Lepel opbouwen (${fmt(gap, 2)} mm afdrukruimte)…` : 'Lepel opbouwen…');
  const edge = S.contours.get('lepel')?.edge;
  let soup = await shellAsync(surface, { gap, wall, reverse, checkThin: true, trimSpikes: !!edge }, rep, () => tick());
  const shellSoup = soup; // pasvlak meten zonder weefselstops (die raken de scan bewust)
  const extras = [], notes = [];
  if ($('lepelHandle').checked && needFrame('Handvat')) { extras.push(handleGeometry(S.frame, handleParams(), handleOpts('lepel'))); notes.push('handvat'); }
  if ($('lepelStops').checked && gap > 0 && needFrame('Weefselstops')) {
    // v72: geen stop onder of naast een steg die bij de scan hoort (daar is de lepel uitgespaard)
    const inc = includedParts(), zone = inc.length ? partZone(inc.map(p => p.soup), S.frame.N, gap + wall + 1) : null;
    const pts = ['R', 'M', 'L'].map(k => S.landmarks[k]).filter(p => p && !(zone && zone(p)));
    if (pts.length) { extras.push(...tissueStops(pts, S.frame.N, { gap, wall })); notes.push(`${pts.length} weefselstop${pts.length === 1 ? '' : 's'}`); }
  }
  const cutters = $('lepelPerforated').checked && needFrame('Perforaties') ? perforations(S.frame, { form: $('archForm').value }) : [];
  if (cutters.length) notes.push(cutters.length + ' perforaties');
  const pb = await partBlocks('lepel', surface, gap, wall); // v72: over de steg
  if (pb) { extras.push(pb.cap); cutters.push(pb.relief); }
  if (extras.length || cutters.length) {
    await loadManifold();
    soup = await unionSubtract([soup, ...extras], cutters);
  }
  const { text } = plateSummary(soup), fitTxt = fitCheck('lepel', surface, shellSoup, gap, 0, rimBandOf(rep)) + waxNote() + partNote(pb ? wall : null);
  S.plates.lepel = { soup, name: 'Individuele lepel', file: `LEPEL_${safe($('caseName').value)}${partSuffix()}.stl` };
  showPlate('lepel', soup, COLORS.plate.lepel);
  const edgeTxt = edge ? ` · rand langs de scanrand${edge.inset ? ` (${fmt(edge.inset)} mm erbinnen)` : ''}${rep.openedFaces ? ` · ${int(rep.openedFaces)} facetten van dunne punten aan de scanrand weggelaten` : ''}` : '';
  result('lepelResult', `Lepel klaar: ${text}${edgeTxt}${fitTxt}${thinNote(rep)}${reducedNote(rep)}${rep.holesFilled ? ` · ${rep.holesFilled} gaten in de scan gedicht` : ''}${notes.length ? ' · ' + notes.join(', ') : ''}.<br>${plateLink('lepel', 'Lepel-STL')}`);
  status('Lepel gegenereerd.'); updateDone();
}
$('lepelBuild').onclick = () => busy('Lepel berekenen…', buildLepel);
$('biteFit').addEventListener('change', () => { $('biteDraft').disabled = $('biteFit').value !== 'block'; });
async function buildBeet() {
  ensureWorkableScan();
  surfaceFor('beetplaat'); // controle: is er een (gesloten) omtrek?
  const gap = num('beetGap'), wall = num('beetWall'), reverse = $('beetReverse').checked;
  if ($('biteFit').value === 'block' && !(S.wax?.stats().points)) { await tick('Ondersnijdingen opvullen met was…'); waxBlockout(); }
  const draft = null, rep = {};
  await tick('Plaatoppervlak uitsnijden…');
  const surf2 = surfaceFor('beetplaat'); // na eventueel uitblokken: scan + was
  // met afdrukruimte: de ruimte loopt aan de rand naar 0, zodat de plaatrand precies op de scan(rand) ligt
  const seal = gap > 0 && $('beetSeal').checked ? Math.max(0.5, num('beetSealWidth') || 2) : 0;
  await tick(gap > 0 ? `Plaat opbouwen (${fmt(gap, 2)} mm afstand tot de scan)…` : 'Plaat opbouwen…');
  // langs de scanrand: dunne punten die het bijsnijden liet staan niet meenemen (breekbaar, en ze geven overlapjes)
  let soup = await shellAsync(surf2, { gap, wall, reverse, rimSeal: seal, checkThin: true, trimSpikes: !!S.contours.get('beetplaat')?.edge }, rep, () => tick());
  const extras = [], notes = []; let capTxt = '';
  const pb = await partBlocks('beetplaat', surf2, gap, wall); // v72: over de steg (v73: vóór de wal, die moet erboven blijven)
  if ($('rimOn').checked && needFrame('Beetwal')) {
    const rs = $('rimRule').checked ? ruleSetup({ forceCrest: true, extend: 0 }) : null;
    const height = rs?.rule ? t => rs.rule.at(Math.abs(t), 1) : num('rimHeight');
    // v68: volgens de regels ligt het occlusievlak soms ónder de kam (betande scan: de 'kam' zijn de tanden). Zo'n wal
    // zou helemaal in de plaat verdwijnen en de plaat kapotmaken: dan geen wal, met uitleg.
    const crest = rs?.arch?.crest, buried = rs?.rule && crest?.heightAt ? (() => { let low = 0; for (let i = 0; i <= 40; i++) { const t = -1 + i / 20; if (height(t) - crest.heightAt(t) < gap + wall + 1) low++; } return low > 20; })() : false;
    const noFold = rs?.rule?.edge && S.contours.get('beetplaat')?.edge; // plooi niet gescand: de plooiregel heeft geen basis
    if (buried || noFold) notes.push(`<span class="warn">beetwal overgeslagen: ${noFold ? 'de plooi is niet gescand, dus de plooiregel (occlusievlak) is niet te bepalen' : `volgens de plooiregel ligt het occlusievlak hier niet boven de kam (${fmt(rs.rule.front)} / ${fmt(rs.rule.back)} mm; betande scan?)`}. Zet "Volgens de regels" uit en kies een walhoogte als je toch een wal wilt</span>`);
    else {
      if (rs && S.anatomy) S.anatomy.arch = rs.arch;
      const form = $('archForm').value === 'crest' ? 'oval' : $('archForm').value, arch = rs?.arch ?? null, rimW = { width: num('rimWidth'), anteriorWidth: num('rimFrontWidth') };
      const cap = pb ? rimOverCap(height, pb.cap, { ...rimW, form, arch }) : null; // v73: wal blijft boven de kap over de steg
      extras.push(biteRim(S.frame, { ...rimW, height: cap ? cap.height : height, embed: 3, form, arch, conform: conformTo(gap + wall * 0.5) }));
      notes.push(rs?.rule ? `beetwal volgens regels (kamlijn; hoogte voor ${fmt(rs.rule.front + (cap?.lift ?? 0))} / achter ${fmt(rs.rule.back + (cap?.lift ?? 0))} mm boven de kam${rs.rule.notes.length ? '; ' + rs.rule.notes.join('; ') : ''})` : `beetwal ${fmt(num('rimHeight') + (cap?.lift ?? 0))} mm`);
      if (cap) capTxt = ' · ' + cap.text;
    }
  }
  if ($('beetHandle').checked && needFrame('Handvat')) { extras.push(handleGeometry(S.frame, handleParams(), handleOpts('beetplaat'))); notes.push('handvat'); }
  const clip = extras.length > 0; // beetwal of handvat: wat door het pasvlak steekt wegsnijden (de kap raakt het pasvlak niet)
  if (pb) extras.push(pb.cap);
  if (extras.length) {
    await tick(`${notes.some(n => n.startsWith('beetwal')) ? 'Beetwal' : notes.includes('handvat') ? 'Handvat' : 'Kap'} samenvoegen met de plaat…`);
    await loadManifold();
    // v73: samenvoegen, steg uitsparen en wat door het pasvlak steekt wegsnijden in één keer
    const rr = {}, makers = clip && !draft ? tissueMakers('beetplaat', reverse) : [];
    if (makers.length) await tick('Samenvoegen en wat door het pasvlak steekt wegsnijden…');
    soup = await unionSubtractClip([soup, ...extras], pb ? [pb.relief] : [], makers, rr);
    if (makers.length && rr.clip < 0) { console.warn('weefselblok', rr.clipError); clipWarn(); }
  }
  await tick('Pasvlak controleren…');
  const edge = S.contours.get('beetplaat')?.edge;
  const { text } = plateSummary(soup), fitTxt = fitCheck('beetplaat', surf2, soup, gap, seal, rimBandOf(rep)) + waxNote() + partNote(pb ? wall : null);
  S.plates.beetplaat = { soup, name: 'Beetplaat', file: `BEETPLAAT_${safe($('caseName').value)}${partSuffix()}.stl` };
  showPlate('beetplaat', soup, COLORS.plate.beetplaat);
  const edgeTxt = edge ? ` · rand langs de scanrand${edge.inset ? ` (${fmt(edge.inset)} mm erbinnen)` : ' (plaatrand = scanrand)'}${rep.openedFaces ? ` · ${int(rep.openedFaces)} facetten van dunne punten aan de scanrand weggelaten` : ''}` : '';
  const sealTxt = seal ? ` · rand ligt op de scan (afstand loopt in de laatste ${fmt(seal)} mm naar 0)` : '';
  const tip = gap > 0 && S.fit.beetplaat && S.fit.beetplaat.within < 0.5 ? ' · tip: een beetplaat heeft normaal 0 mm afstand tot de scan' : '';
  result('beetResult', `Beetplaat klaar: ${text}${edgeTxt}${sealTxt}${fitTxt}${thinNote(rep)}${tip}${reducedNote(rep)}${draft ? ` · uitblokken ${draft}° (${rep.changed} punten, max ${fmt(rep.maxLift, 2)} mm)` : ''}${capTxt}${notes.length ? ' · ' + notes.join(', ') : ''}.<br>${plateLink('beetplaat', 'Beetplaat-STL')}`);
  status('Beetplaat gegenereerd.'); updateDone();
}
$('beetBuild').onclick = () => busy('Beetplaat berekenen…', buildBeet);
// Rand-keuze gewijzigd: rand opnieuw bepalen en een bestaande beetplaat direct opnieuw maken
for (const [kind, ids] of Object.entries({ beetplaat: ['beetEdge', 'beetEdgeInset'], lepel: ['lepelEdge', 'lepelEdgeInset'] })) for (const id of ids) $(id).addEventListener('change', () => {
  if (!S.scan || !S.contours.get(kind)?.closed) return;
  const had = !!S.plates[kind], label = kind === 'lepel' ? 'Lepel' : 'Beetplaat';
  busy(`Rand ${kind} bepalen…`, async () => { ensureFrame(); autoContour(kind); if (had) { await tick(`${label} opnieuw opbouwen…`); await (kind === 'lepel' ? buildLepel : buildBeet)(); } });
});

// ---------- tandopstelling ----------
const toothMaterial = () => new THREE.MeshStandardMaterial({ color: COLORS.tooth, roughness: 0.32, metalness: 0 });
function clearTeeth() { selectTooth(null); tools?.centric(); tools?.clearOpp(); viewer.clearGroup('teeth'); S.teeth = []; S.teethHistory = []; S.teethFuture = []; S.teethInitial = null; S.grindHistory = []; tools?.resetRows(); renderToothList(); }
function teethSnapshot() { return tools ? tools.snapshot() : S.teeth.map(t => ({ fdi: t.userData.fdi, p: t.position.toArray(), q: t.quaternion.toArray() })); }
function applyTeethSnapshot(snap) { if (tools) return tools.applySnapshot(snap); for (const s of snap) { const t = S.teeth.find(o => o.userData.fdi === s.fdi); if (t) { t.position.fromArray(s.p); t.quaternion.fromArray(s.q); t.updateMatrixWorld(); } } viewer.render(); }
function pushTeethHistory() { S.teethHistory.push(teethSnapshot()); if (S.teethHistory.length > 60) S.teethHistory.shift(); S.teethFuture = []; noteAction('teeth'); invalidateTeethDependents(); }
function invalidateTeethDependents() { if (S.plates.monoblock || S.plates.basis) { delete S.plates.monoblock; delete S.plates.basis; delete S.plates.elementen; showPlate('basis', null); showPlate('basisTeeth', null); $('basisResult').innerHTML = '<span class="err">Opstelling gewijzigd: genereer de prothese opnieuw.</span>'; } }
function syncConceptUI() { $('customConcept').classList.toggle('hide', $('concept').value !== 'custom'); }
$('concept').addEventListener('change', syncConceptUI);
// Boog en occlusievlak volgens de regels (gemeten kamlijn + plooiregel). null zonder scan of bij een standaardboog.
function ensureAnatomy() { if (!S.scan) return null; if (!S.anatomy || S.anatomy.soup !== S.scan) runAnatomy(); return S.anatomy; }
function ruleSetup({ forceCrest = false, extend = 6 } = {}) {
  if (!S.scan || !(forceCrest || $('archForm').value === 'crest')) return null;
  const a = ensureAnatomy(); if (!a) return null;
  const fo = $('frontOffset').value === '' ? null : num('frontOffset');
  const arch = setupArch(a.an, { concept: $('concept').value, front: fo, scale: num('toothScale') / 100, extend });
  return arch ? { arch, rule: occlusalPlaneRule(a.an) } : null;
}
function currentArchFn() {
  const f = S.frame; if (!f) return null;
  if ($('archForm').value === 'crest' && S.anatomy?.soup === S.scan && S.anatomy.arch) return S.anatomy.arch;
  return formArch({ width: f.width, depth: f.depth, form: $('archForm').value === 'crest' ? 'oval' : $('archForm').value });
}
async function buildTeeth() {
  // zonder keuze in de opdrachtbon: 7–7 (14 elementen, geen verstandskiezen), daarna wat niet op de kam past weglaten
  const explicit = S.selectedTeeth.size > 0;
  let ids = explicit ? [...S.selectedTeeth] : (jaw() === 'upper' ? FDI_UPPER : FDI_LOWER).filter(id => id % 10 !== 8);
  let frame = computeFrame();
  // geen referentiepunten: zelf zetten en de kaak analyseren (zoals ⚡ Alles automatisch), niet om punten vragen
  if (!frame && S.scan) { frame = ensureFrame(); if (!S.anatomy || S.anatomy.soup !== S.scan) runAnatomy(); }
  if (!frame) frame = S.frame = defaultFrame(jaw());
  const rs = ruleSetup(), useRule = $('planeMode').value === 'rule' && rs?.rule;
  if (rs && S.anatomy) S.anatomy.arch = rs.arch;
  const lib = await tools.librarySetting(), mode = $('setupMode').value;
  const ideal = lib.librarySet && mode === 'ideal' ? bowIdeal(lib.librarySet, frame.jaw) : null;
  if (mode === 'manual') ids = [];
  // Bibliotheektanden: maat automatisch aan de kam aanpassen (zoals 3Shape): verkleinen in stappen van 3 %
  // (tot 82 %) zolang er een eerste molaar of meer dan de tweede molaren niet op de kam past.
  const baseScale = num('toothScale') / 100, auto = lib.librarySet && $('libAutoSize').checked && !explicit && mode !== 'manual';
  let scale = baseScale, placed, dropped;
  for (let attempt = 0; attempt < 7; attempt++) {
    placed = placeTeeth(ids, frame, {
      form: $('archForm').value === 'crest' ? 'oval' : $('archForm').value, arch: rs?.arch ?? null, scale, shape: $('anteriorShape').value, concept: $('concept').value, library: lib.library, librarySet: lib.librarySet, ideal,
      occlusalHeight: useRule ? rs.rule.at : num('occlHeight'), gap: num('basisGap'), wall: num('basisWall'),
      custom: { spee: num('cSpee'), wilson: num('cWilson'), labial: num('cLabial'), cusp: num('cCusp') },
    }, viewer.scanMesh);
    dropped = [];
    if (!explicit && rs && S.anatomy) {
      const rep = staticsReport(placed.map(t => ({ fdi: t.fdi, x: t.arch2d[0], y: t.arch2d[1] })), S.anatomy.an) || [];
      dropped = rep.filter(r => r.beyond > 2 && r.fdi % 10 >= 6).map(r => r.fdi);
      // nooit een eerste molaar weglaten als er daardoor een gat ontstaat: alleen van achteren af
      dropped = dropped.filter(f => f % 10 === 7 || !placed.some(t => t.fdi === f + 1 && !dropped.includes(t.fdi)));
    }
    if (!auto || !dropped.some(f => f % 10 === 6) || scale <= baseScale * 0.82) break;
    scale *= 0.97;
  }
  placed = placed.filter(t => !dropped.includes(t.fdi));
  S.libScale = auto ? scale / baseScale : 1;
  clearTeeth();
  const curve = rs?.arch ?? formArch({ width: frame.width, depth: frame.depth, form: $('archForm').value === 'crest' ? 'oval' : $('archForm').value });
  S.teethPlan = { ...(S.teethPlan || {}), curve, plane: useRule ? null : num('occlHeight') };
  for (const t of placed) { const mesh = tools.makeToothMesh(t, toothMaterial()); viewer.groups.teeth.add(mesh); S.teeth.push(mesh); }
  // externe bibliotheek: exacte approximale contacten met de echte kronen
  if (lib.librarySet && S.teeth.length) tools.packMain();
  if ($('bothJaws').checked && S.teeth.length) await tools.buildOpp({ silent: true });
  tools.renderLists();
  S.teethInitial = teethSnapshot();
  invalidateTeethDependents();
  renderToothList(); refreshOverlay();
  const planeTxt = useRule ? `occlusievlak volgens plooiregel: voor ${fmt(rs.rule.front)} / achter ${fmt(rs.rule.back)} mm boven de kam${rs.rule.notes.length ? ' (' + rs.rule.notes.join('; ') + ')' : ''}` : `occlusievlak ${fmt(num('occlHeight'))} mm boven de kam${$('planeMode').value === 'rule' ? ' (plooiregel vraagt een scan)' : ''}`;
  $('teethInfo').textContent = `${placed.length} elementen opgesteld${S.libScale < 0.995 ? ` (bibliotheekmaat automatisch ${Math.round(S.libScale * 100)} % zodat de molaren op de kam passen)` : ''}${dropped.length ? ` (${dropped.sort((a, b) => a - b).join(', ')} weggelaten: geen ruimte op de kam, kantelgevaar)` : ''} · ${$('concept').selectedOptions[0].text} · ${rs ? 'boog op de gemeten kamlijn' : `boog ${fmt(frame.width)} × ${fmt(frame.depth)} mm`} · ${planeTxt}.`;
  S.teethPlan = { ...S.teethPlan, rule: useRule ? rs.rule : null, crest: rs?.arch?.crest ?? null };
  if (mode === 'manual') { $('teethInfo').textContent = 'Handmatig opstellen: kies hieronder een element en tik op de kam waar het moet staan. Het volgende element wordt automatisch voorgesteld.'; tools.renderLists(); }
  if (S.liveContacts) tools.refreshContacts();
  status(mode === 'manual' ? 'Handmatig: kies een element en tik op de kam.' : `Tanden opgesteld${lib.librarySet ? ' met ' + lib.librarySet.name + (ideal ? ' (ideale standen uit de bibliotheek)' : '') : ''}${S.opp.length ? ', tegenkaak ook' : ''}. Tik een element om te selecteren, houd vast en sleep om te verplaatsen.`); updateDone();
}
$('teethBuild').onclick = () => busy('Tanden opstellen…', async () => buildTeeth());
function renderToothList() {
  const host = $('toothList'); host.innerHTML = '';
  for (const t of [...S.teeth, ...(S.opp || [])].sort((a, b) => a.userData.fdi - b.userData.fdi)) {
    const b = document.createElement('button'); b.textContent = t.userData.fdi; b.classList.toggle('selected', S.sel ? S.sel.has(t) : S.selected === t);
    b.onclick = () => selectTooth(S.selected === t ? null : t); host.appendChild(b);
  }
  if (!S.teeth.length) host.innerHTML = '<span class="sub">Nog geen opstelling.</span>';
}
function selectTooth(obj) { if (tools) tools.select(obj ? tools.expand(obj) : []); else setPrimary(obj); }
function setPrimary(obj) {
  S.selected = obj;
  if (obj) { viewer.attachGizmo(S.gizmoMode ? obj : null, S.gizmoMode || 'translate'); status(`Element ${obj.userData.fdi} geselecteerd${S.sel?.size > 1 ? ` (+${S.sel.size - 1})` : ''} · kroon ${fmt(obj.userData.dims.md * obj.scale.x)} × ${fmt(obj.userData.dims.bl * obj.scale.z)} × ${fmt(obj.userData.dims.height * obj.scale.y)} mm.`); }
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
viewer.addEventListener('gizmo', e => { if (e.detail.dragging) pushTeethHistory(); else if (S.liveContacts && S.selected) tools.refreshContacts([S.selected]); });
for (const b of document.querySelectorAll('[data-nudge]')) b.onclick = () => {
  const list = S.sel?.size ? [...S.sel] : S.selected ? [S.selected] : []; if (!list.length) return status('Selecteer eerst een element.', true);
  pushTeethHistory();
  for (const t of list) {
    const N = new THREE.Vector3(...S.frame.N).multiplyScalar(t.userData.opp ? -1 : 1), d = { mesial: t.userData.mesial, distal: t.userData.mesial.clone().negate(), buccal: t.userData.buccal, lingual: t.userData.buccal.clone().negate(), up: N, down: N.clone().negate() }[b.dataset.nudge];
    t.position.addScaledVector(d, num('nudgeStep') || 0.25); t.updateMatrixWorld();
  }
  if (S.liveContacts) tools.refreshContacts(); viewer.render();
};
$('teethUndo').onclick = () => { const h = S.teethHistory.pop(); if (!h) return; S.teethFuture.push(teethSnapshot()); applyTeethSnapshot(h); };
$('teethRedo').onclick = () => { const h = S.teethFuture.pop(); if (!h) return; S.teethHistory.push(teethSnapshot()); applyTeethSnapshot(h); };
$('teethReset').onclick = () => { if (!S.teethInitial) return; pushTeethHistory(); applyTeethSnapshot(S.teethInitial); };
$('autoOcclude').onclick = () => autoOccludeClick();
const autoOccludeClick = () => busy('Occlusie zoeken…', async () => {
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
function freshSoup(t) { if (t.userData.soupDirty || !t.userData.soup) { t.userData.soup = geometrySoup(t.geometry); t.userData.soupDirty = false; } return t.userData.soup; }
function teethWorldSoups(list = S.teeth) { tools?.centric(); return list.map(t => { freshSoup(t); t.updateMatrixWorld(); return { fdi: t.userData.fdi, soup: applyMatrixToSoup(t.userData.soup, t.matrixWorld.elements) }; }); }

// ---------- prothesebasis ----------
async function buildBasis() {
  ensureWorkableScan();
  const surface = surfaceFor('basis'), gap = num('basisGap'), wall = num('basisWall'), reverse = $('basisReverse').checked, rep = {};
  await tick('Basis opbouwen…');
  const base = await shellAsync(surface, { gap, wall, reverse, checkThin: true }, rep, () => tick());
  await loadManifold();
  const parts = [base], notes = [];
  const pb = await partBlocks('basis', surface, gap, wall); // v72: over de steg (overkappingsprothese)
  if (pb) parts.push(pb.cap);
  const cut = pb ? [pb.relief] : [];
  let gingivaFallback = null;
  const teeth = teethWorldSoups();
  if ($('gingivaOn').checked && teeth.length && S.frame) {
    const N = S.frame.N, O = S.frame.O;
    const cervical = S.teeth.map(t => vec.dot(vec.sub(t.localToWorld(new THREE.Vector3(0, 0, 0)).toArray(), O), N));
    const top = cervical.reduce((s, v) => s + v, 0) / cervical.length + num('gingivaOver');
    // Festoenen: de gingivarand volgt per element de halslijn en loopt tussen de elementen op tot een papil.
    const gArch = $('archForm').value === 'crest' ? ruleSetup({ extend: 0 })?.arch ?? null : null;
    const archFn = gArch ?? formArch({ width: S.frame.width, depth: S.frame.depth, form: $('archForm').value === 'crest' ? 'oval' : $('archForm').value });
    const T2 = S.teeth.map((t, i) => { const d = vec.sub(t.position.toArray(), O); return { x: vec.dot(d, S.frame.X), y: vec.dot(d, S.frame.Y), c: cervical[i], r: t.userData.dims.md / 2 }; });
    const over = num('gingivaOver');
    const topAt = t => { const [x, y] = archFn(t); let best = Infinity; for (const q of T2) { const d = Math.hypot(x - q.x, y - q.y); best = Math.min(best, q.c + over + 1.8 * (1 - Math.exp(-((d / (q.r * 1.05)) ** 2)))); } return Number.isFinite(best) ? best : top; };
    // wortelreliëf (juga): hoektand het sterkst, dan snijtanden en premolaren; molaren nauwelijks
    const JUGA = { 1: 0.7, 2: 0.55, 3: 1.1, 4: 0.5, 5: 0.45, 6: 0.25, 7: 0.15 }, jf = num('gingivaJuga') / 100;
    const T3 = T2.map((q, i) => ({ ...q, a: (JUGA[S.teeth[i].userData.fdi % 10] ?? 0) * jf }));
    const bulge = jf > 0 ? (t => { const [x, y] = archFn(t); let b = 0; for (const q of T3) { const d = Math.hypot(x - q.x, y - q.y); b = Math.max(b, q.a * Math.exp(-((d / (q.r * 0.62)) ** 2))); } return b; }) : null;
    // booglengte-positie van de distale rand van het laatste element per kant (daarachter loopt de gingiva uit)
    const NS = 400, AP = Array.from({ length: NS + 1 }, (_, i) => archFn(-1 + 2 * i / NS)); let AL = 0; for (let i = 1; i <= NS; i++) AL += Math.hypot(AP[i][0] - AP[i - 1][0], AP[i][1] - AP[i - 1][1]);
    const fadeFrom = [0, 0];
    for (const q of T2) { let bi = 0, bd = Infinity; AP.forEach((p, i) => { const d = Math.hypot(p[0] - q.x, p[1] - q.y); if (d < bd) { bd = d; bi = i; } }); const t = -1 + 2 * bi / NS, dt = 2 * q.r / AL; if (t < 0) fadeFrom[0] = Math.max(fadeFrom[0], -t + dt); else fadeFrom[1] = Math.max(fadeFrom[1], t + dt); }
    const band = opts => gingivaBand(S.frame, { fadeFrom, width: num('gingivaWidth'), top: topAt, form: $('archForm').value === 'crest' ? 'oval' : $('archForm').value, arch: gArch, conform: conformTo(gap + wall * 0.5), samples: 320, ...opts });
    parts.push(band({ embed: 9, flare: 3.5, bulge }));
    // terugval als de anatomische vorm bij een grillige opstelling niet sluit: eenvoudiger profiel, altijd gesloten
    gingivaFallback = { index: parts.length - 1, steps: [() => band({ embed: 3, simple: true })] };
    notes.push(`gingiva met festoenen, papillen${jf > 0 ? ' en wortelreliëf' : ''} (rand ${fmt(over)} mm boven de halslijn)`);
  } else if (!teeth.length) notes.push('zonder tanden (alleen basis)');
  let teethTrimmed = teeth;
  if ($('coupling').value === 'monoblock' || !teeth.length) {
    // Samenvoegen en controleren; sluit het resultaat niet (delen raken elkaar), dan stapsgewijs een eenvoudiger
    // gingivaprofiel (minder flens, zonder wortelreliëf) tot het wel sluit.
    // v70: ook losse delen tellen als 'niet goed' (eerst alleen niet-manifold randen). De gingivaband steekt hier nog diep
    // onder de scan (embed); daarom bij de prothese het diepe weefselblok van v69.
    const makers = tissueMakers('basis', reverse, { deep: true }); // v73: één Manifold-sessie (zie unionSubtractClip)
    const build = async () => { const r = {}; const m = await unionSubtractClip([...parts, ...teeth.map(t => t.soup)], cut, makers, r); if (makers.length && r.clip < 0) console.warn('weefselblok', r.clipError); const q = quality(weld(m, 1e-6)); return { m, ok: !r.loose && q.nonManifold === 0 && q.components === 1 && (r.clip >= 0 || !makers.length), clipped: r.clip >= 0 || !makers.length }; };
    let res = await build(), simpler = 0;
    while (!res.ok && gingivaFallback && simpler < gingivaFallback.steps.length) { parts[gingivaFallback.index] = gingivaFallback.steps[simpler++](); res = await build(); }
    if (simpler) { const gi = notes.findIndex(n => n.startsWith('gingiva')); if (gi >= 0) notes[gi] = `gingiva met festoenen en papillen (eenvoudig profiel: de anatomische vorm sloot niet bij deze opstelling)`; if (!res.ok) notes.push('let op: delen raken elkaar; controleer in de slicer'); }
    if (!res.clipped) clipWarn();
    const mono = res.m;
    S.plates.monoblock = { soup: mono, name: 'Monoblock prothese', file: `MONOBLOCK_${safe($('caseName').value)}${partSuffix()}.stl` };
    delete S.plates.basis;
    // Weergave: basis in gingivakleur, tanden in tandkleur (export blijft één monoblock).
    // weergave: basis (zonder tanden) in gingivakleur, tanden apart in tandkleur — geen samenvallende vlakken
    let display = mono; if (teeth.length) try { display = await unionSubtractClip(parts, cut, makers); } catch { /* alleen weergave */ }
    showPlate('basis', display, COLORS.plate.basis);
    showPlate('basisTeeth', teeth.length ? concatSoups(teeth.map(t => t.soup)) : null, COLORS.tooth);
    const { text } = plateSummary(mono), fitTxt = fitCheck('basis', surface, mono, gap, 0, rimBandOf(rep)) + partNote(pb ? wall : null) + (pb && teeth.length ? wallNote(mono, pb.relief, surface) : '');
    if (pb && teeth.length) { const tc = await teethClearOfParts(teeth, pb.relief); if (tc.cut) teethTrimmed = tc.teeth; } // losse export 'Elementen' past dan ook over de steg
    result('basisResult', `Monoblock klaar: ${text}${fitTxt}${thinNote(rep)}${reducedNote(rep)}${notes.length ? ' · ' + notes.join(', ') : ''}.<br>${plateLink('monoblock', 'Monoblock-STL')}`);
  } else {
    const g = num('socketGap');
    const expanded = S.teeth.map(t => {
      const d = t.userData.dims, s = 1 + 2 * g / Math.min(d.md, d.bl);
      const m = t.matrixWorld.clone().multiply(new THREE.Matrix4().makeScale(s, 1 + g / d.height, s));
      return applyMatrixToSoup(t.userData.soup, m.elements);
    });
    const rs = {}, makers = tissueMakers('basis', reverse, { deep: true });
    const basis = await unionSubtractClip(parts, pb ? [...expanded, pb.relief] : expanded, makers, rs);
    if (makers.length && rs.clip < 0) { console.warn('weefselblok', rs.clipError); clipWarn(); }
    S.plates.basis = { soup: basis, name: 'Prothesebasis met sockets', file: `BASIS_${safe($('caseName').value)}${partSuffix()}.stl` };
    delete S.plates.monoblock;
    showPlate('basis', basis, COLORS.plate.basis);
    showPlate('basisTeeth', concatSoups(teeth.map(t => t.soup)), COLORS.tooth);
    const { text } = plateSummary(basis), fitTxt = fitCheck('basis', surface, basis, gap, 0, rimBandOf(rep)) + partNote(pb ? wall : null);
    // sockets: de basis is boven de steg open (de elementen vullen dat); de losse elementen worden ingekort en per
    // element wordt de dunste plek boven of naast de steg gemeten
    let cutTxt = '';
    if (pb) {
      const tc = await teethClearOfParts(teeth, pb.relief, { measure: true });
      if (tc.cut) {
        teethTrimmed = tc.teeth; const th = tc.thin && Number.isFinite(tc.thin.d) ? tc.thin : null;
        cutTxt = ` · ${tc.cut === 1 ? '1 element' : `${tc.cut} elementen`} ingekort waar ${partDe(S.parts[0])} zit${th ? (th.d < 1 ? ` · <span class="warn">dunste plek ${fmt(th.d, 1)} mm (element ${th.fdi}): te dun, zet het occlusievlak hoger of kies ${S.parts[0].kind === 'steg' ? 'een lagere steg' : 'een lager onderdeel'}</span>` : ` · dunste plek ${fmt(th.d, 1)} mm (element ${th.fdi})`) : ''}`;
      }
    }
    result('basisResult', `Basis met ${teeth.length} sockets klaar: ${text}${fitTxt}${thinNote(rep)}${reducedNote(rep)} · socketspeling ${fmt(g, 2)} mm${cutTxt}${notes.length ? ' · ' + notes.join(', ') : ''}.<br>${plateLink('basis', 'Basis-STL')}`);
  }
  if (teethTrimmed.length) S.plates.elementen = { soup: concatSoups(teethTrimmed.map(t => t.soup)), name: 'Elementen', file: `ELEMENTEN_${safe($('caseName').value)}.stl`, parts: teethTrimmed };
  viewer.groups.teeth.visible = false;
  status('Prothese gegenereerd.'); updateDone();
}
$('basisBuild').onclick = () => busy('Prothese berekenen (booleaanse bewerkingen)…', buildBasis);

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
    if (S.teeth.length && S.scan && S.frame) {
      const a = S.anatomy?.soup === S.scan ? S.anatomy : null;
      const rep = a && staticsReport(S.teeth.map(t => { const d = vec.sub(t.position.toArray(), S.frame.O); return { fdi: t.userData.fdi, x: vec.dot(d, S.frame.X), y: vec.dot(d, S.frame.Y) }; }), a.an);
      if (!rep) add('info', 'Statiek niet gecontroleerd: analyseer eerst de kaak (Analyse → 🧭)');
      else {
        const bad = rep.filter(r => r.level === 'warn');
        add(bad.length ? 'warn' : 'ok', bad.length ? `Statiek: ${bad.map(r => `${r.fdi} ${r.msg}`).join(' · ')}` : `Statiek: zijdelingse elementen boven de kam${S.frame.jaw === 'lower' ? ' (binnen de Pound-lijn)' : ''}, geen elementen voorbij het einde van de kam`);
      }
    }
    add(S.antagonist ? 'ok' : 'info', S.antagonist ? 'Antagonist aanwezig: occlusie controleerbaar' : 'Geen antagonist: occlusie niet te controleren');
    add($('splitReviewed').checked ? 'ok' : 'warn', $('splitReviewed').checked ? 'Scheidingslijn beoordeeld' : 'Scheidingslijn niet beoordeeld');
  }
  for (const [k, p] of Object.entries(S.plates)) if (p.soup) {
    const m = weld(p.soup, 1e-6), q = quality(m), closed = q.open === 0 && q.nonManifold === 0 && q.flipped === 0;
    add(closed ? 'ok' : 'warn', `${p.name}: ${closed ? 'gesloten mesh' : `${q.open} open randen, ${q.nonManifold} niet-manifold`}`);
    // v69: zelfdoorsnijding (de 'scherven' van een slechte offset) — alleen bij platen; de scan zelf telt mee als hij ruist
    if (closed && k !== 'elementen' && m.indices.length / 3 < 1_500_000) {
      const si = selfIntersections(m, { maxPairs: 5e6 });
      if (!si.pairs) add('ok', `${p.name}: geen zelfdoorsnijding`);
      else {
        // het pasvlak is de scan zelf: snijdt de scan zichzelf al (ruis, dubbel gescande stukken), dan erft de plaat dat
        const own = scanSelfIntersections(), extra = Math.max(0, si.pairs - own), tiny = extra <= Math.max(50, m.indices.length / 3 * 0.0005);
        add(tiny ? 'ok' : 'warn', `${p.name}: ${int(si.pairs)} elkaar snijdende driehoekparen${si.truncated ? ' (of meer)' : ''}${own ? `, waarvan ${int(Math.min(own, si.pairs))} al in de scan zelf (ruis of dubbel gescand)` : ''}${!extra ? ' — de plaat zelf is schoon' : tiny ? ` — de plaat zelf: ${int(extra)} heel kleine overlapjes (rand of tussen tanden), onschadelijk voor het printen` : ' — controleer in de slicer'}`);
      }
    }
  }
  for (const [k, f] of Object.entries(S.fit)) if (f && (S.plates[k] || (k === 'basis' && (S.plates.monoblock || S.plates.basis)))) add((f.gap ? f.closeP99 : f.p99) <= 0.05 ? 'ok' : 'warn', f.gap ? `Afdrukruimte ${k}: ${fmt(f.gap, 2)} mm, 99% nergens meer dan ${fmt(f.closeP99, 3)} mm te dicht bij de scan (doel ≤ 0,05 mm)${f.bridged > 0.005 ? `, ${Math.round(f.bridged * 1000) / 10}% overbrugd` : ''}` : `Pasvlak ${k}: 99% ≤ ${fmt(f.p99, 3)} mm van de scan (doel ≤ 0,05 mm), mediaan ${fmt(f.median, 3)} mm${f.designed ? ' · aangevuld deel apart' : ''}`);
  if (S.designedFrom != null) add('warn', `Aangevuld (niet gescand) gebied in de scan (paars): ${int(S.scan.length / 9 - S.designedFrom)} facetten. Controleer de rand daar klinisch.`);
  add('info', 'Geen klinische validatie: controleer alle bestanden in slicer/CAM en klinisch');
  $('checks').innerHTML = items.map(([c, t]) => `<li class="${c}">${t}</li>`).join('');
  S.checksOk = !items.some(([c]) => c === 'warn'); updateDone();
}
$('runChecks').onclick = runChecks;

// ---------- productie ----------
function outputList() {
  const P = S.plates, list = [], w = isDenture() ? 'prothese' : $('work').value;
  const forWork = { lepel: ['lepel', 'scan', 'steg'], beetplaat: ['beetplaat', 'scan', 'steg'], prothese: ['monoblock', 'basis', 'elementen', 'losse', 'tegenkaak', 'scan', 'steg', 'antagonist'] }[w];
  const add = (key, label, available, files) => { if (forWork.includes(key) && (available || !['monoblock', 'basis'].includes(key) || !(P.monoblock || P.basis))) list.push({ key, label, available, files }); };
  add('lepel', 'Lepel.stl', !!P.lepel, () => [[`Lepel.stl`, P.lepel.soup]]);
  add('beetplaat', 'Beetplaat.stl', !!P.beetplaat, () => [[`Beetplaat.stl`, P.beetplaat.soup]]);
  add('monoblock', 'Monoblock.stl (basis + tanden)', !!P.monoblock, () => [[`Monoblock.stl`, P.monoblock.soup]]);
  add('basis', 'Basis.stl (met sockets)', !!P.basis, () => [[`Basis.stl`, P.basis.soup]]);
  add('elementen', 'Elementen.stl (alle tanden)', !!P.elementen, () => [[`Elementen.stl`, P.elementen.soup]]);
  add('losse', 'Losse elementen per FDI', !!P.elementen, () => P.elementen.parts.map(p => [`elementen/element_${p.fdi}.stl`, p.soup]));
  add('tegenkaak', 'Elementen tegenkaak.stl (opstelling ' + (S.frame?.jaw === 'lower' ? 'BK' : 'OK') + ')', !!S.opp?.length, () => [[`Elementen_tegenkaak.stl`, concatSoups(teethWorldSoups(S.opp).map(t => t.soup))]]);
  add('scan', 'Scan (referentie).stl', !!S.scan, () => [[`Scan_referentie.stl`, S.scan]]);
  if (S.parts.length) add('steg', `${S.parts[0].kind === 'steg' ? 'Steg' : 'Onderdelen'} (referentie).stl`, true, () => S.parts.map((p, i) => [p.kind === 'steg' && S.parts.length === 1 ? 'Steg_referentie.stl' : `Onderdeel_${i + 1}_referentie.stl`, p.soup])); // v72
  add('antagonist', 'Antagonist (referentie).stl', !!S.antagonist, () => [[`Antagonist_referentie.stl`, S.antagonist]]);
  return list;
}
function renderOutputs() {
  const host = $('outputs'), prev = new Set([...host.querySelectorAll('input:checked')].map(i => i.value));
  host.innerHTML = '';
  for (const o of outputList()) {
    const l = document.createElement('label'); l.className = 'check' + (o.available ? '' : ' unavailable');
    l.innerHTML = `<input type="checkbox" value="${o.key}" ${o.available ? '' : 'disabled'} ${o.available && (prev.has(o.key) || !prev.size) && !['scan', 'steg', 'antagonist'].includes(o.key) ? 'checked' : ''}> <span class="grow">${o.label}${o.available ? '' : ' — nog niet gegenereerd'}</span>`
      + (o.available ? `<button type="button" class="mini" data-preview="${o.key}" title="Bekijk dit bestand los in 3D">👁</button><button type="button" class="mini" data-single="${o.key}" title="Alleen dit bestand downloaden">↓</button>` : '');
    host.appendChild(l);
  }
}
// Eén uitvoerbestand los bekijken (de rest verbergen) of los downloaden.
let previewing = null;
function stopPreview() {
  if (!previewing) return;
  viewer.groups.overlay.remove(previewing.mesh); previewing.mesh.geometry.dispose(); previewing.mesh.material.dispose();
  for (const [g, v] of previewing.vis) g.visible = v;
  previewing = null; $('previewInfo').innerHTML = ''; for (const b of document.querySelectorAll('[data-preview]')) b.setAttribute('aria-pressed', 'false'); viewer.render();
}
$('outputs').addEventListener('click', e => {
  const pv = e.target.closest('[data-preview]'), sg = e.target.closest('[data-single]');
  if (!pv && !sg) return;
  e.preventDefault();
  const o = outputList().find(x => x.key === (pv || sg).dataset.preview || x.key === (pv || sg).dataset.single); if (!o) return;
  const files = o.files();
  if (sg) { downloadOutput(o); return; }
  stopPreview(); openPreview(o.key); return; // v72: eigen 3D-voorbeeldvenster (het bestand zelf)
  const same = previewing?.key === o.key; stopPreview(); if (same) return;
  const soup = concatSoups(files.map(f => f[1])), color = COLORS.plate[o.key] ?? (o.key.startsWith('elem') || o.key === 'losse' ? COLORS.tooth : COLORS.plate.basis);
  const vis = [viewer.groups.scan, viewer.groups.antagonist, viewer.groups.plates, viewer.groups.teeth].map(g => [g, g.visible]);
  for (const [g] of vis) g.visible = false;
  const mesh = makeMesh(soup, color, { roughness: 0.4 }); viewer.groups.overlay.add(mesh);
  previewing = { key: o.key, mesh, vis }; pv.setAttribute('aria-pressed', 'true');
  const b = soupBounds(soup), q = plateSummary(soup);
  $('previewInfo').innerHTML = `<b>${o.label}</b><br>${b.size.map(v => fmt(v)).join(' × ')} mm · ${q.text}<br><span class="sub">Tik nogmaals op 👁 om terug te gaan.</span>`;
  viewer.fit(new THREE.Box3().setFromObject(mesh)); viewer.render();
});
function downloadOutput(o) {
  const files = o.files();
  if (files.length === 1) download(writeSTL(files[0][1], files[0][0]), files[0][0].replace(/^.*\//, ''));
  else download(makeZip(files.map(([n, soup]) => ({ name: n, data: writeSTL(soup, n) }))), `${o.key}.zip`);
}
// v72: 3D-voorbeeld van het STL-bestand (aan het eind van het werk, of per bestand met 👁)
function openPreview(key = null) {
  const outs = outputList().filter(o => o.available);
  if (!outs.length) return status('Genereer eerst een lepel, beetplaat of prothesebasis.', true);
  const chosen = [...$('outputs').querySelectorAll('input:checked')].map(i => i.value);
  const start = key ?? outs.find(o => chosen.includes(o.key) && !['scan', 'steg', 'antagonist'].includes(o.key))?.key ?? outs[0].key;
  const inc = includedParts(); // v72: een steg die bij de scan hoort ook tonen
  openStlPreview(outs, start, {
    scan: S.scan && inc.length ? concatSoups([S.scan, ...inc.map(p => p.soup)]) : S.scan, axis: S.frame?.N ?? S.axis ?? null, fmt, int,
    onDownload: k => { const o = outs.find(x => x.key === k); if (o) downloadOutput(o); },
    onShare: k => shareOutputs(outs.filter(x => x.key === k)),
  });
}
$('pvOpen').onclick = () => openPreview();
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
  if ($('includeProject').checked) { files.push({ name: dir + 'rapport.txt', data: report.map(l => tr(l)).join('\n') }); files.push({ name: dir + 'project.ddcad.json', data: JSON.stringify(projectData(false)) }); }
  download(makeZip(files), `${safe($('caseName').value)}_productie.zip`);
  S.exported = true; updateDone();
  result('exportResult', `${files.length} bestanden in ZIP gezet.`);
});

// 📤 Mailen of in Bestanden bewaren: losse STL's via het deelmenu van het toestel (iPhone: Mail, "Bewaar in
// Bestanden", AirDrop). Bestanden worden direct in de klik gemaakt, want het deelmenu mag alleen vanuit een tik openen.
$('shareFiles').onclick = () => {
  const chosen = new Set([...$('outputs').querySelectorAll('input:checked')].map(i => i.value));
  return shareOutputs(outputList().filter(o => o.available && chosen.has(o.key)));
};
async function shareOutputs(outs) {
  let files;
  try {
    if (!outs.length) throw Error('Kies minstens één beschikbaar bestand.');
    files = [];
    for (const o of outs) for (const [name, soup] of o.files()) files.push(new File([writeSTL(soup, name)], name.replace(/^.*\//, ''), { type: 'model/stl' }));
  } catch (err) { return status(err.message, true); }
  const project = $('caseName').value || 'project', title = `${project} · ${files.length} STL-bestand${files.length > 1 ? 'en' : ''}`;
  const text = `Digital Denture CAD ${VERSION} · ${project} · ${jaw() === 'upper' ? 'bovenkaak' : 'onderkaak'}\n${files.map(f => `• ${f.name} (${fmt(f.size / 1048576, 1)} MB)`).join('\n')}`;
  const tryShare = async list => { if (!navigator.share || !navigator.canShare?.({ files: list })) return false; await navigator.share({ files: list, title, text }); return true; };
  try {
    let ok = await tryShare(files);
    if (!ok) ok = await tryShare(files.map(f => new File([f], f.name, { type: 'application/octet-stream' })));
    if (ok) { S.exported = true; updateDone(); result('exportResult', `${files.length} bestanden gedeeld. Kies in het menu <b>Mail</b> om ze te mailen of <b>Bewaar in Bestanden</b> om een map te kiezen.`); return; }
  } catch (err) { if (err?.name === 'AbortError') return; status(`Delen lukte niet (${err?.message ?? err}); de bestanden worden gedownload.`, true); }
  // geen deelmenu (bijv. computer of in een ingesloten weergave): losse downloads
  for (const f of files) download(f, f.name);
  S.exported = true; updateDone();
  result('exportResult', `${files.length} STL-bestanden gedownload naar ${WHERE}.`);
};

// ---------- project opslaan / openen ----------
function projectData(includeScan = true) {
  return {
    format: 'ddcad-project', version: VERSION, saved: new Date().toISOString(), settings: settings(), selectedTeeth: [...S.selectedTeeth],
    landmarks: S.landmarks, axis: S.axis, marks: S.marks, contours: S.contours.toJSON(), teeth: S.teeth.length ? teethSnapshot() : null, oppTeeth: S.opp?.length > 0, step: S.step,
    ground: [...S.teeth, ...(S.opp || [])].filter(t => t.userData.ground).map(t => ({ fdi: t.userData.fdi, opp: !!t.userData.opp, pos: toBase64(new Uint8Array(t.geometry.getAttribute('position').array.buffer.slice(0))) })),
    scanName: S.scanName, scan: includeScan && S.scan ? toBase64(writeSTL(S.scan)) : null,
    antagonistName: S.antagonistName, antagonist: includeScan && S.antagonist ? toBase64(writeSTL(S.antagonist)) : null,
    parts: includeScan ? S.parts.map(p => ({ kind: p.kind, mode: p.mode, faces: p.faces, volume: p.volume, size: p.size, stl: toBase64(writeSTL(p.soup)) })) : [], // v72
  };
}
$('saveProject').onclick = () => busy('Project opslaan…', async () => { download(JSON.stringify(projectData(true)), `${safe($('caseName').value)}.ddcad.json`, 'application/json'); status('Project opgeslagen, inclusief scan.'); });
$('openProject').addEventListener('change', e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) busy('Project openen…', async () => {
  const d = JSON.parse(await f.text());
  if (d.format !== 'ddcad-project' && d.format !== 'denture-cad-project-v1') throw Error('Onbekend projectbestand.');
  applySettings(d.settings); S.selectedTeeth = new Set((d.selectedTeeth || d.settings?.elementen || []).map(Number)); updateTeethMap();
  if (d.scan) setScan(parseSTL(fromBase64(d.scan)), d.scanName, { parts: (d.parts || []).map(p => ({ ...p, stl: undefined, soup: parseSTL(fromBase64(p.stl)), id: ++PART_SEQ })) });
  if (d.antagonist) setAntagonist(parseSTL(fromBase64(d.antagonist)), d.antagonistName);
  S.landmarks = d.landmarks || {}; S.axis = d.axis || null; S.marks = d.marks || [];
  S.contours.reset(); for (const c of d.contours || []) { const s = S.contours.ensure(c.kind); s.points = c.points; s.closed = !!c.closed && !!c.axis; s.axis = c.axis ?? null; s.edge = c.edge ?? null; }
  computeFrame(); updateLandmarkInfo(); updateAxisInfo(); updateMarkInfo();
  if (d.teeth && (S.frame || !S.scan)) {
    const both = $('bothJaws').checked; $('bothJaws').checked = !!d.oppTeeth || d.teeth.some(t => t.opp);
    const mode = $('setupMode').value; if (mode === 'manual') $('setupMode').value = 'ideal';
    try { await buildTeeth(); } finally { $('bothJaws').checked = both; $('setupMode').value = mode; }
    // elementen die bij het opslaan niet bestonden weg, ontbrekende blijven (opnieuw plaatsen)
    applyTeethSnapshot(d.teeth);
    for (const g of d.ground || []) { const t = (g.opp ? S.opp : S.teeth).find(o => o.userData.fdi === g.fdi); if (t) { const a = new Float32Array(fromBase64(g.pos)); const pa = t.geometry.getAttribute('position'); if (a.length === pa.array.length) { pa.array.set(a); const { finishGeometry } = await import('./grind.js'); finishGeometry(t); t.userData.ground = true; } } }
  }
  showStep(STEPS.some(s => s[0] === d.step) ? d.step : 'opdracht');
  status(d.scan ? 'Project geopend. Omtrekken zijn heropend: sluit ze opnieuw voordat je werkstukken genereert.' : 'Instellingen geladen. Open de STL-scan opnieuw.');
}); });

// ---------- navigatie en sneltoetsen ----------
function stepBy(d) { const v = workSteps(), i = Math.max(0, v.indexOf(S.step)); showStep(v[Math.max(0, Math.min(v.length - 1, i + d))]); }
$('prevStep').onclick = () => stepBy(-1);
$('nextStep').onclick = () => stepBy(1);
// Ongedaan maken / opnieuw voor de stap waarin je bent (bovenbalk, Ctrl+Z / Ctrl+Y)
// v72: ↶ werkt altijd: het draait de laatste handeling terug, in welke stap die ook gebeurde (scan bewerken, scan
// aanpassen, was, markeringen, omtrek, handvat, tanden, inslijpen, vrij bewerken). ↷ doet het weer. Elke handeling komt
// in één logboek; de eigen ↶/↷-knoppen van de panelen houden dat logboek ook bij.
const UNDO_NAME = { scan: 'scanbewerking', mark: 'markering', wax: 'was', contour: 'omtrek', handle: 'handvat', teeth: 'tandopstelling', grind: 'inslijpen', sculpt: 'vrij bewerken' };
const UNDO_STEP = { scan: 'scan', mark: 'analyse', wax: 'analyse', handle: null, teeth: 'opstelling', grind: 'opstelling', sculpt: 'bewerken' };
const STEP_SRC = { scan: ['scan'], analyse: ['scan', 'wax', 'mark'], opstelling: ['teeth', 'grind'], bewerken: ['sculpt'], lepel: ['contour', 'handle'], beetplaat: ['contour', 'handle'], basis: ['contour'] };
const UNDO_MAP = STEP_SRC; // (oude naam)
const UNDO_BOOK = { done: [], undone: [] };
{ const snap = ContourSet.prototype.snap; ContourSet.prototype.snap = function (k) { snap.call(this, k); noteAction('contour', k); }; }
function noteAction(src, kind = null) {
  UNDO_BOOK.done.push({ src, kind }); if (UNDO_BOOK.done.length > 400) UNDO_BOOK.done.shift();
  UNDO_BOOK.undone = UNDO_BOOK.undone.filter(x => !(x.src === src && x.kind === kind));
  syncUndoButtons();
}
// per bron: kan het (terug/opnieuw) en hoe
const UNDO_OPS = {
  scan: { can: r => (r ? S.future : S.history).length > 0, run: r => $(r ? 'meshRedo' : 'meshUndo').click() },
  mark: { can: r => (r ? S.marksRedo : S.marks).length > 0, run: r => $(r ? 'markRedo' : 'markUndo').click() },
  wax: { can: r => !!S.wax && (r ? S.wax.future : S.wax.history).length > 0, run: r => $(r ? 'waxRedo' : 'waxUndo').click() },
  contour: { can: (r, k) => !!k && (r ? S.contours.canRedo(k) : S.contours.canUndo(k)), run: (r, k) => { if (r) S.contours.redoStep(k); else S.contours.undo(k); updateContourUI(); refreshScanColors(); refreshOverlay(); status(`Omtrek ${k === 'basis' ? 'prothesebasis' : k} ${r ? 'hersteld' : 'teruggezet'}.`); } },
  handle: { can: r => !!handleTools && (r ? handleTools.canRedo() : handleTools.canUndo()), run: r => (r ? handleTools.redo() : handleTools.undo()) },
  teeth: { can: r => (r ? S.teethFuture : S.teethHistory)?.length > 0, run: r => { $(r ? 'teethRedo' : 'teethUndo').click(); status(r ? 'Tandopstelling hersteld.' : 'Tandopstelling teruggezet.'); } },
  grind: { can: r => !r && S.grindHistory?.length > 0, run: () => $('grindUndo').click() },
  sculpt: { can: r => !!S.sculpt && (r ? S.sculpt.sc.canRedo : S.sculpt.sc.canUndo), run: r => $(r ? 'sculptRedo' : 'sculptUndo').click() },
};
const canDo = (e, redo) => !!UNDO_OPS[e.src]?.can(redo, e.kind);
function undoAny(redo = false) {
  const from = redo ? UNDO_BOOK.undone : UNDO_BOOK.done, to = redo ? UNDO_BOOK.done : UNDO_BOOK.undone;
  let i = from.length - 1; while (i >= 0 && !canDo(from[i], redo)) i--;
  let e = i >= 0 ? from.splice(i, 1)[0] : null;
  if (!e) { // niets in het logboek (bijv. na het openen van een project): de bronnen van deze stap
    const src = (STEP_SRC[S.step] ?? Object.keys(UNDO_OPS)).find(x => canDo({ src: x, kind: x === 'contour' ? S.step : null }, redo));
    if (!src) { status(redo ? 'Er is niets om opnieuw te doen.' : 'Er is niets om terug te zetten.'); syncUndoButtons(); return; }
    e = { src, kind: src === 'contour' ? S.step : null };
  }
  undoing = true;
  try { UNDO_OPS[e.src].run(redo, e.kind); } finally { undoing = false; }
  to.push(e);
  const where = e.src === 'contour' || e.src === 'handle' ? (e.kind ?? S.step) : UNDO_STEP[e.src];
  if (where && where !== S.step) toast(`${redo ? '↷' : '↶'} ${UNDO_NAME[e.src]} (stap ${STEPS.find(x => x[0] === where)?.[1] ?? where}) ${redo ? 'opnieuw gedaan' : 'teruggedraaid'}.`);
  syncUndoButtons();
}
let undoing = false;
function stepUndo(redo = false) { undoAny(redo); }
function syncUndoButtons() {
  if (!$('vUndo')) return;
  try { UNDO_BOOK; } catch { return; } // nog niet klaar met opstarten
  const any = list => list.some(e => canDo(e, list === UNDO_BOOK.undone));
  const u = any(UNDO_BOOK.done) || (STEP_SRC[S.step] ?? []).some(x => canDo({ src: x, kind: x === 'contour' ? S.step : null }, false));
  const r = any(UNDO_BOOK.undone);
  for (const id of ['vUndo', 'hdrUndo']) $(id).disabled = !u;
  for (const id of ['vRedo', 'hdrRedo']) $(id).disabled = !r;
  $('vUndoBar').classList.toggle('hide', !S.scan);
}
// de eigen ↶/↷-knoppen van een paneel houden het logboek ook bij (niet als ↶ in de kop ze zelf aanroept)
for (const [src, u, r] of [['scan', 'meshUndo', 'meshRedo'], ['mark', 'markUndo', 'markRedo'], ['wax', 'waxUndo', 'waxRedo'], ['teeth', 'teethUndo', 'teethRedo'], ['grind', 'grindUndo', null], ['sculpt', 'sculptUndo', 'sculptRedo']]) {
  const move = (from, to) => { if (undoing) return; for (let i = from.length - 1; i >= 0; i--) if (from[i].src === src) { to.push(from.splice(i, 1)[0]); break; } setTimeout(syncUndoButtons, 0); };
  $(u)?.addEventListener('click', () => move(UNDO_BOOK.done, UNDO_BOOK.undone), true);
  if (r) $(r)?.addEventListener('click', () => move(UNDO_BOOK.undone, UNDO_BOOK.done), true);
}
for (const [u, r] of [['contourUndo', 'contourRedo']]) {
  $(u).addEventListener('click', () => { if (undoing) return; const k = S.step; for (let i = UNDO_BOOK.done.length - 1; i >= 0; i--) if (UNDO_BOOK.done[i].src === 'contour' && UNDO_BOOK.done[i].kind === k) { UNDO_BOOK.undone.push(UNDO_BOOK.done.splice(i, 1)[0]); break; } setTimeout(syncUndoButtons, 0); }, true);
  $(r).addEventListener('click', () => { if (undoing) return; const k = S.step; for (let i = UNDO_BOOK.undone.length - 1; i >= 0; i--) if (UNDO_BOOK.undone[i].src === 'contour' && UNDO_BOOK.undone[i].kind === k) { UNDO_BOOK.done.push(UNDO_BOOK.undone.splice(i, 1)[0]); break; } setTimeout(syncUndoButtons, 0); }, true);
}
$('vUndo').onclick = () => undoAny(false);
$('vRedo').onclick = () => undoAny(true);
$('scanEditUndo').onclick = () => $('meshUndo').click();
$('scanEditRedo').onclick = () => $('meshRedo').click();
$('hdrPrev').onclick = () => stepBy(-1);
$('hdrNext').onclick = () => stepBy(1);
$('hdrUndo').onclick = () => undoAny(false);
$('hdrRedo').onclick = () => undoAny(true);
function syncHeaderNav() {
  const v = workSteps(), i = v.indexOf(S.step);
  $('hdrPrev').disabled = i <= 0; $('hdrNext').disabled = i < 0 || i >= v.length - 1;
  const name = id => STEPS.find(s => s[0] === id)?.[1] ?? '';
  $('hdrPrev').title = i > 0 ? `Vorige stap: ${name(v[i - 1])}` : 'Eerste stap'; $('hdrNext').title = i >= 0 && i < v.length - 1 ? `Volgende stap: ${name(v[i + 1])}` : 'Laatste stap';
  $('hdrStep').replaceChildren(...(i >= 0 ? [document.createTextNode(`${i + 1}/${v.length} `)] : []), document.createTextNode(name(S.step))); // v71: naam als eigen tekst (vertaalbaar)
  syncUndoButtons();
}
function syncWorkSteps() {
  const v = workSteps();
  // alle stappen blijven zichtbaar (Lepel, Beetplaat én Opstelling/Basis), zodat je direct een ander werkstuk kunt kiezen;
  // stappen van een ander werkstuk zijn gedimd en kiezen bij aantikken dat werkstuk
  for (const b of document.querySelectorAll('[data-step]')) { const li = b.closest('li') ?? b; li.classList.remove('hide'); b.classList.toggle('otherwork', !v.includes(b.dataset.step)); }
  STEPS.forEach(([id], i) => { for (const b of document.querySelectorAll(`[data-step="${id}"] .dot`)) b.textContent = i + 1; });
  if (typeof syncHeaderNav === 'function' && $('hdrPrev')) syncHeaderNav();
  if (!isDenture()) { viewer.groups.teeth.visible = false; }
  if (S.step && !v.includes(S.step)) showStep(v.find(x => ['lepel', 'beetplaat', 'opstelling'].includes(x)) ?? 'opdracht');
}
$('work').addEventListener('change', () => { syncWorkSteps(); viewer.render(); });
document.addEventListener('keydown', e => {
  const t = e.target;
  if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (mod && k === 's') { e.preventDefault(); $('saveProject').click(); return; }
  if (mod && (k === 'z' || k === 'y')) {
    e.preventDefault();
    const redo = k === 'y' || e.shiftKey;
    stepUndo(redo);
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



// ---------- anatomie & weefsel ----------
const ZONE_COLORS = [[0.27, 0.75, 0.45], [0.62, 0.85, 0.55], [0.93, 0.33, 0.38], [0.33, 0.5, 0.95], [0.97, 0.75, 0.3]];
const LAB_REF = { upper: { width: 42, depth: 27 }, lower: { width: 50, depth: 34 } }; // mediaan uit 39 labproducten (3Shape-export)
function scanCaster() {
  const mesh = viewer.scanMesh; if (!mesh) throw Error('Laad eerst een scan.');
  const ray = new THREE.Raycaster(); ray.firstHitOnly = true;
  const o = new THREE.Vector3(), d = new THREE.Vector3();
  return (origin, dir) => { ray.set(o.set(...origin), d.set(...dir)); const h = ray.intersectObject(mesh, false)[0]; return h ? { point: h.point.toArray() } : null; };
}
function ensureFrame() {
  if (S.frame || computeFrame()) return S.frame;
  const info = { ...occlusalAxisCached() }; if (S.axis) info.axis = S.axis;
  const lm = autoLandmarks(S.scan, info);
  S.landmarks = { R: lm.R, M: lm.M, L: lm.L }; S.axis ??= info.axis; S.frame = null;
  computeFrame(false); updateLandmarkInfo(); updateAxisInfo(); refreshOverlay(); updateDone();
  if (!S.frame) throw Error('Referentiepunten konden niet automatisch gezet worden. Zet ze bij Analyse.');
  return S.frame;
}
function runAnatomy() {
  if (!S.scan) throw Error('Laad eerst een scan.');
  ensureFrame();
  // twee rondes: eerst langs de standaardboog, daarna langs de gemeten kamlijn (nauwkeuriger bij scheve kaken)
  const cast = scanCaster(), an1 = analyseArch(cast, S.frame, { form: $('archForm').value }), crest = crestArch(an1);
  const an = crest ? analyseArch(cast, S.frame, { arch: crest }) : an1;
  const zi = tissueZones(S.scan, an);
  S.anatomy = { soup: S.scan, an, zones: zi.zones, info: zi, cast, arch: crest };
  const counts = new Map(); for (const z of zi.zones) counts.set(z, (counts.get(z) || 0) + 1);
  const total = zi.zones.length, pct = z => Math.round((counts.get(z) || 0) / total * 100);
  const ref = LAB_REF[S.frame.jaw], st = an.stats;
  const fr = an.frena.map(f => f.side === 'lingual' ? 'linguaal' : Math.abs(f.t) < 0.2 ? 'labiaal' : 'buccaal ' + (f.t < 0 ? 'rechts' : 'links'));
  $('anaInfo').innerHTML = `<b>${S.frame.jaw === 'upper' ? 'Bovenkaak' : 'Onderkaak'}</b> · boog ${fmt(S.frame.width)} × ${fmt(S.frame.depth)} mm (lab-mediaan ${ref.width} × ${ref.depth})<br>`
    + (st.sulcusDepthMedian != null ? `Plooidiepte mediaan ${fmt(st.sulcusDepthMedian)} mm${st.edge > st.profiles * 0.5 ? ' · <span class="err">vestibulum grotendeels niet gescand (scan eindigt bij de plaatrand)</span>' : ''}<br>` : '')
    + `Frenula: ${fr.length ? fr.join(', ') : 'geen duidelijk gevonden'}${zi.torus ? ` · <b>torus palatinus</b> (${fmt(zi.torus.height)} mm)` : ''}<br>`
    + `Drukdragend ${pct(1) + pct(2)}% · ontlasten ${pct(3)}% · afsluiting ${pct(4)}% · plooi/rand ${pct(5)}%`;
  $('anaLegend').classList.remove('hide'); $('anaIdealBox').classList.remove('hide');
  $('anaPostDam').disabled = S.frame.jaw !== 'upper';
  refreshScanColors();
  return S.anatomy;
}
$('anaRun').onclick = () => busy('Kaak analyseren…', async () => { runAnatomy(); status('Anatomie geanalyseerd. Gebruik bij Lepel/Beetplaat "🧭 Automatisch" voor de omtrek.'); });
$('anaShow').addEventListener('change', refreshScanColors);
$('anaIdeal').onclick = () => busy('Scan aanpassen…', async () => {
  if (!S.anatomy || S.anatomy.soup !== S.scan) runAnatomy();
  const { soup, report } = idealizeScan(S.scan, S.anatomy.info, {
    frame: S.frame, doSmooth: $('anaSmooth').checked, doRelief: $('anaRelief').checked, doPostDam: $('anaPostDam').checked && S.frame.jaw === 'upper',
    reliefPapilla: num('anaReliefPap'), relief: num('anaReliefOther'), postDam: num('anaPostDamMm'),
  });
  S.history.push({ soup: S.scan, aux: snapshotAux() }); noteAction('scan'); if (S.history.length > 8) S.history.shift(); S.future = [];
  const keep = keepDesign();
  setScan(soup, S.scanName.replace(/(_ideaal)?\.stl$/i, '') + '_ideaal.stl', { reset: false });
  runAnatomy();
  restoreDesign(keep);
  status(`Scan aangepast: ${report.smoothed ? 'gladgemaakt, ' : ''}${int(report.relieved)} punten ontlast${report.postDam ? `, post-dam op ${int(report.postDam)} punten` : ''}. Genereer de werkstukken opnieuw.`);
});
// Houdt de scan op bij of net voorbij de kam, met de plooi grotendeels niet gescand (intraorale scan, 3Shape-
// weefselzijde, strak bijgesneden model)? Dan is de scanrand zelf de plaatrand.
function scanEndsAtEdge(an) {
  const ok = an.profiles.filter(p => !p.missing); if (ok.length < 5) return false;
  const share = side => ok.filter(p => p[side]?.edge).length / ok.length;
  return share('buccal') > 0.5 && (an.frame.jaw === 'upper' || share('lingual') > 0.5);
}
// v70: ook de lepel kan langs de scanrand (betande intraorale scan: de anatomische omtrek is daar onbruikbaar)
const EDGE_IDS = { beetplaat: ['beetEdge', 'beetEdgeInset'], lepel: ['lepelEdge', 'lepelEdgeInset'] };
const KIND_NAME = { lepel: 'lepel', beetplaat: 'beetplaat', basis: 'basis' };
function edgeMode(kind) { const ids = EDGE_IDS[kind]; return ids ? $(ids[0]).value : 'anatomy'; }
function edgeWanted(kind) {
  if (!EDGE_IDS[kind]) return false;
  const m = edgeMode(kind); if (m === 'edge') return true; if (m !== 'auto') return false;
  if (!S.anatomy || S.anatomy.soup !== S.scan) runAnatomy();
  return scanEndsAtEdge(S.anatomy.an);
}
// Rand langs de scanrand (v68): de plaat loopt precies tot de rand van de scan (of 'Afstand tot scanrand' erbinnen).
function edgeContour(kind) {
  const inset = Math.max(0, num(EDGE_IDS[kind][1]) || 0), axis = contourAxis();
  const r = trimByEdge(scanForPlates(), { inset, splitAt: S.designedFrom ?? null });
  // de getoonde lijn ligt 0,25 mm buiten de scanrand: sleep je later een stuk, dan blijft de rest exact de scanrand
  S.contours.setEdge(kind, editableOutline(r.outline, axis, { push: inset > 0 ? 0 : 0.25 }), axis, inset);
  if (S.mode === 'contour') setMode('orbit');
  delete S.plates[kind];
  updateContourUI(); refreshScanColors(); refreshOverlay();
  const why = edgeMode(kind) === 'auto' ? 'De plooi is niet gescand. ' : ''; // v71: losse zin (vertaalbaar)
  status(`${why}Rand langs de scanrand: ${{ lepel: 'de lepel', beetplaat: 'de beetplaat', basis: 'de basis' }[kind]} loopt ${inset > 0 ? `tot ${fmt(inset)} mm binnen` : 'precies tot'} de rand van de scan (${kind === 'lepel' ? 'lepelrand' : 'plaatrand'} = scanrand). Sleep de lijn om een stuk aan te passen.`);
}
function autoContour(kind) {
  if (!CONTOUR_KINDS.includes(kind)) return;
  const sr = surroundParts([kind]); // v73: scan houdt vlak naast de steg op → eerst daar aanvullen
  if (sr) toast(surroundText(sr).replace(/<[^>]+>/g, '').replace(/^./, c => c.toUpperCase()) + (sr.failed ? '.' : '. ↶ Terug zet het terug.'), !!sr.failed);
  if (edgeWanted(kind)) return edgeContour(kind);
  if (!S.anatomy || S.anatomy.soup !== S.scan) runAnatomy();
  const ol = proposeOutline(S.anatomy.cast, S.anatomy.an, kind), axis = contourAxis();
  // licht gladstrijken (2,5 mm): geen zaagtand in de rand, frenulum-uitsparingen blijven (afgerond) bestaan
  let pts = smoothOutline(ol.points, 2.5);
  // v72/v73: over een steg heen: de plaat omsluit de steg ruim (afstand per werkstuk, zie partClear); vereniging van
  // plaatgebied en verbrede voetafdruk, dus nooit een zelfkruisende omtrek
  const inc = includedParts(); if (inc.length) pts = keepOutlineClear(pts, inc.map(p => p.soup), axis, partClear(kind), { depthAt: scanDepthAt(axis), minClear: partClear(kind, true) });
  S.contours.setPoints(kind, untangle(pts, axisBasis(axis)), axis); // v72: nooit een zelfkruisende automatische omtrek
  if (S.mode === 'contour') setMode('orbit');
  delete S.plates[kind];
  updateContourUI(); refreshScanColors(); refreshOverlay();
  status(`Automatische omtrek: ${ol.rule}${ol.frena ? ` · ${ol.frena} frenulum-uitsparing(en)` : ''}. Pas aan met Terug/Wis of teken zelf.`);
}
$('contourAuto').onclick = () => busy('Omtrek bepalen volgens de anatomie…', async () => autoContour(S.step));

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
  s.sc.begin(); noteAction('sculpt');
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
// Eén ingang voor elke scanbewerking: geschiedenis, scan vervangen, ontwerp behouden/opnieuw maken.
function applyScanEdit(soup, label) {
  S.history.push({ soup: S.scan, aux: snapshotAux() }); noteAction('scan'); if (S.history.length > 8) S.history.shift(); S.future = [];
  const keep = keepDesign();
  setScan(soup, S.scanName, { reset: false });
  status(label + ' ↶ Terug zet het terug.');
  restoreDesign(keep);
}
function cutFrame() {
  if (S.frame) return { O: S.frame.O, N: S.frame.N };
  const axis = S.axis || occlusalAxisCached().axis; let best = -Infinity, O = [0, 0, 0];
  for (let i = 0; i < S.scan.length; i += 3) { const d = S.scan[i] * axis[0] + S.scan[i + 1] * axis[1] + S.scan[i + 2] * axis[2]; if (d > best) { best = d; O = [S.scan[i], S.scan[i + 1], S.scan[i + 2]]; } }
  return { O, N: axis };
}
contourTools = initContourTools({ S, viewer, $, num, status, CONTOUR_KINDS, snapToScan, contourAxis, finishContourEdit, dropPlate, setMode, updateContourUI, contourError, refreshOverlay, refreshScanColors, closeContourFromAbove });
scanTools = initScanTools({ S, viewer, $, num, status, busy, setMode, apply: applyScanEdit, cutFrame, refreshColors: () => refreshScanColors() });
// v72: vormbaar handvat (lepel en beetplaat): parameters in de invulvelden (onthouden), vormen met de vinger
function handleParams() {
  const v = (id, d) => { const x = num(id); return Number.isFinite(x) ? x : d; };
  return { height: v('handleHeight', HANDLE_DEFAULT.height), width: v('handleWidth', HANDLE_DEFAULT.width), reach: v('handleReach', HANDLE_DEFAULT.reach), thickness: v('handleThick', HANDLE_DEFAULT.thickness), yaw: v('handleYaw', 0), bend: v('handleBend', 60) / 100 };
}
function writeHandleParams(p, final) {
  const set = (id, x, step) => { const e = $(id); if (!e || !Number.isFinite(x)) return; e.value = String(Math.round(x / step) * step).replace(/\.0+$/, ''); };
  set('handleHeight', p.height, 0.5); set('handleWidth', p.width, 0.5); set('handleReach', p.reach, 0.5); set('handleThick', p.thickness, 0.25); set('handleYaw', p.yaw, 1); set('handleBend', p.bend * 100, 5);
  if (final) persist();
}
function handleOpts(kind) {
  const gap = num(kind === 'lepel' ? 'lepelGap' : 'beetGap'), wall = num(kind === 'lepel' ? 'lepelWall' : 'beetWall');
  return kind === 'lepel' ? { base: gap, labial: 2, sink: gap + wall * 0.5, conform: conformTo(gap + wall * 0.5) } : { base: gap + wall, labial: 6, sink: gap + wall * 0.5, conform: conformTo(gap + wall * 0.5) };
}
handleTools = initHandleTools({
  S, viewer, $, status, setMode, readParams: handleParams, writeParams: writeHandleParams, pathOpts: handleOpts,
  kindNow: () => (S.step === 'beetplaat' ? 'beetplaat' : 'lepel'),
  note: () => noteAction('handle'),
  rebuild: kind => busy(kind === 'lepel' ? 'Lepel berekenen…' : 'Beetplaat berekenen…', async () => { if (kind === 'lepel') await buildLepel(); else await buildBeet(); }),
});
const HANDLE_PRESETS = { recht: { reach: 0, yaw: 0, bend: 0.6 }, schuin: { reach: 8, yaw: 0, bend: 0.45 }, l: { reach: 14, yaw: 0, bend: 0.85, height: 10 } };
for (const b of document.querySelectorAll('[data-hpreset]')) b.onclick = () => {
  const kind = S.step === 'beetplaat' ? 'beetplaat' : 'lepel';
  if (!$(kind === 'lepel' ? 'lepelHandle' : 'beetHandle').checked) { $(kind === 'lepel' ? 'lepelHandle' : 'beetHandle').checked = true; persist(); }
  handleTools.changed({ ...handleParams(), ...HANDLE_PRESETS[b.dataset.hpreset] });
};
for (const id of ['handleEdit', 'beetHandleEdit']) $(id).onclick = () => {
  const kind = id === 'handleEdit' ? 'lepel' : 'beetplaat';
  if (handleTools.active()) { setMode('orbit'); return; }
  const box = $(kind === 'lepel' ? 'lepelHandle' : 'beetHandle');
  if (!box.checked) { box.checked = true; persist(); }
  if (handleTools.start(kind) && !S.plates[kind]) handleTools.changed(handleParams());
};
for (const id of ['handleHeight', 'handleWidth', 'handleReach', 'handleThick', 'handleYaw']) $(id).addEventListener('change', () => { if (handleTools.active()) handleTools.changed(handleParams()); });
tools = initSetupTools({
  note: src => noteAction(src), S, viewer, $, num, fmt, status, toast, busy, jaw, currentArchFn, setPrimary, toothMaterial, setMode,
  pushHistory: pushTeethHistory, dropHistory: () => { S.teethHistory.pop(); }, invalidate: invalidateTeethDependents,
  layers: () => applyLayers(), afterTeethChange: () => { renderToothList(); updateDone(); },
});
buildSteps(); buildToothMap();
try { const saved = JSON.parse(localStorage.getItem(STORE) || 'null'); if (saved) { if (!saved.v61 && saved.settings) saved.settings.rimOn = false; if (!saved.v63 && saved.settings) { delete saved.settings.archForm; delete saved.settings.planeMode; } applySettings(saved.settings); S.selectedTeeth = new Set(saved.teeth || []); } } catch { /* geen opslag */ }
updateTeethMap(); syncConceptUI(); updateAxisInfo(); updateLandmarkInfo(); updateMarkInfo(); renderToothList();
$('biteDraft').disabled = $('biteFit').value !== 'block';
syncRimFields();
syncWorkSteps(); showStep('opdracht');
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
    ORIGINALS.add(soup);
    const auto = autoSimplify(soup);
    setScan(auto.soup, item.name);
    if (auto.original) S.history = [{ soup: auto.original, aux: snapshotAux() }];
    showStep('scan');
  }).then(() => { if (item.extract && S.scan) $('intaglioBtn').click(); });
}).catch(e => status('Overdracht mislukt: ' + e.message, true));

// ---------- ⚡ alles automatisch ----------
// Eén knop: referentiepunten → anatomie → omtrek → werkstuk (lepel / beetplaat / opstelling + basis) → controle.
// Elke stap gebruikt dezelfde functies als de losse knoppen; bij een fout stopt de reeks en blijft alles bewerkbaar.
async function autoAll() {
  S.autoRunning = true;
  try { return await autoAllInner(); } finally { S.autoRunning = false; }
}
async function autoAllInner() {
  if (!S.scan) { status('Open eerst een STL-scan of kies Demo-kaak, en tik dan op ⚡ Alles automatisch.', true); toast('Open eerst een scan (of Demo-kaak).', true); return false; }
  const work = $('work').value, done = [], t0 = performance.now();
  const step = async (label, fn) => {
    const ok = await busy(`⚡ ${label}…`, async () => { await fn(); return true; });
    if (!ok) { $('autoLog').innerHTML = done.map(d => `<li class="ok">${d}</li>`).join('') + `<li class="warn">${label}: mislukt — zie de melding onderaan. Los het op en tik opnieuw.</li>`; return false; }
    done.push(label); return true;
  };
  $('autoLog').innerHTML = '';
  if (S.prepared !== S.scan && !await step('Scan voorbereiden (repareren, bijsnijden, aanvullen)', async () => { await prepareScan({ forKind: work }); S.prepared = S.scan; })) return false;
  if (!await step('Referentiepunten op de kam', async () => ensureFrame())) return false;
  if (!await step('Anatomie analyseren', async () => runAnatomy())) return false;
  if (work === 'lepel' || work === 'beetplaat') {
    showStep(work);
    if (!await step(`Omtrek ${work} (anatomie of scanrand)`, async () => autoContour(work))) return false;
    if (!await step(work === 'lepel' ? 'Lepel genereren' : 'Beetplaat genereren', work === 'lepel' ? buildLepel : buildBeet)) return false;
    if (!S.plates[work]) return false;
  } else {
    showStep('opstelling');
    if (!await step('Tanden opstellen op de kamlijn', async () => buildTeeth())) return false;
    if (S.antagonist && viewer.antagonistMesh) await step('In occlusie brengen met de antagonist', async () => { await autoOccludeClick(); });
    showStep('basis');
    if (!await step('Omtrek basis volgens de anatomie', async () => autoContour('basis'))) return false;
    if (!await step('Prothesebasis genereren', buildBasis)) return false;
  }
  showStep('controle'); runChecks();
  const secs = ((performance.now() - t0) / 1000).toFixed(1).replace('.', ',');
  $('autoLog').innerHTML = done.map(d => `<li class="ok">${d}</li>`).join('') + `<li class="info">Klaar in ${secs} s. Controleer het resultaat hieronder en ga naar Productie.</li>`;
  status(`⚡ Klaar in ${secs} s: ${done.length} stappen. Controleer en pas zo nodig aan; elke stap is daarna los te wijzigen.`);
  return true;
}
$('autoAll').onclick = () => autoAll();

// ---------- 🧹 scan voorbereiden ----------
// forKind: voor welk werkstuk (autoStep / ⚡). Bij een beetplaat met 'rand langs de scanrand' (automatisch of gekozen)
// wordt de scan niet aangevuld: de plaat hoort dan precies tot de echte scanrand te lopen, niet op een ontworpen rand.
async function prepareScan({ forKind = null } = {}) {
  if (!S.scan) throw Error('Laad eerst een scan.');
  const t0 = performance.now(), name = S.scanName.replace(/(_voorbereid)?\.stl$/i, '') + '_voorbereid.stl', lines = [];
  await tick('Scan analyseren…');
  const before = analyzeScan(S.scan);
  S.history.push({ soup: S.scan, aux: snapshotAux() }); noteAction('scan'); if (S.history.length > 8) S.history.shift(); S.future = [];
  const keep = keepDesign(); S.pendingKeep = keep;
  lines.push(`<b>Analyse</b>: ${int(before.faces)} facetten · ${before.components} deel/delen${before.smallComponents ? ` (${before.smallComponents} losse vlekjes)` : ''} · ${before.spikes} spikes · ${before.nonManifold} niet-manifold randen · ${before.holes} randen/gaten · ${before.closed ? 'gesloten (model met sokkel?)' : 'open scan'}`);
  await tick('Scan repareren…');
  const { soup: rep, report: r } = repairScan(S.scan);
  setScan(rep, name, { reset: false, designedFrom: r.designedFrom < rep.length / 9 ? r.designedFrom : null, keepWax: true });
  lines.push(`<b>Reparatie</b>: ${r.duplicate + r.flat + r.invalid} kapotte/dubbele facetten · ${r.islands} losse delen (${int(r.islandFaces)} facetten) · ${r.spikes} spikes · ${r.nonManifold} niet-manifold · ${r.holesFilled} gaten gedicht`);
  await tick('Referentiepunten en anatomie…');
  S.frame = null; S.landmarks = {}; ensureFrame(); let a = runAnatomy();
  if ($('prepTrim').checked) {
    await tick('Scan bijsnijden…');
    const ol = proposeOutline(a.cast, a.an, 'basis');
    // vloeiende bijsnijlijn (geen inkepingen bij de lipbandjes): de scan wordt ruim bijgesneden, het werkstuk krijgt later zijn eigen rand
    // v72: rond een steg ruim blijven (de plaat moet er later overheen tot op het tandvlees kunnen)
    const trimLine = S.parts.length ? keepOutlineClear(ol.points, S.parts.map(p => p.soup), S.frame.N, Math.max(4, ...CONTOUR_KINDS.map(partClear)) + 1) : ol.points;
    const t = trimByOutline(S.scan, untangle(smoothOutline(trimLine, 4), axisBasis(S.frame.N)), S.frame.N, { margin: num('prepMargin') + 1, splitAt: S.designedFrom }); // +1 mm: gladstrijken trekt bolle delen iets naar binnen
    const df = S.designedFrom != null && t.splitIndex < t.soup.length / 9 ? t.splitIndex : null;
    // binnen de marge kan nog een los stuk sokkel of tafel liggen: alleen de kaak (grootste deel) houden
    const only = keepComponentNear(t.soup, S.landmarks.M ?? S.frame.O);
    // strakke rand: oortjes, vlinders, nul-lange randen en spleetjes weg, buitenrand vloeiend op het oppervlak
    const rim = cleanRim(only.soup);
    setScan(rim.soup, name, { reset: false, designedFrom: null, keepWax: true });
    lines.push(`<b>Bijsnijden</b>: prothesegebied + ${fmt(num('prepMargin'))} mm · ${int(t.report.removed)} facetten verwijderd (sokkel, wang/tong, artefacten) · ${int(t.report.clipped)} randfacetten exact gesneden`);
    await tick('Anatomie bijwerken…');
    a = runAnatomy();
  }
  // v72: rand strak: franjes (scanruis, wang/tong) weg en smalle inhammen (gat in het front) dicht
  const to = tidyOptions();
  if (to.fringe > 0 || to.notchWidth > 0) {
    await tick('Rand strak maken…');
    const r = tidyBorder(S.scan, { designedFrom: S.designedFrom ?? null, ...to, protect: partProtect() });
    setScan(r.soup, name, { reset: false, designedFrom: r.designedFrom, keepWax: true });
    lines.push(tidyLine(r.report));
    a = runAnatomy();
  }
  // v73: scan houdt vlak naast de steg op: daar aanvullen (ook als het werkstuk tot de echte scanrand loopt; zonder
  // tandvlees rond de steg kan er geen plaat overheen)
  if (includedParts().length && $('prepComplete').checked) {
    await tick(`Rand rond ${partDe(S.parts[0])} controleren…`);
    const sr = surroundParts(forKind ? [forKind] : CONTOUR_KINDS);
    if (sr) { lines.push(`<b>${S.parts[0].kind === 'steg' ? 'Rond de steg' : 'Rond het onderdeel'}</b>: ${surroundText(sr)}`); if (!sr.failed) a = runAnatomy(); }
  }
  const edgeRule = !!EDGE_IDS[forKind] && edgeMode(forKind) !== 'anatomy';
  if ($('prepComplete').checked && num('prepExtend') > 0 && edgeRule) lines.push(`<b>Aanvullen</b>: niet gedaan, de ${KIND_NAME[forKind]} loopt tot de echte scanrand (${forKind === 'lepel' ? 'Lepel' : 'Beetplaat'} → Rand)`);
  else if ($('prepComplete').checked && num('prepExtend') > 0) {
    const st = a.an.stats;
    if (st.edge > st.profiles * 0.3) {
      await tick('Rand aanvullen…');
      const ext = extendBorder(S.scan, { length: num('prepExtend') });
      setScan(ext.soup, name, { reset: false, designedFrom: Math.min(S.designedFrom ?? Infinity, ext.report.designedFrom), keepWax: true });
      a = runAnatomy();
      lines.push(`<b>Aanvullen</b>: plooi op ${Math.round(st.edge / st.profiles * 100)}% van de boog niet gescand → rand ${fmt(num('prepExtend'))} mm vloeiend verlengd (paars = ontworpen, niet gescand) · verwachte plooidiepte ${fmt(proposeOutline(a.cast, a.an, 'basis').sulcus.buccal.depth)} mm`);
    } else lines.push('<b>Aanvullen</b>: niet nodig, de plooi is gescand');
  }
  await tick('Controle…');
  const after = analyzeScan(S.scan, { spikes: false });
  lines.push(`<b>Resultaat</b>: ${int(after.faces)} facetten · ${after.components} deel · ${after.holes} rand · ${after.nonManifold} niet-manifold · ${((performance.now() - t0) / 1000).toFixed(1).replace('.', ',')} s · scanpunten niet verschoven${S.wax?.soup === S.scan && S.wax.stats().points ? ' · was behouden' : ''}`);
  $('prepReport').innerHTML = lines.join('<br>');
  refreshScanColors(); refreshOverlay(); updateDone();
  restoreDesign(S.pendingKeep); S.pendingKeep = null;
  return after;
}
// Direct onder een steg geen franjes weghalen (smalle strook van 1 mm rond de voetafdruk). Een bredere zone hield
// ook de losse flarden scan naast de steg (tong) over, en daarop mislukte de plaat.
function partProtect() { return S.parts.length ? partZone(S.parts.map(p => p.soup), contourAxis(), 1) : null; }
function tidyOptions() { return { fringe: Math.max(0, num('prepFringe') || 0) / 2, notchWidth: Math.max(0, num('prepNotch') || 0) }; }
function tidyLine(rep) {
  const n = rep.notches.length;
  return `<b>Rand strak</b>: ${rep.fringeFaces ? `franjes weg (${int(rep.fringeFaces)} facetten)` : 'geen franjes'} · ${n ? `${n} inham${n === 1 ? '' : 'men'} dicht (${rep.notches.map(x => fmt(x.width, 1)).join(', ')} mm breed)` : 'geen inhammen'}${rep.holes ? ` · ${rep.holes} ga${rep.holes === 1 ? 't' : 'ten'} gedicht` : ''}`;
}
$('scanTidy').onclick = () => busy('Rand strak maken…', async () => {
  if (!S.scan) throw Error('Laad eerst een scan.');
  const to = tidyOptions();
  if (!(to.fringe > 0 || to.notchWidth > 0)) throw Error('Zet bij Scan voorbereiden de franjes of de inhammen op meer dan 0 mm.');
  const r = tidyBorder(S.scan, { designedFrom: S.designedFrom ?? null, ...to, protect: partProtect() });
  if (!r.report.fringeFaces && !r.report.notches.length && !r.report.holes) return status('De rand is al strak: geen franjes of inhammen gevonden.');
  S.history.push({ soup: S.scan, aux: snapshotAux() }); noteAction('scan'); if (S.history.length > 8) S.history.shift(); S.future = [];
  const keep = keepDesign();
  setScan(r.soup, S.scanName, { reset: false, designedFrom: r.designedFrom, keepWax: true });
  status(tidyLine(r.report).replace(/<[^>]+>/g, '') + '. ↶ Terug zet het terug.');
  restoreDesign(keep);
});
$('prepRun').onclick = () => busy('Scan voorbereiden…', async () => { await prepareScan(); status('Scan voorbereid. Controleer het paarse (aangevulde) deel en ga verder met de omtrek.'); });

// ---------- 🕯 was (ondersnijdingen opvullen, bewerkbaar) ----------
let waxTool = 'add', waxStroke = null, waxQueued = null;
function ensureWax() { if (!S.scan) throw Error('Laad eerst een scan.'); if (!S.wax || S.wax.soup !== S.scan) S.wax = new WaxLayer(S.scan, contourAxis()); return S.wax; }
function showWax() {
  viewer.clearGroup('wax');
  const d = S.wax ? S.wax.displaySoup() : [];
  if (d.length) { const m = makeMesh(d, 0xf0b25a, { roughness: 0.65, opacity: 1 }); m.material.polygonOffset = true; m.material.polygonOffsetFactor = -2; m.material.polygonOffsetUnits = -2; m.name = 'was'; viewer.groups.wax.add(m); }
  applyLayers();
}
function waxChanged(final = false) {
  S.waxSoup = S.wax.stats().points ? S.wax.waxedSoup() : null;
  showWax();
  if (final) {
    const st = S.wax.stats();
    $('waxInfo').textContent = st.points ? `Was op ${int(st.points)} punten · max ${fmt(st.max, 2)} mm · gem. ${fmt(st.mean, 2)} mm. De plaat wordt op scan + was gebouwd.` : 'Geen was. De plaat ligt exact op de scan.';
    const had = CONTOUR_KINDS.filter(k => S.plates[k] || (k === 'basis' && S.plates.monoblock));
    for (const k of CONTOUR_KINDS) S.contours.invalidate(k);
    if (had.length) restoreDesign({ kinds: had }); // werkstukken op scan + was opnieuw maken in plaats van wissen
    refreshScanColors(); updateDone();
  }
}
function waxBlockout() { const w = ensureWax(); const r = w.blockout(num('waxAngle')); noteAction('wax'); waxChanged(true); return r; }
$('waxRun').onclick = () => busy('Ondersnijdingen opvullen…', async () => { const r = waxBlockout(); status(r.changed ? `Was aangebracht op ${int(r.changed)} punten (max ${fmt(r.max, 2)} mm, uitblokhoek ${fmt(num('waxAngle'))}°). Bewerk met ✋ Was bewerken.` : 'Geen ondersnijdingen gevonden langs de insteekas.'); });
$('waxClear').onclick = () => { if (!S.wax) return; S.wax.clear(); noteAction('wax'); waxChanged(true); };
$('waxUndo').onclick = () => { if (S.wax?.undo()) { waxChanged(true); status('Was teruggedraaid.'); } else status('Niets om terug te zetten in de was.'); };
$('waxRedo').onclick = () => { if (S.wax?.redo()) { waxChanged(true); status('Was hersteld.'); } else status('Niets om opnieuw te doen in de was.'); };
$('waxEdit').onclick = () => { try { ensureWax(); } catch (e) { return status(e.message, true); } setMode(S.mode === 'wax' ? 'orbit' : 'wax'); };
for (const b of document.querySelectorAll('[data-wax]')) b.onclick = () => { waxTool = b.dataset.wax; for (const x of document.querySelectorAll('[data-wax]')) x.setAttribute('aria-pressed', String(x === b)); if (S.mode !== 'wax') $('waxEdit').click(); };
function waxHit(e) { const objs = [viewer.scanMesh, ...viewer.groups.wax.children].filter(Boolean); return viewer.pick(e.clientX, e.clientY, objs); }
function waxDab(p) { S.wax.brush(waxStroke.tool, p, { radius: num('waxRadius'), strength: num('waxStrength') }); waxStroke.last = p; waxChanged(false); }
function waxDown(e) {
  const hit = waxHit(e); if (!hit || !S.wax) return;
  viewer.controls.enabled = false; S.wax.snap(); noteAction('wax');
  const tool = e.shiftKey && waxTool !== 'smooth' ? (waxTool === 'add' ? 'remove' : 'add') : waxTool;
  waxStroke = { tool, last: null }; waxDab(hit.point.toArray());
}
function waxMove(e) {
  if (!waxStroke) return;
  waxQueued = { clientX: e.clientX, clientY: e.clientY };
  requestAnimationFrame(() => { const q = waxQueued; waxQueued = null; if (!q || !waxStroke) return; const hit = waxHit(q); if (!hit) return; const p = hit.point.toArray(), l = waxStroke.last;
    if (!l || Math.hypot(p[0] - l[0], p[1] - l[1], p[2] - l[2]) >= num('waxRadius') * 0.3) waxDab(p); });
}
function waxUp() { viewer.controls.enabled = true; if (waxStroke) { waxStroke = null; waxChanged(true); } }

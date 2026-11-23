// Stap "Scan & mesh" — interactieve scanbewerking (interface). De rekenkern staat in ../scan-edit.js.
// Gereedschap: lasso knippen, gum, gladmaken (penseel), sokkel/vlak afsnijden met live voorbeeld,
// losse delen weg, gaten dichten. Elke bewerking gaat via ctx.apply(soup, tekst): geschiedenis (↶/↷),
// en lepel/beetplaat/basis worden daarna automatisch opnieuw gemaakt; de opstelling blijft staan.
import * as THREE from 'three';
import { lassoMask, sphereMask, deleteMaskClean, smoothMask, keepLargest, planeCut, closeHoles, countMask } from '../scan-edit.js';

const PREVIEW = [[0.95, 0.3, 0.3], [0.35, 0.75, 1.0]]; // wissen rood, gladmaken blauw

export function initScanTools(ctx) {
  const { S, viewer, $, num, status, busy } = ctx;
  const canvas = viewer.canvas, host = canvas.parentElement;
  let tool = null, stroke = null, planeMesh = null;

  // ---------- overlay (lasso-lijn en penseelcirkel) ----------
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'scanedit-overlay'); svg.innerHTML = '<polyline fill="rgba(255,90,90,.12)" stroke="#ff6b6b" stroke-width="2" stroke-dasharray="6 4"/><circle r="0" fill="none" stroke="#7fd0ff" stroke-width="2"/>';
  host.appendChild(svg);
  const line = svg.querySelector('polyline'), ring = svg.querySelector('circle');
  const local = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

  function setTool(t) {
    tool = tool === t ? null : t;
    for (const b of document.querySelectorAll('[data-scantool]')) b.setAttribute('aria-pressed', String(b.dataset.scantool === tool));
    ctx.setMode(tool ? 'scanedit' : 'orbit');
    line.setAttribute('points', ''); ring.setAttribute('r', 0);
    svg.classList.toggle('on', !!tool);
    const hint = { lasso: 'Lasso: trek met de vinger of muis een lijn rond het deel dat weg moet; loslaten = knippen. Beeld draaien: eerst Lasso uitzetten of met twee vingers.', erase: 'Gum: veeg over wat weg moet (rood); loslaten = wissen.', smooth: 'Gladmaken: veeg over ruwe plekken (blauw); loslaten = gladmaken. De scanrand blijft op zijn plek.' }[tool];
    status(hint ?? 'Scanbewerking uit: slepen draait weer het beeld.');
  }
  for (const b of document.querySelectorAll('[data-scantool]')) b.onclick = () => { if (!S.scan) return status('Laad eerst een scan.', true); setTool(b.dataset.scantool); };

  // ---------- projectie voor de lasso ----------
  function projector() {
    const cam = viewer.camera, r = canvas.getBoundingClientRect(), v = new THREE.Vector3();
    cam.updateMatrixWorld();
    return (x, y, z) => { v.set(x, y, z).project(cam); return [(v.x + 1) / 2 * r.width, (1 - v.y) / 2 * r.height, v.z]; };
  }
  function viewDir() { const d = new THREE.Vector3(); viewer.camera.getWorldDirection(d); return d.toArray(); }

  // ---------- aanwijzer ----------
  canvas.addEventListener('pointerdown', e => {
    if (S.mode !== 'scanedit' || !tool || e.button > 0 || !S.scan) return;
    if (stroke) return;
    e.stopImmediatePropagation(); e.preventDefault();
    viewer.controls.enabled = false; canvas.setPointerCapture?.(e.pointerId);
    stroke = { id: e.pointerId, pts: [local(e)], mask: tool === 'lasso' ? null : new Uint8Array(S.scan.length / 9) };
    if (tool !== 'lasso') brushAt(e);
  }, { capture: true });
  canvas.addEventListener('pointermove', e => {
    if (S.mode !== 'scanedit' || !tool) return;
    const p = local(e);
    if (tool !== 'lasso') showRing(e, p);
    if (!stroke || e.pointerId !== stroke.id) return;
    e.stopImmediatePropagation();
    if (tool === 'lasso') { const last = stroke.pts[stroke.pts.length - 1]; if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 3) { stroke.pts.push(p); line.setAttribute('points', stroke.pts.map(q => q.join(',')).join(' ')); } }
    else brushAt(e);
  }, { capture: true });
  const end = e => {
    if (!stroke || e.pointerId !== stroke.id) return;
    e.stopImmediatePropagation();
    const s = stroke; stroke = null; viewer.controls.enabled = true;
    line.setAttribute('points', '');
    if (tool === 'lasso') finishLasso(s.pts);
    else finishBrush(s.mask);
  };
  canvas.addEventListener('pointerup', end, { capture: true });
  canvas.addEventListener('pointercancel', e => { if (stroke && e.pointerId === stroke.id) { stroke = null; viewer.controls.enabled = true; line.setAttribute('points', ''); ctx.refreshColors(); } }, { capture: true });
  addEventListener('keydown', e => { if (e.key === 'Escape' && tool) setTool(tool); });

  function showRing(e, p) {
    const hit = viewer.pick(e.clientX, e.clientY, [viewer.scanMesh]);
    if (!hit) { ring.setAttribute('r', 0); return; }
    const proj = projector(), c = proj(...hit.point.toArray()), right = new THREE.Vector3().setFromMatrixColumn(viewer.camera.matrixWorld, 0);
    const q = proj(...hit.point.clone().addScaledVector(right, num('scanBrush')).toArray());
    ring.setAttribute('cx', p[0]); ring.setAttribute('cy', p[1]); ring.setAttribute('r', Math.max(4, Math.hypot(q[0] - c[0], q[1] - c[1])));
    ring.setAttribute('stroke', tool === 'erase' ? '#ff6b6b' : '#7fd0ff');
  }
  let colorQueued = false;
  function brushAt(e) {
    const hit = viewer.pick(e.clientX, e.clientY, [viewer.scanMesh]);
    if (!hit) return;
    sphereMask(S.scan, hit.point.toArray(), num('scanBrush'), stroke.mask);
    if (!colorQueued) { colorQueued = true; requestAnimationFrame(() => { colorQueued = false; if (stroke?.mask) viewer.colorFaces(stroke.mask.map(v => v ? (tool === 'erase' ? 1 : 2) : 0), PREVIEW); }); }
  }

  function finishLasso(pts) {
    if (pts.length < 4) return status('Lasso te klein: trek een grotere lijn rond het deel dat weg moet.', true);
    const mask = lassoMask(S.scan, pts, projector(), { viewDir: viewDir(), frontOnly: $('scanFront').checked });
    const keepInside = $('scanLassoMode').value === 'keep';
    const del = keepInside ? mask.map(v => v ? 0 : 1) : mask, n = countMask(del);
    if (!n) return status('Binnen de lijn ligt geen scan.', true);
    if (n >= S.scan.length / 9) return status('Dit zou de hele scan wissen.', true);
    ctx.apply(deleteMaskClean(S.scan, del), `Geknipt: ${n.toLocaleString('nl-NL')} driehoeken ${keepInside ? 'buiten' : 'binnen'} de lijn verwijderd.`);
  }
  function finishBrush(mask) {
    const n = countMask(mask);
    if (!n) { ctx.refreshColors(); return; }
    if (tool === 'erase') ctx.apply(deleteMaskClean(S.scan, mask), `Gewist: ${n.toLocaleString('nl-NL')} driehoeken.`);
    else busy('Gladmaken…', async () => ctx.apply(smoothMask(S.scan, mask, { iterations: num('scanSmooth') }), `Gladgemaakt: ${n.toLocaleString('nl-NL')} driehoeken (rand blijft staan).`));
  }

  // ---------- vlak afsnijden (sokkel) met live voorbeeld ----------
  function cutPlane() {
    const { O, N } = ctx.cutFrame(); // N wijst naar de kam/occlusaal; de sokkel ligt aan de −N-kant
    const h = num('scanCut'), o = O.map((v, i) => v - N[i] * h);
    return { origin: o, normal: N };
  }
  function showPlane() {
    if (!S.scan) return;
    const { origin, normal } = cutPlane();
    if (!planeMesh) {
      planeMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xff7a59, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }));
      planeMesh.renderOrder = 5; viewer.groups.overlay.add(planeMesh);
    }
    const box = new THREE.Box3().setFromObject(viewer.scanMesh), size = box.getSize(new THREE.Vector3()).length() * 1.1;
    planeMesh.scale.set(size, size, 1);
    planeMesh.position.set(...origin);
    planeMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...normal));
    planeMesh.visible = true; viewer.render();
    clearTimeout(showPlane.t); showPlane.t = setTimeout(hidePlane, 6000);
  }
  function hidePlane() { if (planeMesh) { planeMesh.visible = false; viewer.render(); } }
  $('scanCut')?.addEventListener('input', () => { $('scanCutVal').textContent = `${num('scanCut').toFixed(1).replace('.', ',')} mm`; showPlane(); });
  $('scanCutShow') && ($('scanCutShow').onclick = showPlane);
  $('scanCutBtn') && ($('scanCutBtn').onclick = () => busy('Afsnijden…', async () => {
    if (!S.scan) throw Error('Laad eerst een scan.');
    const { origin, normal } = cutPlane(), out = planeCut(S.scan, origin, normal), removed = (S.scan.length - out.length) / 9;
    if (out.length === S.scan.length) throw Error('Het vlak raakt de scan niet: kies een kleinere hoogte.');
    if (out.length < 900) throw Error('Dit vlak zou bijna de hele scan wegsnijden: kies een grotere hoogte.');
    hidePlane();
    ctx.apply(out, `Afgesneden op ${num('scanCut').toFixed(1).replace('.', ',')} mm onder de kam (${Math.max(0, Math.round(removed)).toLocaleString('nl-NL')} driehoeken netto weg, rand exact gesneden).`);
  }));

  // ---------- losse delen en gaten ----------
  $('scanIslands') && ($('scanIslands').onclick = () => busy('Losse delen zoeken…', async () => {
    if (!S.scan) throw Error('Laad eerst een scan.');
    const r = keepLargest(S.scan);
    if (!r.removed) return status('Geen losse delen: de scan is één geheel.');
    ctx.apply(r.soup, `${r.removed} los${r.removed > 1 ? 'se' : ''} deel${r.removed > 1 ? 'en' : ''} verwijderd; het grootste deel blijft.`);
  }));
  $('scanHoles') && ($('scanHoles').onclick = () => busy('Gaten dichten…', async () => {
    if (!S.scan) throw Error('Laad eerst een scan.');
    const r = closeHoles(S.scan, { maxEdges: 600 });
    if (!r.filled) return status('Geen gaten gevonden (de buitenrand blijft altijd open).');
    ctx.apply(r.soup, `${r.filled} ga${r.filled > 1 ? 'ten' : 't'} gedicht; de buitenrand blijft open.`);
  }));

  return { off: () => { if (tool) setTool(tool); hidePlane(); }, active: () => tool };
}

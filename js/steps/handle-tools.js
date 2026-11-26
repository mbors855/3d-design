// v72: handvat vormen met de vinger of de muis, direct in het 3D-beeld (stap Lepel en Beetplaat).
//  - Eén vinger op de oranje bol (of op het handvat) slepen: de punt van het handvat gaat mee. Zo kies je hoogte,
//    hoe ver het naar voren steekt en of het iets naar links of rechts wijst (richting en vorm in één beweging).
//  - Twee vingers op het handvat: knijpen = breedte, draaien = zijwaartse richting.
//  - Buiten het handvat werkt het beeld gewoon (draaien, zoomen).
//  - Loslaten: het werkstuk wordt met het nieuwe handvat opnieuw opgebouwd. Elke wijziging is terug te draaien (↶).
import * as THREE from 'three';
import { makeMesh } from '../viewer.js';
import { handlePath, handleGeometry } from '../construct.js';

const LIMITS = { height: [5, 35], reach: [0, 30], yaw: [-60, 60], width: [5, 25], thickness: [2, 6] };
const clamp = (k, v) => Math.min(LIMITS[k][1], Math.max(LIMITS[k][0], v));

export function initHandleTools(ctx) {
  const { S, viewer, $, status, setMode, readParams, writeParams, pathOpts, rebuild } = ctx;
  const canvas = viewer.canvas;
  let kind = null, preview = null, knob = null, act = null, pending = 0;
  const pointers = new Map(), hist = [], future = [];

  function clearVisuals() {
    for (const o of [preview, knob]) if (o) { o.parent?.remove(o); o.geometry.dispose(); o.material.dispose(); }
    preview = knob = null;
  }
  function draw(p = readParams()) {
    clearVisuals();
    if (!kind || !S.frame) return;
    const opts = pathOpts(kind);
    preview = makeMesh(handleGeometry(S.frame, p, opts), 0x46c8d5, { opacity: 0.92, roughness: 0.35 });
    preview.renderOrder = 15; preview.name = 'handvat-voorbeeld';
    const { tip } = handlePath(S.frame, p, opts);
    knob = new THREE.Mesh(new THREE.SphereGeometry(2.4, 20, 14), new THREE.MeshBasicMaterial({ color: 0xff9a3c, depthTest: false, transparent: true, opacity: 0.95 }));
    knob.position.set(...tip); knob.renderOrder = 30;
    viewer.groups.ghost.add(preview); viewer.groups.overlay.add(knob); // voorbeeld belicht (hoofdscène), bol altijd zichtbaar
    viewer.render();
  }
  function setPlateFade(on) {
    const m = viewer.groups.plates.getObjectByName(kind);
    if (m) { m.material.transparent = true; m.material.opacity = on ? 0.35 : 0.9; m.material.depthWrite = !on; }
    viewer.render();
  }
  function start(k) {
    if (!S.frame) { status('Zet eerst de referentiepunten (stap Analyse).', true); return false; }
    kind = k; setMode('handle'); draw(); setPlateFade(true);
    status('Handvat vormen: sleep de oranje bol (richting, hoogte, naar voren) · twee vingers op het handvat: knijpen = breedte, draaien = zijwaarts · buiten het handvat draaien.');
    return true;
  }
  function stop() {
    if (!kind) return;
    setPlateFade(false); clearVisuals(); kind = null; act = null; pointers.clear();
    viewer.controls.enabled = true; viewer.render();
  }
  function onHandle(e) {
    if (!preview) return false;
    viewer.raycaster.setFromCamera(viewer.ndc(e.clientX, e.clientY), viewer.camera);
    // de bol iets ruimer: makkelijk te pakken met een vinger
    const r = viewer.raycaster.ray, d = r.distanceToPoint(knob.position), px = pixelSize(knob.position);
    if (d < Math.max(2.4, px * 22)) return true;
    return viewer.raycaster.intersectObject(preview, false).length > 0;
  }
  function pixelSize(p) { // mm per schermpixel op diepte van p
    const dist = viewer.camera.position.distanceTo(p), h = canvas.getBoundingClientRect().height || 1;
    return 2 * dist * Math.tan(viewer.camera.fov * Math.PI / 360) / h;
  }
  function record() { hist.push(readParams()); if (hist.length > 60) hist.shift(); future.length = 0; ctx.note?.(); }
  function commit() {
    clearTimeout(pending);
    pending = setTimeout(() => { if (kind) rebuild(kind).then(() => { if (kind) { draw(); setPlateFade(true); } }); }, 120);
  }

  canvas.addEventListener('pointerdown', e => {
    if (S.mode !== 'handle' || !kind) return;
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (act && pointers.size === 2 && act.type === 'drag') { // tweede vinger op het handvat: knijpen/draaien
      const [a, b] = [...pointers.values()];
      act = { type: 'pinch', p0: readParams(), d0: Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, a0: Math.atan2(b[1] - a[1], b[0] - a[0]) };
      e.stopImmediatePropagation(); e.preventDefault(); return;
    }
    if (pointers.size !== 1 || e.button > 0 || !onHandle(e)) return; // niet op het handvat: gewoon het beeld
    e.stopImmediatePropagation(); e.preventDefault();
    canvas.setPointerCapture?.(e.pointerId);
    viewer.controls.enabled = false;
    record();
    const p = readParams(), { tip } = handlePath(S.frame, p, pathOpts(kind));
    const n = new THREE.Vector3(); viewer.camera.getWorldDirection(n);
    act = { type: 'drag', id: e.pointerId, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3(...tip)), p0: p };
  }, { capture: true });

  canvas.addEventListener('pointermove', e => {
    if (!act || S.mode !== 'handle') return;
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [e.clientX, e.clientY]);
    e.stopImmediatePropagation(); e.preventDefault();
    let p = readParams();
    if (act.type === 'drag' && e.pointerId === act.id) {
      viewer.raycaster.setFromCamera(viewer.ndc(e.clientX, e.clientY), viewer.camera);
      const hit = viewer.raycaster.ray.intersectPlane(act.plane, new THREE.Vector3()); if (!hit) return;
      const { foot } = handlePath(S.frame, act.p0, pathOpts(kind)), { X, Y, N } = S.frame;
      const v = [hit.x - foot[0], hit.y - foot[1], hit.z - foot[2]], up = v[0] * N[0] + v[1] * N[1] + v[2] * N[2];
      const hx = v[0] * X[0] + v[1] * X[1] + v[2] * X[2], hy = v[0] * Y[0] + v[1] * Y[1] + v[2] * Y[2], reach = Math.hypot(hx, hy);
      p = { ...p, height: clamp('height', up), reach: clamp('reach', reach) };
      if (reach > 1.5) p.yaw = clamp('yaw', Math.atan2(hx, hy) * 180 / Math.PI);
    } else if (act.type === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()], d = Math.hypot(b[0] - a[0], b[1] - a[1]), ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      p = { ...p, width: clamp('width', act.p0.width * d / act.d0), yaw: clamp('yaw', act.p0.yaw - (ang - act.a0) * 180 / Math.PI) };
    } else return;
    writeParams(p, false);
    if (!act.raf) act.raf = requestAnimationFrame(() => { if (act) act.raf = 0; draw(readParams()); });
  }, { capture: true });

  const up = e => {
    pointers.delete(e.pointerId);
    if (!act || S.mode !== 'handle') return;
    e.stopImmediatePropagation();
    if (act.type === 'pinch' && pointers.size === 1) return; // eerst beide vingers los
    const changed = JSON.stringify(readParams()) !== JSON.stringify(act.p0);
    act = null; viewer.controls.enabled = true;
    if (changed) { writeParams(readParams(), true); draw(); status('Handvat aangepast; het werkstuk wordt opnieuw opgebouwd. ↶ Terug zet het terug.'); commit(); }
    else hist.pop();
  };
  canvas.addEventListener('pointerup', up, { capture: true });
  canvas.addEventListener('pointercancel', up, { capture: true });

  return {
    start, stop, active: () => !!kind, kind: () => kind,
    // knoppen en invulvelden in het paneel: zelfde weg (voorbeeld + opnieuw opbouwen)
    changed(p, { rebuildNow = true } = {}) { record(); writeParams(p, true); if (kind) draw(); if (rebuildNow) { if (kind) commit(); else rebuild(ctx.kindNow()); } },
    undo() { const h = hist.pop(); if (!h) { status('Niets om terug te zetten aan het handvat.'); return false; } future.push(readParams()); writeParams(h, true); if (kind) draw(); status('Handvat teruggezet.'); commit2(); return true; },
    redo() { const h = future.pop(); if (!h) { status('Niets om opnieuw te doen aan het handvat.'); return false; } hist.push(readParams()); writeParams(h, true); if (kind) draw(); status('Handvat hersteld.'); commit2(); return true; },
    canUndo: () => hist.length > 0, canRedo: () => future.length > 0,
  };
  function commit2() { if (kind) commit(); else rebuild(ctx.kindNow()); }
}

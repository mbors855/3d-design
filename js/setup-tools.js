// Opstelgereedschap (v65): tandenbibliotheek importeren, beide kaken opstellen, selecteren per element/groep/kaak,
// slepen met de vinger terwijl de rij zich aanpast, naast elkaar zetten, morphen, draaien, live contactkleuren,
// virtuele articulator en inslijpen (automatisch en handmatig).
import * as THREE from 'three';
import { ArchRow, rowState, extents, moveAlong, packRow, groupOf, morph, rotateLocal } from './arrange.js';
import { contactsFor, clearContacts, contactSummary } from './contacts.js';
import { articulatorPoints, mandiblePose, excursionPoses, ARTICULATOR_DEFAULTS } from './articulator.js';
import { grindStep, brush, geometrySnapshot, restoreGeometry } from './grind.js';
import { readLibraryFiles, saveSets, listSets, deleteSet, loadSet, bowIdeal } from './library.js';
import { placeTeeth } from './setup.js';
import { FDI_UPPER, FDI_LOWER } from './teeth.js';
import { weld } from './mesh.js';

export function geometryFromMesh(mesh) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(mesh.positions), 3));
  g.setIndex(new THREE.BufferAttribute(Uint32Array.from(mesh.indices), 1));
  g.computeVertexNormals(); g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}
export function toothGeometry(t) { return geometryFromMesh(t.mesh ?? weld(t.soup, 1e-4)); }
export function geometrySoup(g) {
  const p = g.getAttribute('position').array, idx = g.index?.array, n = idx ? idx.length : p.length / 3, out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const v = (idx ? idx[i] : i) * 3; out[i * 3] = p[v]; out[i * 3 + 1] = p[v + 1]; out[i * 3 + 2] = p[v + 2]; }
  return out;
}

const SEL_COLOR = 0x5a3a00, PAIR_COLOR = 0x00466a;

export function initSetupTools(ctx) {
  const { S, viewer, $, num, fmt, status, toast, busy, jaw } = ctx;
  S.opp = S.opp || []; S.sel = new Set(); S.selMode = 'tooth'; S.repack = true; S.dragImmediate = false; S.liveContacts = true;
  S.midShift = { main: 0, opp: 0 }; S.grindHistory = []; S.artic = { kind: 'protrusion', amount: 0, params: { ...ARTICULATOR_DEFAULTS } };
  if (!viewer.groups.oppTeeth) { const g = new THREE.Group(); g.name = 'oppTeeth'; viewer.scene.add(g); viewer.groups.oppTeeth = g; }
  const canvas = viewer.canvas;

  // ---------- rijen en sets ----------
  const setOf = o => S.opp.includes(o) ? 'opp' : 'main';
  const teethOf = set => set === 'opp' ? S.opp : S.teeth;
  const allTeeth = () => [...S.teeth, ...S.opp];
  const otherJaw = j => j === 'upper' ? 'lower' : 'upper';
  function meanPlane() { const p = S.teeth.map(t => t.userData.planeHeight).filter(Number.isFinite); return p.length ? p.reduce((a, b) => a + b, 0) / p.length : (S.teethPlan?.plane ?? 10); }
  function oppFrame() {
    const f = S.frame, h = meanPlane();
    return { O: f.O.map((v, i) => v + f.N[i] * 2 * h), X: f.X.slice(), Y: f.Y.slice(), N: f.N.map(v => -v), width: f.width, depth: f.depth, swapped: f.swapped, jaw: otherJaw(f.jaw) };
  }
  // tegenkaakboog: de werkboog naar binnen (BK → OK) of naar buiten (OK → BK); front ~3 mm, zijdelings ~1 mm
  function oppCurve(mainCurve, mainJaw) {
    const n = 400, pts = []; for (let i = 0; i <= n; i++) pts.push(mainCurve(-1 + 2 * i / n));
    const cum = [0]; for (let i = 1; i <= n; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const mid = cum[n / 2], cy = pts[n / 2][1] - 30, sign = mainJaw === 'upper' ? -1 : 1, out = [];
    for (let i = 0; i <= n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n, i + 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1]; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
      let nx = ty, ny = -tx; if (pts[i][0] * nx + (pts[i][1] - cy) * ny < 0) { nx = -nx; ny = -ny; }
      const s = Math.abs(cum[i] - mid), off = s < 14 ? 3 : s > 24 ? 1 : 3 - 2 * (s - 14) / 10;
      out.push([pts[i][0] + sign * nx * off, pts[i][1] + sign * ny * off]);
    }
    return t => { const x = (t + 1) / 2 * n, i = Math.max(0, Math.min(n - 1, Math.floor(x))), f = x - i; return [out[i][0] + (out[i + 1][0] - out[i][0]) * f, out[i][1] + (out[i + 1][1] - out[i][1]) * f]; };
  }
  function rows() {
    if (!S.frame) return {};
    const curve = S.teethPlan?.curve ?? ctx.currentArchFn();
    if (!curve) return {};
    if (!S.rowCache || S.rowCache.frame !== S.frame || S.rowCache.curve !== curve) {
      S.rowCache = { frame: S.frame, curve, main: new ArchRow(S.frame, curve), opp: new ArchRow(oppFrame(), oppCurve(curve, S.frame.jaw)) };
    }
    return S.rowCache;
  }
  const rowFor = o => rows()[setOf(o)];

  // ---------- selectie ----------
  function highlight() {
    for (const t of allTeeth()) t.material.emissive?.setHex(S.sel.has(t) ? SEL_COLOR : S.pair === t ? PAIR_COLOR : 0x000000);
    renderSelInfo(); viewer.render();
  }
  function expand(obj) {
    if (!obj) return [];
    const set = teethOf(setOf(obj));
    if (S.selMode === 'tooth') return [obj];
    if (S.selMode === 'group') { const ids = groupOf(obj.userData.fdi, set.map(t => t.userData.fdi)); return set.filter(t => ids.includes(t.userData.fdi)); }
    if (S.selMode === 'jaw') return [...set];
    return allTeeth();
  }
  function select(list, { add = false } = {}) {
    if (!add) S.sel.clear();
    for (const o of list) S.sel.add(o);
    const primary = list[0] ?? null;
    ctx.setPrimary(primary);
    highlight();
  }
  function renderSelInfo() {
    const host = $('selInfo'); if (!host) return;
    const sel = [...S.sel];
    if (!sel.length) { host.textContent = 'Niets geselecteerd · tik een element (selectie per element, groep of kaak), houd vast en sleep om te verplaatsen.'; return; }
    const sc = sel[0].scale;
    host.textContent = `${sel.length === 1 ? 'Element ' + sel[0].userData.fdi : sel.length + ' elementen (' + sel.map(t => t.userData.fdi).sort((a, b) => a - b).join(', ') + ')'} · grootte ${Math.round(sc.x * 100)} / ${Math.round(sc.y * 100)} / ${Math.round(sc.z * 100)} % (breedte / hoogte / dikte)`;
  }

  // ---------- opstellen ----------
  async function librarySetting() {
    const v = $('toothLib').value;
    if (!v.startsWith('lib:')) return { library: v, librarySet: null };
    return { library: 'external', librarySet: await loadSet(v.slice(4)) };
  }
  function makeToothMesh(t, material) {
    const mesh = new THREE.Mesh(toothGeometry(t), material);
    mesh.geometry.computeBoundsTree();
    mesh.position.copy(t.position); mesh.quaternion.copy(t.quaternion);
    mesh.userData = { fdi: t.fdi, dims: t.dims, root: t.root, soup: t.soup, mesial: t.mesial, buccal: t.buccal, planeHeight: t.planeHeight };
    mesh.name = 'tand_' + t.fdi;
    return mesh;
  }
  async function buildOpp({ silent = false } = {}) {
    clearOpp();
    if (!S.teeth.length || !S.frame) throw Error('Stel eerst de werkkaak op.');
    const r = rows(), f = r.opp.frame, lib = await librarySetting();
    const ids = (f.jaw === 'upper' ? FDI_UPPER : FDI_LOWER).filter(id => {
      const t = id % 10; if (t === 8) return false;
      // spiegel de werkkaak: dezelfde elementtypen als in de werkkaak
      return S.teeth.some(m => m.userData.fdi % 10 === t);
    });
    const ideal = lib.librarySet && $('setupMode').value === 'ideal' ? bowIdeal(lib.librarySet, f.jaw) : null;
    const placed = placeTeeth(ids, f, {
      arch: r.opp.pts ? oppCurveFn(r.opp) : null, scale: num('toothScale') / 100, shape: $('anteriorShape').value, concept: $('concept').value,
      occlusalHeight: meanPlane(), gap: num('basisGap'), wall: num('basisWall'), library: lib.library, librarySet: lib.librarySet, ideal, rootMax: 3,
      custom: { spee: num('cSpee'), wilson: num('cWilson'), labial: num('cLabial'), cusp: num('cCusp') },
    }, null);
    for (const t of placed) { const m = makeToothMesh(t, ctx.toothMaterial()); m.userData.opp = true; viewer.groups.oppTeeth.add(m); S.opp.push(m); }
    packRow(r.opp, S.opp, { midShift: S.midShift.opp });
    occludeSets(S.opp, S.teeth, new THREE.Vector3(...f.N), num('occlClearance'));
    S.oppInitial = snapshot(S.opp);
    ctx.invalidate(); renderLists(); ctx.layers?.();
    if (!silent) status(`${S.opp.length} elementen in de tegenkaak opgesteld en in occlusie gebracht.`);
    if (S.liveContacts) refreshContacts();
  }
  function oppCurveFn(row) { // ArchRow → curve-functie (t ∈ [-1, 1])
    const n = row.pts.length - 1; return t => { const x = (t + 1) / 2 * n, i = Math.max(0, Math.min(n - 1, Math.floor(x))), fr = x - i; return [row.pts[i][0] + (row.pts[i + 1][0] - row.pts[i][0]) * fr, row.pts[i][1] + (row.pts[i + 1][1] - row.pts[i][1]) * fr]; };
  }
  function clearOpp() { for (const t of S.opp) { S.sel.delete(t); t.geometry.disposeBoundsTree?.(); t.geometry.dispose(); viewer.groups.oppTeeth.remove(t); } S.opp = []; renderLists(); }

  // Elementen langs dir (wereld, naar de tegenkaak) verschuiven tot ze de doelen raken.
  function occludeSets(objs, targets, dir, clearance = 0) {
    const ray = new THREE.Raycaster(); ray.firstHitOnly = true;
    const v = new THREE.Vector3(), o = new THREE.Vector3(), out = [];
    const vis = targets.map(t => t.visible); for (const t of targets) t.visible = true;
    for (const obj of objs) {
      obj.updateMatrixWorld();
      const pos = obj.geometry.getAttribute('position'), h = obj.userData.dims.height;
      let best = Infinity; const stride = Math.max(1, Math.floor(pos.count / 700));
      for (let i = 0; i < pos.count; i += stride) {
        if (pos.getY(i) < h * 0.45) continue;
        v.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld);
        o.copy(v).addScaledVector(dir, -15); ray.set(o, dir); ray.far = 40;
        const hit = ray.intersectObjects(targets, false)[0];
        if (hit) best = Math.min(best, hit.distance - 15);
      }
      if (Number.isFinite(best) && Math.abs(best) < 12) { obj.position.addScaledVector(dir, best - clearance); obj.updateMatrixWorld(); out.push(obj.userData.fdi); }
    }
    targets.forEach((t, i) => { t.visible = vis[i]; });
    return out;
  }

  // ---------- snapshots (undo) ----------
  function snapshot(list = allTeeth()) { return list.map(t => ({ fdi: t.userData.fdi, opp: !!t.userData.opp, p: t.position.toArray(), q: t.quaternion.toArray(), s: t.scale.toArray() })); }
  function applySnapshot(snap) {
    for (const s of snap) { const t = (s.opp ? S.opp : S.teeth).find(o => o.userData.fdi === s.fdi); if (t) { t.position.fromArray(s.p); t.quaternion.fromArray(s.q); if (s.s) t.scale.fromArray(s.s); t.updateMatrixWorld(); } }
    if (S.liveContacts) refreshContacts(); viewer.render(); renderSelInfo();
  }

  // ---------- contacten ----------
  function opponentsOf(o) {
    if (setOf(o) === 'opp') return S.teeth;
    return S.opp.length ? S.opp : (viewer.antagonistMesh ? [viewer.antagonistMesh] : []);
  }
  let contactTimer = null, contactBusy = false;
  function refreshContacts(objs = null, { stride = 1 } = {}) {
    const list = objs ?? allTeeth();
    if (!S.liveContacts && !objs) return [];
    const res = [];
    for (const o of list) { const opp = opponentsOf(o); if (opp.length) res.push(contactsFor(o, opp, { stride })); }
    // de tegenpartij van bewogen elementen ook bijwerken
    if (objs) { const others = new Set(); for (const o of objs) for (const x of opponentsOf(o)) if (x.userData?.fdi && !objs.includes(x)) others.add(x); for (const x of others) contactsFor(x, opponentsOf(x), { stride }); }
    viewer.render();
    const host = $('occlInfo'); if (host && res.length) host.textContent = 'Contact (kleinste afstand): ' + contactSummary(res) + '\nKleur: magenta/rood = penetratie · oranje = contact · geel < 0,05 · groen < 0,15 · blauw < 0,35 mm.';
    return res;
  }
  function liveContacts(objs) {
    if (!S.liveContacts) return;
    if (contactTimer || contactBusy) return;
    contactTimer = setTimeout(() => { contactTimer = null; contactBusy = true; try { refreshContacts(objs, { stride: objs.length > 3 ? 3 : 1 }); } finally { contactBusy = false; } }, 90);
  }

  // ---------- slepen met vinger of muis ----------
  const plane = new THREE.Plane(), ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), hitP = new THREE.Vector3();
  function rayAt(e) { const r = canvas.getBoundingClientRect(); ndc.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1); ray.setFromCamera(ndc, viewer.camera); return ray.ray; }
  function pickTooth(e) { const vis = allTeeth().filter(t => t.parent?.visible !== false); if (!vis.length) return null; return viewer.pick(e.clientX, e.clientY, vis); }
  let drag = null, pressTimer = null, pending = null;
  const active = () => S.step === 'opstelling' && S.mode === 'orbit' && !viewer.gizmo.dragging && !viewer.gizmo.axis;

  canvas.addEventListener('pointerdown', e => {
    if (S.mode === 'grind') return grindDown(e);
    if (!active() || e.button > 0 || !allTeeth().length || drag || pending) return;
    const hit = pickTooth(e); if (!hit) return;
    pending = { e, hit, id: e.pointerId, x: e.clientX, y: e.clientY };
    const immediate = e.pointerType !== 'touch' || S.dragImmediate || S.rotFinger;
    if (immediate) { startDrag(pending); e.stopImmediatePropagation(); }
    else pressTimer = setTimeout(() => { if (pending) { startDrag(pending); navigator.vibrate?.(15); } }, 300);
  }, { capture: true });
  canvas.addEventListener('pointermove', e => {
    if (S.mode === 'grind') return grindMove(e);
    if (pending && !drag && e.pointerId === pending.id && Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > 8) { clearTimeout(pressTimer); pending = null; return; } // gewoon draaien
    if (!drag || e.pointerId !== drag.id) return;
    e.stopImmediatePropagation();
    if (drag.rotate) return rotateDrag(e);
    if (!rayAt(e).intersectPlane(plane, hitP)) return;
    applyDrag(hitP.clone().sub(drag.start));
  }, { capture: true });
  const endDrag = e => {
    if (S.mode === 'grind') return grindUp(e);
    clearTimeout(pressTimer);
    if (pending && !drag) { pending = null; return; } // gewone tik → handleTap in main
    if (!drag || e.pointerId !== drag.id) return;
    e.stopImmediatePropagation();
    const d = drag; drag = null; pending = null; viewer.controls.enabled = true;
    if (!d.moved) { ctx.dropHistory(); tap(d.hit); return; }
    if (!d.rotate && S.repack && d.mode === 'row') {
      const r = rows()[d.set];
      if (d.members.length === 1) packRow(r, teethOf(d.set), { midShift: S.midShift[d.set] });
      else { packRow(r, teethOf(d.set), { fixed: new Set(d.members) }); updateMidShift(d.set); }
    }
    if (S.liveContacts) refreshContacts();
    renderSelInfo(); viewer.render(); status(d.rotate ? 'Gedraaid.' : 'Verplaatst.' + (S.repack && d.mode === 'row' ? ' De rij is weer aangesloten.' : ''));
  };
  canvas.addEventListener('pointerup', endDrag, { capture: true });
  canvas.addEventListener('pointercancel', endDrag, { capture: true });

  function startDrag(p) {
    pending = null;
    const obj = p.hit.object;
    if (!S.sel.has(obj)) select(expand(obj));
    const members = [...S.sel].filter(t => setOf(t) === setOf(obj));
    const set = setOf(obj), r = rows()[set];
    if (!r) return;
    ctx.pushHistory();
    viewer.controls.enabled = false;
    plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(...S.frame.N), p.hit.point);
    drag = { id: p.id, hit: p.hit, obj, set, members, start: p.hit.point.clone(), sx: p.x, sy: p.y, moved: false, rotate: !!S.rotFinger,
      mode: S.selMode === 'jaw' || S.selMode === 'all' ? 'rigid' : 'row',
      base: members.map(t => ({ t, p: t.position.clone(), q: t.quaternion.clone(), st: rowState(r, t) })), anchor: rowState(r, obj) };
    if (S.selMode === 'all') drag.members = allTeeth(), drag.base = drag.members.map(t => ({ t, p: t.position.clone(), q: t.quaternion.clone(), st: rowState(rowFor(t), t) }));
    status(drag.rotate ? 'Draaien: sleep horizontaal.' : 'Slepen: de rij past zich aan. Laat los om te plaatsen.');
  }
  function applyDrag(delta) {
    const d = drag; d.moved = true;
    for (const b of d.base) { b.t.position.copy(b.p); b.t.quaternion.copy(b.q); b.t.updateMatrix(); }
    if (d.mode === 'rigid') { for (const b of d.base) { b.t.position.add(delta); b.t.updateMatrixWorld(); } }
    else {
      const r = rows()[d.set], a = d.anchor, f = r.at(a.s);
      const base2 = [f.p[0] + f.n[0] * a.d, f.p[1] + f.n[1] * a.d];
      const dx = delta.dot(new THREE.Vector3(...S.frame.X)), dy = delta.dot(new THREE.Vector3(...S.frame.Y));
      const pr = r.project(base2[0] + dx, base2[1] + dy), ds = pr.s - a.s, dd = pr.d - a.d;
      for (const b of d.base) moveAlong(r, b.t, b.st.s + ds, b.st.d + dd);
      if (S.repack) {
        if (d.members.length === 1) packRow(r, teethOf(d.set), { float: d.obj, midShift: S.midShift[d.set] });
        else packRow(r, teethOf(d.set), { fixed: new Set(d.members) });
      }
    }
    viewer.render();
    liveContacts(d.mode === 'rigid' ? d.members : teethOf(d.set));
  }
  function rotateDrag(e) {
    const d = drag; d.moved = true;
    const ang = (e.clientX - d.sx) * 0.35;
    for (const b of d.base) { b.t.quaternion.copy(b.q); turn(b.t, S.rotFinger, ang); }
    viewer.render(); liveContacts(d.members);
  }
  function updateMidShift(set) {
    const r = rows()[set], c = teethOf(set).filter(t => t.userData.fdi % 10 === 1);
    if (c.length === 2) { const e = c.map(t => extents(r, t)).sort((a, b) => a.s - b.s); S.midShift[set] = (e[0].s + e[0].hi + e[1].s + e[1].lo) / 2; }
  }
  // draaien met teken: 'tip' = naar mesiaal (+), 'torque' = kroon naar buccaal (+), 'axis' = om de lengteas
  function turn(t, kind, deg) {
    if (kind === 'axis') return rotateLocal(t, 'y', deg);
    if (kind === 'torque') return rotateLocal(t, 'x', deg);
    const r = rowFor(t), st = rowState(r, t), f = r.at(st.s);
    const T = r.frame, tan = new THREE.Vector3(...[0, 1, 2].map(i => T.X[i] * f.t[0] + T.Y[i] * f.t[1]));
    const mesial = st.s > 0 ? tan.clone().negate() : tan; // naar de middellijn
    const lx = new THREE.Vector3(1, 0, 0).applyQuaternion(t.quaternion);
    rotateLocal(t, 'z', -Math.sign(lx.dot(mesial) || 1) * deg);
  }

  // ---------- tikken ----------
  function tap(hit) {
    const obj = hit?.object;
    if (S.placeFdi) return placeManual(hit);
    if (S.pairMode) {
      if (!obj) { S.pair = null; highlight(); return; }
      if (!S.pair) { S.pair = obj; select([]); status(`Tik nu het element waarnaast ${obj.userData.fdi} moet staan (tik op de mesiale of distale helft).`); highlight(); return; }
      const a = S.pair, b = obj; S.pair = null;
      if (a === b || setOf(a) !== setOf(b)) { highlight(); return status('Kies een element in dezelfde kaak.', true); }
      ctx.pushHistory();
      const r = rowFor(a), eb = extents(r, b), ea = extents(r, a), [hx, hy] = r.to2D(hit.point.toArray()), side = r.project(hx, hy).s >= eb.s ? 1 : -1;
      moveAlong(r, a, side > 0 ? eb.s + eb.hi - ea.lo + 0.01 : eb.s + eb.lo - ea.hi - 0.01);
      packRow(r, teethOf(setOf(a)), { midShift: S.midShift[setOf(a)] });
      if (S.liveContacts) refreshContacts();
      select([a]); status(`${a.userData.fdi} staat nu naast ${b.userData.fdi}.`); return;
    }
    if (obj) select(expand(obj)); else select([]);
  }
  function handleTap(e) { // vanuit main (gewone tik zonder slepen)
    if (S.step !== 'opstelling') return false;
    const hit = pickTooth(e);
    if (S.placeFdi) { placeManual(hit ?? viewer.pick(e.clientX, e.clientY)); return true; }
    if (!hit && !S.pairMode) { if (allTeeth().length) select([]); return false; }
    tap(hit); return true;
  }

  // ---------- handmatig opstellen: element kiezen, op de kam tikken ----------
  async function placeManual(hit) {
    const fdi = S.placeFdi; if (!fdi) return;
    if (!S.frame) return status('Zet eerst de referentiepunten (stap Analyse).', true);
    const point = hit?.point; if (!point) return status('Tik op de kam of op de opstelling.', true);
    const upperMain = S.frame.jaw === 'upper', isUpper = Math.floor(fdi / 10) <= 2, set = isUpper === upperMain ? 'main' : 'opp';
    if (set === 'opp' && !S.teeth.length) return status('Plaats eerst elementen in de werkkaak.', true);
    const r = rows()[set], lib = await librarySetting();
    const [x, y] = r.to2D(point.toArray()), pr = r.project(x, y);
    const placed = placeTeeth([fdi], r.frame, { arch: oppCurveFn(r), scale: num('toothScale') / 100, shape: $('anteriorShape').value, concept: $('concept').value, occlusalHeight: meanPlaneOr(set), gap: num('basisGap'), wall: num('basisWall'), library: lib.library, librarySet: lib.librarySet, ideal: lib.librarySet ? bowIdeal(lib.librarySet, r.frame.jaw) : null, rootMax: set === 'main' ? Infinity : 3 }, set === 'main' ? viewer.scanMesh : null)[0];
    if (!placed) return status(`Element ${fdi} zit niet in deze bibliotheek.`, true);
    ctx.pushHistory();
    const list = teethOf(set), old = list.find(t => t.userData.fdi === fdi);
    if (old) { list.splice(list.indexOf(old), 1); old.parent.remove(old); }
    const m = makeToothMesh(placed, ctx.toothMaterial()); if (set === 'opp') m.userData.opp = true;
    (set === 'opp' ? viewer.groups.oppTeeth : viewer.groups.teeth).add(m); list.push(m);
    moveAlong(r, m, pr.s);
    if (set === 'opp') occludeSets([m], S.teeth, new THREE.Vector3(...r.frame.N), num('occlClearance'));
    if (S.repack) packRow(r, list, { midShift: S.midShift[set] });
    ctx.invalidate(); renderLists(); ctx.afterTeethChange?.();
    // volgende element in de rij voorstellen
    const order = (isUpper ? FDI_UPPER : FDI_LOWER).filter(f => f % 10 !== 8);
    const next = order.find(f => !list.some(t => t.userData.fdi === f) && Math.floor(f / 10) === Math.floor(fdi / 10)) ?? order.find(f => !list.some(t => t.userData.fdi === f));
    setPlace(next ?? null);
    select([m]); if (S.liveContacts) refreshContacts();
  }
  function meanPlaneOr(set) { return set === 'main' ? (S.teeth.length ? meanPlane() : num('occlHeight')) : meanPlane(); }
  function setPlace(fdi) { S.placeFdi = fdi; renderLists(); status(fdi ? `Handmatig: tik op de kam waar element ${fdi} moet komen.` : 'Handmatig plaatsen klaar.'); }

  function renderLists() {
    const host = $('placeList'); if (!host) return;
    host.innerHTML = '';
    if (!S.frame) { host.innerHTML = '<span class="sub">Eerst referentiepunten zetten.</span>'; return; }
    const main = S.frame.jaw === 'upper' ? FDI_UPPER : FDI_LOWER, opp = S.frame.jaw === 'upper' ? FDI_LOWER : FDI_UPPER;
    for (const [ids, list, label] of [[main, S.teeth, 'Werkkaak'], [opp, S.opp, 'Tegenkaak']]) {
      const row = document.createElement('div'); row.className = 'toothrow placerow'; row.title = label;
      for (const f of ids) {
        const b = document.createElement('button'); b.textContent = f; b.className = 'tooth';
        b.classList.toggle('placed', list.some(t => t.userData.fdi === f)); b.setAttribute('aria-pressed', String(S.placeFdi === f));
        b.onclick = () => setPlace(S.placeFdi === f ? null : f);
        row.appendChild(b);
      }
      host.appendChild(row);
    }
  }

  // ---------- articulator ----------
  function lowerGroups() {
    const g = viewer.groups;
    return S.frame?.jaw === 'lower' ? [g.scan, g.wax, g.plates, g.teeth] : [g.antagonist, g.oppTeeth];
  }
  function incisalPoint() {
    const upperSet = S.frame.jaw === 'upper' ? S.teeth : S.opp;
    const c = upperSet.filter(t => t.userData.fdi % 10 === 1);
    const N = new THREE.Vector3(...S.frame.N), up = S.frame.jaw === 'upper' ? N : N.clone().negate(); // naar occlusaal van de bovenkaak = omlaag
    if (c.length) {
      const pts = c.map(t => { t.updateMatrixWorld(); const pos = t.geometry.getAttribute('position'), v = new THREE.Vector3(); let best = null, bd = -Infinity; for (let i = 0; i < pos.count; i += 7) { v.fromBufferAttribute(pos, i).applyMatrix4(t.matrixWorld); const d = v.dot(up); if (d > bd) { bd = d; best = v.clone(); } } return best; });
      return pts.reduce((a, b) => a.add(b), new THREE.Vector3()).multiplyScalar(1 / pts.length).toArray();
    }
    const r = rows().main, f = r.at(0); return r.to3D(f.p[0], f.p[1], meanPlane());
  }
  function articPoints() { return articulatorPoints(S.frame, incisalPoint(), S.frame.jaw, S.artic.params); }
  function setPose(M) {
    for (const g of lowerGroups()) { g.matrixAutoUpdate = false; g.matrix.copy(M); g.matrixWorldNeedsUpdate = true; g.updateMatrixWorld(true); }
  }
  function centric() { setPose(new THREE.Matrix4()); S.artic.amount = 0; if ($('articAmount')) $('articAmount').value = 0; updateArticLabel(); }
  function poseFor(kind, amount, pts = articPoints()) { return mandiblePose(pts, kind, amount, S.artic.params); }
  function updateArticLabel() { const l = $('articLabel'); if (l) l.textContent = S.artic.kind === 'open' ? `${fmt(S.artic.amount, 0)}°` : `${fmt(S.artic.amount, 1)} mm`; }
  function articRequire() { if (!S.frame || !S.teeth.length) throw Error('Stel eerst de tanden op.'); if (!S.opp.length && !viewer.antagonistMesh) throw Error('Nodig: tegenkaak-elementen of een antagonistscan.'); }
  let anim = null;
  function play() {
    if (anim) { cancelAnimationFrame(anim.raf); anim = null; $('articPlay').textContent = '▶ Afspelen'; return; }
    articRequire();
    const max = S.artic.kind === 'open' ? 15 : num('articMax'), pts = articPoints(), t0 = performance.now(), dur = 2400;
    $('articPlay').textContent = '⏸ Stop';
    const stepF = now => {
      const ph = ((now - t0) % dur) / dur, a = max * Math.sin(Math.PI * ph);
      S.artic.amount = a; $('articAmount').value = a / max * 100; updateArticLabel();
      setPose(poseFor(S.artic.kind, a, pts));
      if (S.liveContacts) refreshContacts(lowerSetObjs(), { stride: 4 }); else viewer.render();
      anim.raf = requestAnimationFrame(stepF);
    };
    anim = { raf: requestAnimationFrame(stepF) };
  }
  const lowerSetObjs = () => S.frame.jaw === 'lower' ? S.teeth : S.opp;
  const upperSetObjs = () => S.frame.jaw === 'upper' ? S.teeth : S.opp;
  // Bewegingscontacten: kleinste afstand over alle standen van de gekozen bewegingen (centrisch inbegrepen).
  function pathContacts() {
    articRequire();
    const pts = articPoints(), kinds = [...document.querySelectorAll('[data-path]:checked')].map(i => i.dataset.path);
    const poses = [{ matrix: new THREE.Matrix4() }, ...excursionPoses(pts, { protrusion: num('articMax'), lateral: num('articMax'), steps: 5, kinds }, S.artic.params)];
    const objs = allTeeth(), acc = new Map(objs.map(o => [o, new Float32Array(o.geometry.getAttribute('position').count).fill(Infinity)]));
    for (const p of poses) {
      setPose(p.matrix);
      for (const o of objs) { const opp = opponentsOf(o); if (opp.length) contactsFor(o, opp, { stride: 2, color: false, minOut: acc.get(o) }); }
    }
    setPose(new THREE.Matrix4());
    const res = objs.map(o => { const opp = opponentsOf(o); return opp.length ? contactsFor(o, [], { stride: 1, minOut: acc.get(o) }) : null; });
    viewer.render();
    $('occlInfo').textContent = `Bewegingscontacten (${kinds.join(', ') || 'alleen centrisch'}; ${poses.length} standen): ` + contactSummary(res) + '\nRood/magenta = interferentie ergens in de beweging; oranje = contact.';
  }

  // ---------- inslijpen ----------
  function grindTargets() {
    const which = $('grindTarget').value, low = lowerSetObjs(), up = upperSetObjs();
    if (which === 'lower') return [[low, opponentsOf(low[0] ?? up[0]), 1]];
    if (which === 'upper') return [[up, upperOpp(), 1]];
    return [[low, opponentsOf(low[0] ?? up[0]), 0.5], [up, upperOpp(), 0.5]];
  }
  function upperOpp() { const up = upperSetObjs(); return up.length ? opponentsOf(up[0]) : []; }
  async function autoGrind(withMovements) {
    articRequire();
    const groups = grindTargets().filter(([t, o]) => t.length && o.length);
    if (!groups.length) throw Error('Niets in te slijpen: kies elementen met een tegenpartij.');
    pushGrind(groups.flatMap(g => g[0]));
    const pts = articPoints(), clearance = num('grindClearance');
    const poses = [{ matrix: new THREE.Matrix4(), kind: 'centric' }];
    if (withMovements) poses.push(...excursionPoses(pts, { protrusion: num('articMax'), lateral: num('articMax'), steps: 4, kinds: [...document.querySelectorAll('[data-path]:checked')].map(i => i.dataset.path) }, S.artic.params));
    let verts = 0, maxD = 0;
    const budget = new Map(), maxTotal = num('grindMax'), front = $('grindFront').checked;
    for (let k = 0; k < poses.length; k++) {
      setPose(poses[k].matrix);
      // in de bewegingen het front alleen slijpen als dat is aangevinkt (frontgeleiding los je op in de opstelling)
      for (const [t, o, share] of groups) { const list = k === 0 || front ? t : t.filter(x => x.userData.fdi % 10 >= 4); const r = grindStep(list, o, { share, clearance, budget, maxTotal }); verts += r.verts; maxD = Math.max(maxD, r.maxDepth); }
      await new Promise(r => setTimeout(r, 0));
    }
    setPose(new THREE.Matrix4());
    ctx.invalidate();
    refreshContacts(allTeeth());
    const capped = [...budget.values()].reduce((n, u) => n + u.filter(x => x >= maxTotal - 1e-3).length, 0);
    status(verts ? `Ingeslepen: ${verts} punten aangepast, diepste interferentie ${fmt(maxD, 2)} mm (${poses.length} standen)${capped ? ` · ${capped} punten op het maximum van ${fmt(maxTotal, 1)} mm: pas daar de opstelling of geleiding aan` : ''}.` : 'Geen interferenties gevonden: niets ingeslepen.');
  }
  function pushGrind(objs) { S.grindHistory.push(geometrySnapshot(objs)); if (S.grindHistory.length > 8) S.grindHistory.shift(); for (const o of objs) o.userData.ground = true; }
  // handmatig slijpen
  let grinding = null;
  function grindDown(e) {
    if (e.button > 0) return;
    const hit = pickTooth(e); if (!hit) return; // buiten de tand: gewoon draaien
    e.stopImmediatePropagation(); viewer.controls.enabled = false;
    pushGrind([hit.object]);
    grinding = { id: e.pointerId, obj: hit.object };
    grindAt(hit);
  }
  function grindMove(e) { if (!grinding || e.pointerId !== grinding.id) return; e.stopImmediatePropagation(); const hit = viewer.pick(e.clientX, e.clientY, [grinding.obj]); if (hit) grindAt(hit); }
  function grindUp(e) { if (!grinding || e.pointerId !== grinding.id) return; e.stopImmediatePropagation(); viewer.controls.enabled = true; const o = grinding.obj; grinding = null; ctx.invalidate(); refreshContacts([o]); }
  let grindQueued = false;
  function grindAt(hit) {
    brush(hit.object, hit.point, { radius: num('grindRadius'), depth: num('grindStrength') / 100, mode: $('grindMode').value });
    if (!grindQueued) { grindQueued = true; requestAnimationFrame(() => { grindQueued = false; if (grinding) refreshContacts([grinding.obj], { stride: 1 }); else viewer.render(); }); }
  }

  // ---------- bibliotheek-UI ----------
  async function refreshLibraryOptions(selectName = null) {
    const sel = $('toothLib'), keep = selectName ? 'lib:' + selectName : sel.value;
    for (const o of [...sel.querySelectorAll('option[data-lib]')]) o.remove();
    const sets = await listSets();
    let grp = sel.querySelector('optgroup[data-libgroup]');
    if (!grp) { grp = document.createElement('optgroup'); grp.label = 'Geïmporteerde bibliotheken'; grp.dataset.libgroup = '1'; sel.appendChild(grp); }
    grp.innerHTML = '';
    for (const s of sets) { const o = document.createElement('option'); o.value = 'lib:' + s.name; o.dataset.lib = '1'; o.textContent = `${s.name} (${s.upper + s.lower} elementen${s.bow ? ', ideale opstelling' : ''})`; grp.appendChild(o); }
    grp.hidden = !sets.length;
    if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
    const host = $('libList');
    if (host) host.innerHTML = sets.length ? sets.map(s => `<div class="librow"><span class="grow">${s.name}<span class="sub"> · BK ${s.upper} · OK ${s.lower} · ${(s.bytes / 1048576).toFixed(0)} MB</span></span><button type="button" class="mini" data-libdel="${s.name}" title="Verwijder van dit apparaat">🗑</button></div>`).join('') : '<span class="sub">Nog geen bibliotheek op dit apparaat.</span>';
  }
  async function importLibrary(files) {
    const pw = $('libPassword').value || null;
    const prog = $('libProgress');
    let sets;
    try {
      sets = await readLibraryFiles(files, { password: pw, onProgress: (f, name) => { prog.textContent = `${Math.round(f * 100)} % · ${String(name).split('/').slice(-3).join('/')}`; } });
    } catch (err) {
      if (err.code === 'PASSWORD') { $('libPassword').focus(); throw Error(pw ? 'Onjuist wachtwoord. Controleer het wachtwoord van de ZIP.' : 'Deze ZIP is versleuteld. Vul het wachtwoord in en kies het bestand opnieuw.'); }
      throw err;
    }
    prog.textContent = `${sets.length} sets gevonden, opslaan op dit apparaat…`;
    await saveSets(sets, files[0]?.name ?? '');
    await refreshLibraryOptions(sets[0].name);
    prog.textContent = `${sets.length} sets geïmporteerd: ${sets.map(s => s.name).join(', ')}. Ze staan alleen op dit apparaat.`;
    status(`Bibliotheek geïmporteerd (${sets.length} sets). Kies hem bij Tandvormen en tik op Stel tanden op.`);
  }
  $('libFile')?.addEventListener('change', e => { const f = [...(e.target.files || [])]; e.target.value = ''; if (f.length) busy('Bibliotheek importeren…', () => importLibrary(f)); });
  $('libFolder')?.addEventListener('change', e => { const f = [...(e.target.files || [])]; e.target.value = ''; if (f.length) busy('Bibliotheek importeren…', () => importLibrary(f)); });
  $('libList')?.addEventListener('click', e => { const b = e.target.closest('[data-libdel]'); if (!b) return;
    // twee keer tikken om te bevestigen (geen browserdialoog: werkt ook in ingesloten weergaven)
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Zeker?'; setTimeout(() => { delete b.dataset.armed; b.textContent = '🗑'; }, 3000); return; } busy('Verwijderen…', async () => { await deleteSet(b.dataset.libdel); await refreshLibraryOptions(); }); });
  refreshLibraryOptions();

  // ---------- knoppen ----------
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  for (const b of document.querySelectorAll('[data-selmode]')) b.onclick = () => { S.selMode = b.dataset.selmode; for (const x of document.querySelectorAll('[data-selmode]')) x.setAttribute('aria-pressed', String(x === b)); const first = [...S.sel][0]; if (first) select(expand(first)); };
  const toggle = (id, key, after) => on(id, () => { S[key] = !S[key]; $(id).setAttribute('aria-pressed', String(S[key])); after?.(); });
  toggle('dragImmediate', 'dragImmediate');
  toggle('repackToggle', 'repack');
  toggle('liveContacts', 'liveContacts', () => { if (S.liveContacts) refreshContacts(); else { clearContacts(allTeeth()); viewer.render(); } });
  on('pairMode', () => { S.pairMode = !S.pairMode; S.pair = null; $('pairMode').setAttribute('aria-pressed', String(S.pairMode)); highlight(); status(S.pairMode ? 'Naast elkaar zetten: tik eerst het element dat moet verhuizen, dan de buur.' : 'Naast elkaar zetten uit.'); });
  on('packNow', () => { if (!allTeeth().length) return; ctx.pushHistory(); const r = rows(); packRow(r.main, S.teeth, { midShift: S.midShift.main }); if (S.opp.length) packRow(r.opp, S.opp, { midShift: S.midShift.opp }); if (S.liveContacts) refreshContacts(); status('Alle elementen aangesloten (approximale contacten), middellijn behouden.'); });
  on('oppBuild', () => busy('Tegenkaak opstellen…', () => buildOpp()));
  on('oppClear', () => { clearOpp(); ctx.invalidate(); viewer.render(); });
  on('oppOcclude', () => busy('Occlusie zoeken…', async () => { if (!S.opp.length) throw Error('Stel eerst de tegenkaak op.'); ctx.pushHistory(); const f = rows().opp.frame; occludeSets(S.opp, S.teeth, new THREE.Vector3(...f.N), num('occlClearance')); refreshContacts(allTeeth()); }));
  const sel = () => { const l = [...S.sel]; if (!l.length) throw Error('Selecteer eerst een of meer elementen.'); return l; };
  const act = (fn, msg) => () => { try { const l = sel(); ctx.pushHistory(); for (const t of l) fn(t); if (S.repack && ['morph'].includes(msg)) { const r = rows(); for (const set of ['main', 'opp']) if (l.some(t => setOf(t) === set)) packRow(r[set], teethOf(set), { midShift: S.midShift[set] }); } renderSelInfo(); if (S.liveContacts) refreshContacts(); viewer.render(); } catch (err) { status(err.message, true); } };
  for (const b of document.querySelectorAll('[data-morph]')) { const [axis, f] = b.dataset.morph.split(':'), k = Number(f); b.onclick = act(t => axis === 'all' ? morph(t, k) : axis === 'w' ? morph(t, k, 1, 1) : axis === 'h' ? morph(t, 1, k, 1) : morph(t, 1, 1, k), 'morph'); }
  on('morphReset', act(t => { t.scale.set(1, 1, 1); t.updateMatrixWorld(); }, 'morph'));
  for (const b of document.querySelectorAll('[data-turn]')) { const [kind, deg] = b.dataset.turn.split(':'); b.onclick = act(t => turn(t, kind, Number(deg)), 'turn'); }
  for (const b of document.querySelectorAll('[data-rotfinger]')) b.onclick = () => { S.rotFinger = S.rotFinger === b.dataset.rotfinger ? null : b.dataset.rotfinger; for (const x of document.querySelectorAll('[data-rotfinger]')) x.setAttribute('aria-pressed', String(x.dataset.rotfinger === S.rotFinger)); status(S.rotFinger ? 'Draaien met de vinger: sleep horizontaal over een element.' : 'Slepen verplaatst weer.'); };
  for (const b of document.querySelectorAll('[data-artic]')) b.onclick = () => { S.artic.kind = b.dataset.artic; for (const x of document.querySelectorAll('[data-artic]')) x.setAttribute('aria-pressed', String(x === b)); applyArticSlider(); };
  function applyArticSlider() { try { articRequire(); } catch (err) { return status(err.message, true); } const max = S.artic.kind === 'open' ? 15 : num('articMax'); S.artic.amount = num('articAmount') / 100 * max; updateArticLabel(); setPose(poseFor(S.artic.kind, S.artic.amount)); if (S.liveContacts) refreshContacts(lowerSetObjs(), { stride: 2 }); else viewer.render(); }
  $('articAmount')?.addEventListener('input', applyArticSlider);
  on('articPlay', () => { try { play(); } catch (err) { status(err.message, true); } });
  on('articCentric', () => { if (anim) play(); centric(); if (S.liveContacts) refreshContacts(); viewer.render(); });
  on('articPaths', () => busy('Bewegingscontacten berekenen…', async () => pathContacts()));
  for (const id of ['artCondylar', 'artBennett', 'artShift', 'artIncisal', 'artLateral']) $(id)?.addEventListener('change', () => { const P = S.artic.params; P.condylar = num('artCondylar'); P.bennett = num('artBennett'); P.sideShift = num('artShift'); P.incisal = num('artIncisal'); P.lateralIncisal = num('artLateral'); });
  on('grindAuto', () => busy('Inslijpen (centrisch)…', () => autoGrind(false)));
  on('grindAutoMove', () => busy('Inslijpen (centrisch + bewegingen)…', () => autoGrind(true)));
  on('grindManual', () => { const onNow = S.mode !== 'grind'; ctx.setMode(onNow ? 'grind' : 'orbit'); $('grindManual').setAttribute('aria-pressed', String(onNow)); if (onNow) { centric(); status('Handmatig inslijpen: sleep over een element. Buiten de elementen draai je het beeld.'); } });
  on('grindUndo', () => { const s = S.grindHistory.pop(); if (!s) return status('Niets om terug te zetten.', true); restoreGeometry(s); ctx.invalidate(); refreshContacts(); });

  return {
    handleTap, select, expand, refreshContacts, clearContacts: () => { clearContacts(allTeeth()); viewer.render(); },
    snapshot, applySnapshot, buildOpp, clearOpp, rows, renderLists, centric, refreshLibraryOptions, setOf,
    allTeeth, librarySetting, makeToothMesh, occludeSets, packMain: () => packRow(rows().main, S.teeth, { midShift: S.midShift.main }),
    resetRows: () => { S.rowCache = null; S.midShift = { main: 0, opp: 0 }; },
    onStep: id => { if (id !== 'opstelling') { if (anim) play(); centric(); if (S.mode === 'grind') { ctx.setMode('orbit'); $('grindManual')?.setAttribute('aria-pressed', 'false'); } S.placeFdi = null; } renderLists(); },
  };
}

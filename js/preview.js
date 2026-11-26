// v72: 3D-voorbeeld van het STL-bestand, zoals het geëxporteerd wordt.
// Eigen venster (op de telefoon schermvullend) met een eigen 3D-weergave: draaien met één vinger, zoomen met twee,
// vaste aanzichten, de scan erbij ter controle van de pasvorm, een doorsnede om de wanddikte te bekijken en direct
// downloaden of delen. Getoond wordt het bestand zelf: de driehoeken worden eerst als STL geschreven en weer ingelezen.
import * as THREE from 'three';
import { Viewer, makeMesh, COLORS } from './viewer.js';
import { writeSTL, parseSTL } from './stl.js';
import { weld, quality } from './mesh.js';

/**
 * outputs: [{ key, label, files: () => [[naam, soup], …] }] (beschikbare uitvoer); start: key om mee te beginnen.
 * ctx: { scan (soup of null), axis (occlusale richting of null), fmt, int, onDownload(key), onShare(key) }
 */
export function openStlPreview(outputs, start, ctx) {
  if (!outputs.length) return null;
  document.getElementById('stlPreview')?.remove();
  const box = document.createElement('div');
  box.id = 'stlPreview'; box.className = 'pv-modal'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', '3D-voorbeeld van het STL-bestand');
  box.innerHTML = `
    <div class="pv-head"><b>🔍 3D-voorbeeld</b><select class="pv-file" aria-label="Bestand"></select><button type="button" class="pv-close" title="Sluiten (Esc)" aria-label="Sluiten">✕</button></div>
    <div class="pv-view"></div>
    <div class="pv-info"></div>
    <div class="pv-tools">
      <div class="seg" role="group" aria-label="Aanzicht"><button type="button" data-v="occlusal">Occlusaal</button><button type="button" data-v="front">Frontaal</button><button type="button" data-v="side">Zijkant</button><button type="button" data-v="under">Onderkant</button></div>
      <label class="check"><input type="checkbox" class="pv-scan"> Scan tonen</label>
      <label class="pv-cutl">Doorsnede <input type="range" class="pv-cut" min="0" max="100" value="100" aria-label="Doorsnede"></label>
      <div class="actions"><button type="button" class="pv-dl">↓ Download</button><button type="button" class="pv-share primary">📤 Delen</button></div>
    </div>`;
  document.body.appendChild(box);
  const q = sel => box.querySelector(sel);
  for (const o of outputs) { const op = document.createElement('option'); op.value = o.key; op.textContent = o.label; q('.pv-file').appendChild(op); }
  const viewer = new Viewer(q('.pv-view'));
  viewer.renderer.localClippingEnabled = true;
  const plane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
  let mesh = null, scanMesh = null, cur = null, bounds = null, axes = null;
  const up = ctx.axis ?? [0, 0, 1];

  function show(key) {
    const o = outputs.find(x => x.key === key) ?? outputs[0]; cur = o;
    q('.pv-file').value = o.key;
    for (const m of [mesh, scanMesh]) if (m) { m.parent?.remove(m); m.geometry.dispose(); m.material.dispose(); }
    mesh = null; scanMesh = null;
    // het bestand zelf: schrijven en weer inlezen (wat je ziet is wat je krijgt)
    const files = o.files(); let bytes = 0; const parts = [];
    for (const [name, soup] of files) { const buf = writeSTL(soup, name); bytes += buf.byteLength; parts.push(parseSTL(buf)); }
    const n = parts.reduce((s, p) => s + p.length, 0), soup = new Float32Array(n); let off = 0; for (const p of parts) { soup.set(p, off); off += p.length; }
    const color = { monoblock: COLORS.plate.basis, scan: 0xd9d2c8, antagonist: COLORS.antagonist }[o.key] ?? COLORS.plate[o.key] ?? (o.key.startsWith('elem') || o.key === 'losse' || o.key === 'tegenkaak' ? COLORS.tooth : COLORS.plate.basis);
    mesh = makeMesh(soup, color, { roughness: 0.4, side: THREE.DoubleSide });
    mesh.material.clippingPlanes = [plane];
    viewer.groups.plates.add(mesh);
    if (ctx.scan && !['scan', 'steg', 'antagonist'].includes(o.key)) {
      scanMesh = makeMesh(ctx.scan, 0xd9d2c8, { opacity: 0.35, roughness: 0.8 });
      scanMesh.material.depthWrite = false; scanMesh.material.clippingPlanes = [plane]; scanMesh.visible = q('.pv-scan').checked;
      viewer.groups.scan.add(scanMesh);
    }
    bounds = new THREE.Box3().setFromObject(mesh);
    viewer.bounds = bounds.clone();
    const a = new THREE.Vector3(...up).normalize(), c = bounds.getCenter(new THREE.Vector3());
    axes = { a, c, front: frontVector(mesh, a, c) }; axes.side = new THREE.Vector3().crossVectors(a, axes.front).normalize();
    const pr = mesh.geometry.getAttribute('position'); let lo = Infinity, hi = -Infinity; const t = new THREE.Vector3();
    for (let i = 0; i < pr.count; i += Math.max(1, Math.floor(pr.count / 20000))) { const d = t.fromBufferAttribute(pr, i).dot(axes.side); lo = Math.min(lo, d); hi = Math.max(hi, d); }
    axes.lo = lo; axes.hi = hi;
    setCut(); setView('front');
    // gegevens van het bestand
    const m = weld(soup, 1e-6), qq = quality(m), size = bounds.getSize(new THREE.Vector3());
    // zelfde maat als de productielijst: platte driehoekjes van het samenvoegen tellen niet als 'open'
    const closed = (qq.watertight || (qq.open === 0 && qq.flipped === 0)) && qq.nonManifold === 0;
    q('.pv-info').innerHTML = '';
    const line = document.createElement('div');
    line.textContent = `${files.length > 1 ? `${files.length} bestanden` : files[0][0].replace(/^.*\//, '')} · ${ctx.fmt(size.x)} × ${ctx.fmt(size.y)} × ${ctx.fmt(size.z)} mm · ${ctx.fmt(Math.abs(qq.volume) / 1000, 2)} ml · ${ctx.int(n / 9)} driehoeken · ${ctx.fmt(bytes / 1048576, 1)} MB`;
    const st = document.createElement('div'); st.className = closed ? 'ok' : 'warn';
    st.textContent = closed ? `✓ Gesloten en manifold${qq.components > 1 ? ` (${qq.components} delen)` : ''} · klaar voor de slicer` : `⚠ Niet volledig gesloten (${qq.open} open randen, ${qq.nonManifold} niet-manifold)`;
    q('.pv-info').append(line, st);
  }
  // doorsnede: een vlak loodrecht op links-rechts schuift van de ene naar de andere kant (100 = alles zichtbaar)
  function setCut() {
    if (!axes) return;
    const t = +q('.pv-cut').value / 100, d = axes.lo + (axes.hi - axes.lo) * t + (t >= 1 ? 1 : 0);
    plane.normal.copy(axes.side).negate(); plane.constant = d; // zichtbaar: zijde·p ≤ d
    viewer.render();
  }
  function setView(v) {
    if (!axes) return;
    const { a, front, side } = axes;
    const dir = { occlusal: a, under: a.clone().negate(), front: front.clone().multiplyScalar(1).addScaledVector(a, 0.45), side: side.clone().addScaledVector(a, 0.3) }[v];
    viewer.view(dir.toArray(), v === 'occlusal' || v === 'under' ? front.toArray() : a.toArray());
    viewer.fit(bounds);
  }
  q('.pv-file').onchange = e => show(e.target.value);
  q('.pv-scan').onchange = e => { if (scanMesh) { scanMesh.visible = e.target.checked; viewer.render(); } };
  q('.pv-cut').oninput = setCut;
  for (const b of box.querySelectorAll('[data-v]')) b.onclick = () => setView(b.dataset.v);
  q('.pv-dl').onclick = () => ctx.onDownload?.(cur.key);
  q('.pv-share').onclick = () => ctx.onShare?.(cur.key);
  const close = () => { document.removeEventListener('keydown', esc, true); viewer.dispose?.(); box.remove(); };
  const esc = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', esc, true);
  q('.pv-close').onclick = close;
  requestAnimationFrame(() => show(start));
  return { close, show };
}

// richting (loodrecht op de as) van het midden naar het front: het front van een boog ligt aan de kant waar de
// punten het verst van het zwaartepunt liggen in de richting met de grootste uitschieter (U-vorm)
function frontVector(mesh, axis, center) {
  const p = mesh.geometry.getAttribute('position'), n = p.count, step = Math.max(1, Math.floor(n / 4000));
  const tmp = new THREE.Vector3(), pts = [];
  const e1 = Math.abs(axis.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = e1.sub(axis.clone().multiplyScalar(e1.dot(axis))).normalize(), v = new THREE.Vector3().crossVectors(axis, u);
  for (let i = 0; i < n; i += step) { tmp.fromBufferAttribute(p, i).sub(center); pts.push([tmp.dot(u), tmp.dot(v)]); }
  // breedste richting = links-rechts; loodrecht daarop: front aan de kant met de meeste massa ver weg (de boog)
  let sxx = 0, syy = 0, sxy = 0; for (const [x, y] of pts) { sxx += x * x; syy += y * y; sxy += x * y; }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy), wide = [Math.cos(ang), Math.sin(ang)], deep = [-wide[1], wide[0]];
  // het front is smal en ver; de uiteinden (achter) liggen breed: kijk waar de punten op de 'diepte'-as smaller zijn
  let pos = 0, neg = 0; for (const [x, y] of pts) { const d = x * deep[0] + y * deep[1], w = Math.abs(x * wide[0] + y * wide[1]); if (d > 0) pos += w; else neg += w; }
  const s = pos < neg ? 1 : -1;
  return u.clone().multiplyScalar(deep[0] * s).addScaledVector(v, deep[1] * s).normalize();
}

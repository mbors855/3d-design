// 3D-werkruimte op basis van Three.js, met BVH-versnelde selectie en een face-ID-buffer voor zichtbaarheid.
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { TransformControls } from '../vendor/TransformControls.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from '../vendor/three-mesh-bvh.module.js';
import { Line2 } from '../vendor/Line2.js';
import { LineMaterial } from '../vendor/LineMaterial.js';
import { LineGeometry } from '../vendor/LineGeometry.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export const COLORS = {
  scan: [0.88, 0.86, 0.82], lepel: [1.0, 0.71, 0.36], beetplaat: [0.22, 0.77, 1.0], basis: [0.65, 0.91, 0.51],
  undercut: [0.95, 0.25, 0.3], tooth: 0xf4f0e6, antagonist: 0x8fb5d6, plate: { lepel: 0xffb45c, beetplaat: 0x39c5ff, basis: 0xe79aa5, rim: 0xf0c27a },
};

export class Viewer extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x0d1a26);
    container.appendChild(this.renderer.domElement);
    this.canvas = this.renderer.domElement;
    this.canvas.setAttribute('aria-label', 'Interactieve 3D-weergave');
    this.canvas.tabIndex = 0;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 5000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(0, -120, 80);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-0.4, 0.7, 1);
    this.camera.add(key);
    this.scene.add(this.camera);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = false;
    this.controls.screenSpacePanning = true;
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.zoomToCursor = true; // zoomen naar de plek onder muis of vingers (zoals in 3Shape/exocad)
    this.controls.addEventListener('change', () => this.render());
    this.gizmo = new TransformControls(this.camera, this.canvas);
    this.gizmo.setSize(0.8);
    this.gizmo.addEventListener('dragging-changed', e => { this.controls.enabled = !e.value; this.dispatchEvent(new CustomEvent('gizmo', { detail: { dragging: e.value } })); });
    this.gizmo.addEventListener('change', () => this.render());
    this.gizmoHelper = this.gizmo.getHelper();
    this.scene.add(this.gizmoHelper);
    this.groups = {};
    for (const name of ['scan', 'wax', 'antagonist', 'plates', 'teeth', 'overlay']) { this.groups[name] = new THREE.Group(); this.groups[name].name = name; this.scene.add(this.groups[name]); }
    this.scanMesh = null;
    this.antagonistMesh = null;
    this.bounds = null;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = true;
    this._queued = false;
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  resize() {
    const r = this.container.getBoundingClientRect();
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = '100%'; this.canvas.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  render() {
    if (this._queued) return;
    this._queued = true;
    requestAnimationFrame(() => { this._queued = false; this._draw(); this.dispatchEvent(new Event('rendered')); });
  }

  renderNow() { this._draw(); }

  // Overlay (omtrek, punten) alleen tegen de diepte van de scan testen, niet tegen werkstukken of tanden: zo blijft
  // de omtreklijn zichtbaar óp een gegenereerde plaat, maar verdwijnt hij nog wel achter de kam.
  _draw() {
    const r = this.renderer, ov = this.groups.overlay, scan = this.scanMesh;
    let depthTested = false;
    if (ov.children.length && scan && this.groups.scan.visible && scan.visible) ov.traverse(o => { if (o.material?.depthTest) depthTested = true; });
    if (!depthTested) { r.render(this.scene, this.camera); return; } // alles altijd zichtbaar: één pass is genoeg
    ov.visible = false; r.render(this.scene, this.camera); ov.visible = true;
    if (!this._depth) {
      this._depth = new THREE.Scene();
      this._depthMesh = new THREE.Mesh(scan.geometry, new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
      this._depthMesh.matrixAutoUpdate = false; this._depth.add(this._depthMesh);
    }
    this._depthMesh.geometry = scan.geometry; this._depthMesh.matrix.copy(scan.matrixWorld); this._depthMesh.matrixWorld.copy(scan.matrixWorld);
    const auto = r.autoClear; r.autoClear = false;
    r.clearDepth(); r.render(this._depth, this.camera); r.render(ov, this.camera);
    r.autoClear = auto;
  }

  // Zachte schaduw: normalen per hoekpunt gemiddeld over aangrenzende vlakken binnen een knikhoek (scherpe randen
  // blijven scherp). Alleen weergave; de geometrie zelf verandert niet.
  static smoothNormals(g, creaseDeg = 55) {
    const pos = g.getAttribute('position').array, n = pos.length / 3, cos = Math.cos(creaseDeg * Math.PI / 180);
    const faceN = new Float32Array(n * 3); // per hoekpunt de normaal van zijn vlak
    for (let f = 0; f < n; f += 3) {
      const a = f * 3, ux = pos[a + 3] - pos[a], uy = pos[a + 4] - pos[a + 1], uz = pos[a + 5] - pos[a + 2], vx = pos[a + 6] - pos[a], vy = pos[a + 7] - pos[a + 1], vz = pos[a + 8] - pos[a + 2];
      let x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx; const l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l;
      for (let k = 0; k < 3; k++) { faceN[(f + k) * 3] = x; faceN[(f + k) * 3 + 1] = y; faceN[(f + k) * 3 + 2] = z; }
    }
    const groups = new Map(), q = v => Math.round(v * 2000);
    for (let i = 0; i < n; i++) { const k = q(pos[i * 3]) * 73856093 ^ q(pos[i * 3 + 1]) * 19349663 ^ q(pos[i * 3 + 2]) * 83492791; let l = groups.get(k); if (!l) groups.set(k, l = []); l.push(i); }
    const out = new Float32Array(n * 3);
    for (const l of groups.values()) for (const i of l) {
      let x = 0, y = 0, z = 0;
      for (const j of l) { const d = faceN[i * 3] * faceN[j * 3] + faceN[i * 3 + 1] * faceN[j * 3 + 1] + faceN[i * 3 + 2] * faceN[j * 3 + 2]; if (d >= cos) { x += faceN[j * 3]; y += faceN[j * 3 + 1]; z += faceN[j * 3 + 2]; } }
      const L = Math.hypot(x, y, z) || 1; out[i * 3] = x / L; out[i * 3 + 1] = y / L; out[i * 3 + 2] = z / L;
    }
    g.setAttribute('normal', new THREE.BufferAttribute(out, 3));
    return g;
  }
  static geometryFromSoup(soup, withColor = false, color = COLORS.scan) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(soup instanceof Float32Array ? soup : Float32Array.from(soup), 3));
    g.computeVertexNormals();
    if (withColor) {
      const c = new Float32Array(soup.length);
      for (let i = 0; i < c.length; i += 3) { c[i] = color[0]; c[i + 1] = color[1]; c[i + 2] = color[2]; }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    }
    g.computeBoundingBox(); g.computeBoundingSphere();
    return g;
  }

  setScan(soup, { keepView = false } = {}) {
    if (this.scanMesh) { this.scanMesh.geometry.disposeBoundsTree(); this.scanMesh.geometry.dispose(); this.groups.scan.remove(this.scanMesh); }
    this._idGeometry?.dispose(); this._idGeometry = null;
    this.scanMesh = null;
    if (!soup) { this.bounds = null; this.render(); return; }
    const g = Viewer.geometryFromSoup(soup, true);
    if (soup.length / 9 < 1_500_000) Viewer.smoothNormals(g, 60); // scan zacht weergeven (geen facetstrepen)
    g.computeBoundsTree();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
    m.name = 'scan';
    this.scanMesh = m;
    this.groups.scan.add(m);
    this.bounds = g.boundingBox.clone();
    if (!keepView) this.fit();
    this.render();
  }

  setScanOpacity(light) {
    if (!this.scanMesh) return;
    const mat = this.scanMesh.material;
    mat.transparent = !!light; mat.opacity = light ? 0.55 : 1; mat.depthWrite = !light; mat.needsUpdate = true;
    this.render();
  }

  // Kleurt facetten: marks[i] = index in palette (0 = basiskleur).
  colorFaces(marks, palette) {
    if (!this.scanMesh) return;
    const attr = this.scanMesh.geometry.getAttribute('color'), c = attr.array, base = COLORS.scan;
    for (let f = 0; f < c.length / 9; f++) {
      const col = marks && marks[f] ? palette[marks[f] - 1] : base;
      for (let k = 0; k < 3; k++) { const o = f * 9 + k * 3; c[o] = col[0]; c[o + 1] = col[1]; c[o + 2] = col[2]; }
    }
    attr.needsUpdate = true;
    this.render();
  }

  setAntagonist(soup, visible = true) {
    if (this.antagonistMesh) { this.antagonistMesh.geometry.disposeBoundsTree(); this.antagonistMesh.geometry.dispose(); this.groups.antagonist.remove(this.antagonistMesh); this.antagonistMesh = null; }
    if (soup) {
      const g = Viewer.geometryFromSoup(soup);
      g.computeBoundsTree();
      this.antagonistMesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: COLORS.antagonist, roughness: 0.5, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }));
      this.antagonistMesh.name = 'antagonist';
      this.groups.antagonist.add(this.antagonistMesh);
    }
    this.groups.antagonist.visible = visible;
    this.render();
  }

  fit(box = this.bounds) {
    if (!box) { this.render(); return; }
    const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()).length() || 50;
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0, -1, 0.7);
    dir.normalize();
    const dist = size / (2 * Math.tan(this.camera.fov * Math.PI / 360)) * 1.05;
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.near = Math.max(0.05, dist / 200); this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.render();
  }

  sceneBox() {
    const box = this.bounds ? this.bounds.clone() : new THREE.Box3();
    for (const g of [this.groups.teeth, this.groups.plates]) if (g.visible && g.children.length) box.union(new THREE.Box3().setFromObject(g));
    return box.isEmpty() ? null : box;
  }

  view(direction, up = [0, 0, 1]) {
    const box = this.sceneBox();
    const center = box ? box.getCenter(new THREE.Vector3()) : this.controls.target.clone();
    const size = box ? box.getSize(new THREE.Vector3()).length() : 0;
    const dist = size ? size / (2 * Math.tan(this.camera.fov * Math.PI / 360)) * 1.05 : this.camera.position.distanceTo(this.controls.target);
    this.camera.up.set(...up);
    this.camera.position.copy(center).addScaledVector(new THREE.Vector3(...direction).normalize(), dist);
    this.controls.target.copy(center);
    this.controls.update();
    this.render();
  }

  zoom(factor) {
    const t = this.controls.target, p = this.camera.position;
    p.sub(t).multiplyScalar(factor).add(t);
    this.controls.update(); this.render();
  }

  orbit(angle) {
    const t = this.controls.target, off = this.camera.position.clone().sub(t);
    off.applyAxisAngle(this.camera.up, angle);
    this.camera.position.copy(t).add(off);
    this.controls.update(); this.render();
  }

  ndc(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  }

  pick(clientX, clientY, objects = this.scanMesh ? [this.scanMesh] : []) {
    if (!objects.length) return null;
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
    const hit = this.raycaster.intersectObjects(objects, false)[0];
    if (!hit) return null;
    return { point: hit.point.clone(), faceIndex: hit.faceIndex, normal: hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null, object: hit.object };
  }

  // Projectie wereld → schermpixels (CSS) en diepte, als bevroren momentopname.
  projector() {
    this.camera.updateMatrixWorld();
    const m = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).elements.slice();
    const r = this.canvas.getBoundingClientRect(), w = r.width, h = r.height;
    return (x, y, z) => {
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      const cx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / cw;
      const cy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw;
      return [(cx + 1) / 2 * w, (1 - cy) / 2 * h, cw];
    };
  }

  // Zichtbare scanfacetten binnen een schermpolygoon via een face-ID-render.
  visibleFaces(polygon) {
    if (!this.scanMesh) return [];
    const pos = this.scanMesh.geometry.getAttribute('position');
    if (!this._idGeometry) {
      const n = pos.count / 3, ids = new Uint8Array(pos.count * 3);
      for (let f = 0; f < n; f++) {
        const v = f + 1, r = v & 255, g = (v >> 8) & 255, b = (v >> 16) & 255;
        for (let k = 0; k < 3; k++) { const o = (f * 3 + k) * 3; ids[o] = r; ids[o + 1] = g; ids[o + 2] = b; }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', pos);
      g.setAttribute('fid', new THREE.BufferAttribute(ids, 3, true));
      this._idGeometry = g;
      this._idMaterial = new THREE.RawShaderMaterial({
        vertexShader: 'precision highp float;attribute vec3 position;attribute vec3 fid;uniform mat4 modelViewMatrix;uniform mat4 projectionMatrix;varying vec3 vId;void main(){vId=fid;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
        fragmentShader: 'precision highp float;varying vec3 vId;void main(){gl_FragColor=vec4(vId,1.0);}',
        side: THREE.DoubleSide,
      });
    }
    const ratio = this.renderer.getPixelRatio(), r = this.canvas.getBoundingClientRect();
    const W = Math.max(1, Math.round(r.width * ratio)), H = Math.max(1, Math.round(r.height * ratio));
    const target = new THREE.WebGLRenderTarget(W, H, { depthBuffer: true, type: THREE.UnsignedByteType });
    const scene = new THREE.Scene(), mesh = new THREE.Mesh(this._idGeometry, this._idMaterial);
    mesh.matrixAutoUpdate = false; mesh.matrix.copy(this.scanMesh.matrixWorld);
    scene.add(mesh);
    const prevClear = this.renderer.getClearColor(new THREE.Color()), prevAlpha = this.renderer.getClearAlpha();
    this.renderer.setRenderTarget(target);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear();
    this.renderer.render(scene, this.camera);
    const xs = polygon.map(p => p[0] * ratio), ys = polygon.map(p => p[1] * ratio);
    const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(W - 1, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(H - 1, Math.ceil(Math.max(...ys)));
    const found = new Set();
    if (x1 >= x0 && y1 >= y0) {
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1, buf = new Uint8Array(bw * bh * 4);
      this.renderer.readRenderTargetPixels(target, x0, H - 1 - y1, bw, bh, buf);
      const scaled = polygon.map(([x, y]) => [x * ratio, y * ratio]);
      for (let j = 0; j < bh; j++) {
        const py = y1 - j + 0.5;
        for (let i = 0; i < bw; i++) {
          const o = (j * bw + i) * 4, id = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
          if (!id || found.has(id - 1)) continue;
          if (pointInPolygon(x0 + i + 0.5, py, scaled)) found.add(id - 1);
        }
      }
    }
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(prevClear, prevAlpha);
    target.dispose();
    this.render();
    return [...found];
  }

  attachGizmo(object, mode = 'translate') {
    if (!object) { this.gizmo.detach(); this.render(); return; }
    this.gizmo.attach(object); this.gizmo.setMode(mode); this.render();
  }

  clearGroup(name) {
    const g = this.groups[name];
    for (const child of [...g.children]) { g.remove(child); child.traverse?.(o => { o.geometry?.dispose?.(); if (o.material && !o.material.shared) o.material.dispose?.(); }); }
    this.render();
  }

  screenshot() { this.renderNow(); return this.canvas.toDataURL('image/png'); }
}

export function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[i], [bx, by] = polygon[j];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

// Hulpmiddelen voor overlay-objecten.
export function makePolyline(points, color, { closed = false, width = 2 } = {}) {
  const g = new THREE.BufferGeometry().setFromPoints(closed && points.length > 2 ? [...points, points[0]] : points);
  const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, linewidth: width }));
  line.renderOrder = 10;
  return line;
}

export function makeDots(points, color, size = 9, firstColor = null) {
  const g = new THREE.BufferGeometry().setFromPoints(points);
  const group = new THREE.Group();
  const pts = new THREE.Points(g, new THREE.PointsMaterial({ color, size, sizeAttenuation: false, depthTest: false, transparent: true }));
  pts.renderOrder = 11; group.add(pts);
  if (firstColor && points.length) {
    const f = new THREE.Points(new THREE.BufferGeometry().setFromPoints([points[0]]), new THREE.PointsMaterial({ color: firstColor, size: size * 1.7, sizeAttenuation: false, depthTest: false, transparent: true }));
    f.renderOrder = 12; group.add(f);
  }
  return group;
}

// Dikke lijn met een vaste breedte in schermpixels (Line2). points: [[x,y,z], …] of Vector3.
// depthTest uit = altijd zichtbaar (ook achter de scan); bias trekt een zichtbare lijn net vóór het oppervlak.
export function makeFatLine(points, color, { width = 3, closed = false, opacity = 1, depthTest = true, bias = 0, renderOrder = 10 } = {}) {
  if (!points || points.length < 2) return null;
  const arr = [];
  for (const p of points) arr.push(p.isVector3 ? p.x : p[0], p.isVector3 ? p.y : p[1], p.isVector3 ? p.z : p[2]);
  if (closed && points.length > 2) arr.push(arr[0], arr[1], arr[2]);
  const g = new LineGeometry(); g.setPositions(arr);
  const m = new LineMaterial({ color, linewidth: width, transparent: true, opacity, depthTest, depthWrite: false });
  if (bias) { m.polygonOffset = true; m.polygonOffsetFactor = -bias; m.polygonOffsetUnits = -4 * bias; }
  const line = new Line2(g, m); line.renderOrder = renderOrder; line.frustumCulled = false;
  return line;
}
// Ronde stippen (vaste grootte in pixels) met een donker randje.
let dotTexture = null;
function roundDot() {
  if (dotTexture || typeof document === 'undefined') return dotTexture;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'); x.beginPath(); x.arc(32, 32, 27, 0, Math.PI * 2); x.fillStyle = '#fff'; x.fill(); x.lineWidth = 8; x.strokeStyle = 'rgba(8,26,38,.95)'; x.stroke();
  dotTexture = new THREE.CanvasTexture(c); dotTexture.colorSpace = THREE.SRGBColorSpace;
  return dotTexture;
}
export function makeRoundDots(points, color, size = 8, { depthTest = false, opacity = 1, renderOrder = 12, lift = 0.35 } = {}) {
  if (!points?.length) return null;
  const g = new THREE.BufferGeometry().setFromPoints(points.map(p => p.isVector3 ? p : new THREE.Vector3(p[0], p[1], p[2])));
  const m = new THREE.PointsMaterial({ color, size, sizeAttenuation: false, map: roundDot(), alphaTest: 0.35, transparent: true, opacity, depthTest, depthWrite: false });
  if (depthTest && lift) { // stip een fractie naar de kijker toe, zodat hij niet half in het oppervlak verdwijnt
    m.onBeforeCompile = sh => { sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>\n  mvPosition.xyz -= normalize(mvPosition.xyz) * ${lift.toFixed(3)};\n  gl_Position = projectionMatrix * mvPosition;`); };
    m.customProgramCacheKey = () => 'dotlift' + lift;
  }
  const pts = new THREE.Points(g, m);
  pts.renderOrder = renderOrder; pts.frustumCulled = false;
  return pts;
}

export function makeMesh(soup, color, opts = {}) {
  const g = Viewer.geometryFromSoup(soup);
  if (opts.smooth !== false && soup.length / 9 < 1_500_000) Viewer.smoothNormals(g, opts.crease ?? 50);
  return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: opts.roughness ?? 0.45, metalness: 0, transparent: !!opts.opacity, opacity: opts.opacity ?? 1, side: opts.side ?? THREE.FrontSide }));
}

export { THREE };

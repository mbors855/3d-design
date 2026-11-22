// Inslijpen: automatisch (penetraties met de antagonist wegnemen, centrisch en in de bewegingsbanen)
// en handmatig met een slijpkop (vinger of muis). Werkt op geïndexeerde BufferGeometry van elementen;
// de mesh blijft gesloten (alleen hoekpunten verschuiven, geen topologiewijziging).
import * as THREE from 'three';
import { signedDistance } from './contacts.js';

const _p = new THREE.Vector3(), _n = new THREE.Vector3();

function adjacency(g) {
  if (g.userData.adj) return g.userData.adj;
  const idx = g.index.array, n = g.getAttribute('position').count, deg = new Uint32Array(n + 1);
  for (let i = 0; i < idx.length; i += 3) for (let k = 0; k < 3; k++) { deg[idx[i + k]] += 2; }
  const start = new Uint32Array(n + 1); for (let i = 0; i < n; i++) start[i + 1] = start[i] + deg[i];
  const fill = start.slice(0, n), list = new Uint32Array(start[n]);
  for (let i = 0; i < idx.length; i += 3) for (let k = 0; k < 3; k++) { const a = idx[i + k], b = idx[i + (k + 1) % 3], c = idx[i + (k + 2) % 3]; list[fill[a]++] = b; list[fill[a]++] = c; }
  return (g.userData.adj = { start, list });
}

function smooth(g, verts, lambda = 0.35, iterations = 1, protect = null) {
  const pos = g.getAttribute('position'), { start, list } = adjacency(g), a = pos.array;
  for (let it = 0; it < iterations; it++) {
    const upd = [];
    for (const v of verts) {
      if (protect?.(v)) continue;
      let x = 0, y = 0, z = 0, c = 0;
      for (let j = start[v]; j < start[v + 1]; j++) { const u = list[j] * 3; x += a[u]; y += a[u + 1]; z += a[u + 2]; c++; }
      if (!c) continue;
      upd.push(v, a[v * 3] + (x / c - a[v * 3]) * lambda, a[v * 3 + 1] + (y / c - a[v * 3 + 1]) * lambda, a[v * 3 + 2] + (z / c - a[v * 3 + 2]) * lambda);
    }
    for (let i = 0; i < upd.length; i += 4) { const v = upd[i] * 3; a[v] = upd[i + 1]; a[v + 1] = upd[i + 2]; a[v + 2] = upd[i + 3]; }
  }
}

function ring(g, verts) {
  const { start, list } = adjacency(g), out = new Set(verts);
  for (const v of verts) for (let j = start[v]; j < start[v + 1]; j++) out.add(list[j]);
  return out;
}

export function finishGeometry(obj) {
  const g = obj.geometry;
  g.getAttribute('position').needsUpdate = true;
  g.computeVertexNormals(); g.computeBoundingBox(); g.computeBoundingSphere();
  if (g.boundsTree) g.boundsTree.refit(); else g.computeBoundsTree?.();
  g.userData.version = (g.userData.version || 0) + 1;
  obj.userData.soupDirty = true;
}

// Eén inslijpstap in de huidige stand. targets worden ingeslepen tegen opponents.
// share: deel van de penetratie dat dit element afneemt (1 = alles, 0,5 = verdeeld over beide kaken).
// clearance: gewenste speling na het slijpen (0 = net contact). Alleen kroonpunten boven 20 % van de hoogte.
export function grindStep(targets, opponents, { share = 1, clearance = 0, tolerance = 0.005, passes = 2, cervicalProtect = 0.2, maxStep = 1.2, reach = 1.6, budget = null, maxTotal = 1.0 } = {}) {
  let removed = 0, verts = 0, maxDepth = 0;
  const cp = new THREE.Vector3(), best = new THREE.Vector3(), w = new THREE.Vector3();
  for (const obj of targets) {
    obj.updateMatrixWorld();
    const g = obj.geometry, pos = g.getAttribute('position'), a = pos.array, h = obj.userData.dims?.height ?? 8;
    if (!g.index) continue;
    const inv = new THREE.Matrix4().copy(obj.matrixWorld).invert();
    const box = new THREE.Box3().setFromBufferAttribute(pos).applyMatrix4(obj.matrixWorld).expandByScalar(reach);
    const opp = opponents.filter(o => o !== obj && (o.updateMatrixWorld(), new THREE.Box3().copy(o.geometry.boundingBox ?? (o.geometry.computeBoundingBox(), o.geometry.boundingBox)).applyMatrix4(o.matrixWorld).intersectsBox(box)));
    if (!opp.length) continue;
    const oppInv = opp.map(o => new THREE.Matrix4().copy(o.matrixWorld).invert());
    const oppBox = new THREE.Box3(); for (const o of opp) oppBox.union(new THREE.Box3().copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld)); oppBox.expandByScalar(0.1);
    const moved = new Set();
    let used = null;
    if (budget) { used = budget.get(obj); if (!used || used.length !== pos.count) budget.set(obj, used = new Float32Array(pos.count)); }
    for (let pass = 0; pass < passes; pass++) {
      let any = false;
      for (let i = 0; i < pos.count; i++) {
        if (a[i * 3 + 1] < h * cervicalProtect) continue;
        w.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld);
        if (!oppBox.containsPoint(w)) continue;
        // alleen penetraties: het punt naar het dichtstbijzijnde oppervlak van de antagonist brengen
        let d = Infinity;
        for (let k = 0; k < opp.length; k++) { const s = signedDistance(opp[k], w, reach, oppInv[k], cp); if (s < d) { d = s; best.copy(cp); } }
        const need = clearance - d;
        if (!(need > tolerance) || !Number.isFinite(d)) continue;
        // richting: van het punt naar het antagonistoppervlak (+ speling voorbij het oppervlak)
        _n.subVectors(best, w); const len = _n.length();
        if (len < 1e-6) continue;
        _n.multiplyScalar(1 / len);
        let step = Math.min(maxStep, (len + clearance) * share);
        if (used) { step = Math.min(step, maxTotal - used[i]); if (step <= 1e-4) continue; used[i] += step; }
        _p.copy(w).addScaledVector(_n, step).applyMatrix4(inv);
        a[i * 3] = _p.x; a[i * 3 + 1] = _p.y; a[i * 3 + 2] = _p.z;
        moved.add(i); any = true; removed += step; maxDepth = Math.max(maxDepth, need);
      }
      if (!any) break;
      smooth(g, ring(g, moved), 0.3, 2, v => a[v * 3 + 1] < h * cervicalProtect);
      pos.needsUpdate = true;
      if (g.boundsTree) g.boundsTree.refit();
    }
    if (moved.size) { verts += moved.size; finishGeometry(obj); }
  }
  return { verts, removed, maxDepth };
}

// Handmatig slijpen: hoekpunten binnen de straal (wereld-mm) rond het wereldpunt naar binnen langs hun normaal.
// mode: 'grind' (wegnemen), 'add' (opbouwen), 'smooth' (gladmaken).
export function brush(obj, worldPoint, { radius = 1.2, depth = 0.05, mode = 'grind' } = {}) {
  const g = obj.geometry; if (!g.index) return 0;
  obj.updateMatrixWorld();
  const pos = g.getAttribute('position'), a = pos.array, h = obj.userData.dims?.height ?? 8;
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  const nrm = g.getAttribute('normal');
  const inv = new THREE.Matrix4().copy(obj.matrixWorld).invert(), normalM = new THREE.Matrix3().getNormalMatrix(obj.matrixWorld);
  const c = worldPoint.clone(), hits = [];
  for (let i = 0; i < pos.count; i++) {
    if (a[i * 3 + 1] < h * 0.15) continue;
    _p.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld);
    const d = _p.distanceTo(c); if (d > radius) continue;
    const t = 1 - d / radius, w = t * t * (3 - 2 * t);
    hits.push(i);
    if (mode === 'smooth') continue;
    _n.fromBufferAttribute(nrm, i).applyMatrix3(normalM).normalize();
    _p.addScaledVector(_n, (mode === 'add' ? 1 : -1) * depth * w).applyMatrix4(inv);
    a[i * 3] = _p.x; a[i * 3 + 1] = _p.y; a[i * 3 + 2] = _p.z;
  }
  if (!hits.length) return 0;
  smooth(g, mode === 'smooth' ? ring(g, hits) : hits, mode === 'smooth' ? 0.5 : 0.15, mode === 'smooth' ? 2 : 1, v => a[v * 3 + 1] < h * 0.15);
  finishGeometry(obj);
  return hits.length;
}

export function geometrySnapshot(objs) { return objs.map(o => ({ o, pos: o.geometry.getAttribute('position').array.slice() })); }
export function restoreGeometry(snap) { for (const { o, pos } of snap) { o.geometry.getAttribute('position').array.set(pos); finishGeometry(o); } }

// Occlusale contacten tussen objecten (elementen onderling of element ↔ antagonistscan), in wereldcoördinaten,
// dus ook terwijl de articulator de onderkaak beweegt. Kleurt per hoekpunt met een continue schaal.
import * as THREE from 'three';

const _ray = new THREE.Ray(), _dir = new THREE.Vector3(0.267, 0.534, 0.802);

const _p = new THREE.Vector3(), _l = new THREE.Vector3(), _n = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _inv = new THREE.Matrix4(), _box = new THREE.Box3(), _box2 = new THREE.Box3();

// Kleurschaal (mm): penetratie rood→magenta, contact oranje, dichtbij geel/groen/blauw, verder basiskleur.
export const CONTACT_SCALE = [
  [-0.3, [0.72, 0.1, 0.62]], [-0.05, [0.9, 0.12, 0.16]], [0.0, [1.0, 0.45, 0.1]], [0.05, [1.0, 0.82, 0.18]],
  [0.15, [0.5, 0.8, 0.3]], [0.35, [0.28, 0.62, 0.9]], [0.6, null],
];
const BASE = new THREE.Color(0xf4f0e6);
export function contactColor(d, out, base = BASE) {
  if (!Number.isFinite(d) || d >= 0.6) return out.copy(base);
  const S = CONTACT_SCALE;
  if (d <= S[0][0]) return out.setRGB(...S[0][1]);
  for (let i = 1; i < S.length; i++) {
    if (d <= S[i][0]) {
      const [d0, c0] = S[i - 1], [d1, c1] = S[i], t = (d - d0) / (d1 - d0), C1 = c1 ?? [base.r, base.g, base.b];
      return out.setRGB(c0[0] + (C1[0] - c0[0]) * t, c0[1] + (C1[1] - c0[1]) * t, c0[2] + (C1[2] - c0[2]) * t);
    }
  }
  return out.copy(base);
}

function ensureBVH(obj) { if (!obj.geometry.boundsTree) obj.geometry.computeBoundsTree(); return obj.geometry.boundsTree; }

// Getekende afstand van wereldpunt w tot het oppervlak van obj (negatief = binnenin), of Infinity als verder dan max.
const _hit = {};
export function signedDistance(obj, w, max = 1, inv = null, outPoint = null) {
  const tree = ensureBVH(obj);
  _l.copy(w).applyMatrix4(inv ?? _inv.copy(obj.matrixWorld).invert());
  const hit = tree.closestPointToPoint(_l, _hit, 0, max);
  if (!hit) return Infinity;
  // normaal van de dichtstbijzijnde driehoek (lokaal)
  const g = obj.geometry, pos = g.getAttribute('position'), idx = g.index, f = hit.faceIndex;
  const i0 = idx ? idx.getX(f * 3) : f * 3, i1 = idx ? idx.getX(f * 3 + 1) : f * 3 + 1, i2 = idx ? idx.getX(f * 3 + 2) : f * 3 + 2;
  _a.fromBufferAttribute(pos, i0); _b.fromBufferAttribute(pos, i1); _c.fromBufferAttribute(pos, i2);
  _b.sub(_a); _c.sub(_a); _n.crossVectors(_b, _c); // buitenwaartse normaal bij CCW-winding
  const side = _p.copy(_l).sub(hit.point).dot(_n);
  if (outPoint) outPoint.copy(hit.point).applyMatrix4(obj.matrixWorld);
  if (side < 0 && hit.distance > 0.25) {
    // diepe penetratie: dubbelcheck met een pariteitsstraal (oneven aantal snijpunten = binnen), want bij
    // dunne randen of na het slijpen kan de normaal van het dichtstbijzijnde vlak misleiden
    _ray.origin.copy(_l); _ray.direction.copy(_dir);
    const n = tree.raycast(_ray, THREE.DoubleSide).length;
    if (n % 2 === 0) return hit.distance;
  }
  return side < 0 ? -hit.distance : hit.distance;
}

// Afstanden van hoekpunten van 'obj' tot de dichtstbijzijnde van 'targets'. Vult kleuren als color = true.
// stride > 1 slaat hoekpunten over (snelle live-weergave); overgeslagen punten krijgen de vorige waarde.
export function contactsFor(obj, targets, { max = 0.7, stride = 1, color = true, minOut = null } = {}) {
  obj.updateMatrixWorld();
  const g = obj.geometry, pos = g.getAttribute('position'), n = pos.count;
  _box.copy(g.boundingBox ?? (g.computeBoundingBox(), g.boundingBox)).applyMatrix4(obj.matrixWorld).expandByScalar(max);
  const near = targets.filter(t => t !== obj && t.visible !== false && t.geometry && (t.updateMatrixWorld(), _box2.copy(t.geometry.boundingBox ?? (t.geometry.computeBoundingBox(), t.geometry.boundingBox)).applyMatrix4(t.matrixWorld).intersectsBox(_box)));
  const invs = near.map(t => new THREE.Matrix4().copy(t.matrixWorld).invert());
  let col = g.getAttribute('color');
  if (color && !col) { col = new THREE.BufferAttribute(new Float32Array(n * 3), 3); g.setAttribute('color', col); obj.material.vertexColors = true; obj.material.needsUpdate = true; }
  const dist = g.userData.contactDist?.length === n ? g.userData.contactDist : (g.userData.contactDist = new Float32Array(n).fill(Infinity));
  let min = Infinity, contacts = 0, deepest = null;
  const tmp = new THREE.Color();
  for (let i = 0; i < n; i++) {
    if (i % stride === 0) {
      let d = Infinity;
      if (near.length) {
        _p.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld);
        for (let k = 0; k < near.length; k++) { const s = signedDistance(near[k], _p, max, invs[k]); if (s < d) d = s; }
      }
      dist[i] = d;
      if (minOut) minOut[i] = Math.min(minOut[i], d);
    }
    const d = minOut ? minOut[i] : dist[i];
    if (d < min) { min = d; deepest = i; }
    if (d < 0.05) contacts++;
    if (color) { contactColor(d, tmp); col.setXYZ(i, tmp.r, tmp.g, tmp.b); }
  }
  if (color) col.needsUpdate = true;
  return { fdi: obj.userData.fdi, min, contacts, deepest };
}

export function clearContacts(objs) {
  for (const o of objs) { const g = o.geometry; if (g.getAttribute('color')) { g.deleteAttribute('color'); o.material.vertexColors = false; o.material.needsUpdate = true; } delete g.userData.contactDist; }
}

export function contactSummary(results) {
  return results.filter(r => r).sort((a, b) => a.fdi - b.fdi).map(r => `${r.fdi}: ${Number.isFinite(r.min) ? (r.min < 0 ? 'penetratie ' + (-r.min).toFixed(2) : r.min.toFixed(2)) + ' mm' : '—'}`).join(' · ');
}

// Tandopstelling in 3D: boogframe uit referentiepunten, plaatsing volgens opstelconcept, automatische occlusie.
import * as THREE from 'three';
import { vec } from './analysis.js';
import { makeTooth, layoutArch, archPoint, toothType, toothDimensions } from './teeth.js';
import { anatomicTooth } from './crowns.js';
import { libraryTooth, hasTooth } from './library.js';

export const CONCEPTS = {
  gysi: { label: 'Gysi', spee: 2.0, wilson: 10, labial: 10, cusp: 1.0, lingualShift: 0 },
  gerber: { label: 'Gerber', spee: 1.5, wilson: 6, labial: 8, cusp: 0.85, lingualShift: 0.6 },
  lingual: { label: 'Lingualiseerd', spee: 1.5, wilson: 5, labial: 8, cusp: 0.8, lingualShift: 0.8 },
  monoplane: { label: 'Monoplane', spee: 0, wilson: 0, labial: 6, cusp: 0, lingualShift: 0 },
  custom: { label: 'Individueel', spee: 1.0, wilson: 5, labial: 8, cusp: 0.8, lingualShift: 0 },
};

// Boogframe. Rechtshandige conventie: Y (anterior) × N (occlusaal) wijst bij de bovenkaak naar patiënt-rechts,
// bij de onderkaak naar patiënt-links. Zo volgt de zijde uit de anatomie, niet uit welk punt R of L heet.
export function archFrame({ R, M, L }, jaw, axisHint) {
  let N = vec.norm(vec.cross(vec.sub(M, R), vec.sub(L, R)));
  if (axisHint ? vec.dot(N, axisHint) < 0 : false) N = N.map(v => -v);
  const O = R.map((v, i) => (v + L[i]) / 2);
  let Y = vec.sub(M, O); Y = vec.norm(vec.sub(Y, vec.scale(N, vec.dot(Y, N))));
  const YxN = vec.cross(Y, N), X = jaw === 'upper' ? YxN.map(v => -v) : YxN; // X = patiënt-links
  const swapped = vec.dot(X, vec.sub(L, R)) < 0;
  const width = Math.abs(vec.dot(vec.sub(L, R), X)), depth = vec.dot(vec.sub(M, O), Y);
  if (!(width > 10 && depth > 5)) throw Error('Referentiepunten geven geen bruikbare boog. Controleer rechts, midden en links.');
  return { O, X, Y, N, width, depth, swapped, jaw };
}

export function defaultFrame(jaw = 'upper', width = 50, depth = 40) {
  return { O: [0, 0, 0], X: jaw === 'upper' ? [-1, 0, 0] : [1, 0, 0], Y: [0, 1, 0], N: [0, 0, 1], width, depth, swapped: false, jaw };
}

export function framePoint(frame, x, y, n = 0) {
  return [0, 1, 2].map(i => frame.O[i] + frame.X[i] * x + frame.Y[i] * y + frame.N[i] * n);
}

export function frameBuccal(frame, x, y, tangent2) {
  const t = [0, 1, 2].map(i => frame.X[i] * tangent2[0] + frame.Y[i] * tangent2[1]);
  let b = vec.norm(vec.cross(frame.N, t));
  const P = framePoint(frame, x, y), C = framePoint(frame, 0, frame.depth * 0.35);
  if (vec.dot(b, vec.sub(P, C)) < 0) b = b.map(v => -v);
  return b;
}

export function placeTeeth(ids, frame, opts, scanMesh = null) {
  const { form = 'oval', scale = 1, shape = 'oval', concept = 'gysi', occlusalHeight = 9, gap = 0, wall = 2, custom = null, arch = null, library = 'anatomic', librarySet = null, ideal = null, rootMax = Infinity } = opts;
  // occlusalHeight: vast getal (mm boven het boogvlak) of functie (booglengte vanaf de middellijn, maximale booglengte) → mm.
  const planeAt = typeof occlusalHeight === 'function' ? occlusalHeight : () => occlusalHeight;
  const c = { ...CONCEPTS[concept], ...(concept === 'custom' && custom ? custom : {}) };
  // externe bibliotheek: alleen elementen die de set heeft; breedtes langs de boog uit de echte kronen
  if (librarySet) ids = ids.filter(id => hasTooth(librarySet, id));
  const libWidth = librarySet ? (id => libraryTooth(librarySet, id, { scale, rootLength: 1 })?.md ?? null) : null;
  const widthCache = new Map(), widthOf = libWidth ? (id => { if (!widthCache.has(id)) widthCache.set(id, libWidth(id)); return widthCache.get(id); }) : null;
  const layout = layoutArch(ids, { jaw: frame.jaw, width: frame.width, depth: frame.depth, form, scale, arch, widthOf, gap: librarySet ? 0 : 0.15 });
  const maxD = Math.max(1, ...layout.map(t => t.distance));
  const canineD = layout.find(t => toothType(t.fdi) === 3)?.distance ?? maxD * 0.35;
  const ray = new THREE.Raycaster(); ray.firstHitOnly = true;
  const N = new THREE.Vector3(...frame.N);
  const upperSign = frame.jaw === 'upper' ? -1 : 1;
  return layout.map(item => {
    const type = toothType(item.fdi), posterior = type >= 4;
    const P = framePoint(frame, item.position[0], item.position[1]);
    const zAxis = new THREE.Vector3(...frameBuccal(frame, item.position[0], item.position[1], [item.mesial[0], item.mesial[1]]));
    const yAxis = N.clone(), xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis);
    const mesialW = new THREE.Vector3(...[0, 1, 2].map(i => frame.X[i] * item.mesial[0] + frame.Y[i] * item.mesial[1])).normalize();
    const mirror = xAxis.dot(mesialW) < 0; // lokale +x van het element wijst distaal → kroon spiegelen
    const lib = librarySet ? libraryTooth(librarySet, item.fdi, { scale, rootLength: 1, mirror }) : null;
    const dims = lib ? { md: lib.md, bl: lib.bl, height: lib.height } : toothDimensions(item.fdi, scale);
    const id = ideal?.[item.fdi];
    // Hoogte langs N: occlusaal vlak + curve van Spee.
    const f = item.distance > canineD ? ((item.distance - canineD) / Math.max(1, maxD - canineD)) ** 2 : 0;
    const shift = id ? 0 : upperSign * c.spee * f, plane = planeAt(item.distance, maxD) + (id ? id.level : 0);
    const lingual = posterior && frame.jaw === 'upper' ? -c.lingualShift : 0;
    // Wortellengte: tot halverwege de basis, gemeten met een straal naar de scan.
    let root = 4;
    const cervicalN = plane - dims.height * (type <= 3 ? 0.95 : 0.85) + shift;
    if (scanMesh) {
      // Meerdere stralen over de wortelbreedte; de kortste afstand bepaalt de lengte (geen doorsteek door het pasvlak).
      const center = new THREE.Vector3(...P).addScaledVector(N, cervicalN).addScaledVector(zAxis, lingual);
      const r = Math.min(dims.md, dims.bl) * 0.4, mes = xAxis.clone();
      let best = Infinity;
      for (const [u, w] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        ray.set(center.clone().addScaledVector(mes, u * r).addScaledVector(zAxis, w * r), N.clone().negate());
        const hit = ray.intersectObject(scanMesh, false)[0];
        if (hit) best = Math.min(best, hit.distance);
      }
      if (Number.isFinite(best)) root = Math.max(0.8, best - gap - wall * 0.5);
    } else root = Math.max(1.2, cervicalN - gap - wall * 0.5);
    root = Math.min(root, rootMax);
    // anatomische kronen (Wheeler's/DentCraft); knobbelhoogte en slijtage volgen het opstelconcept
    const tooth = lib ? libraryTooth(librarySet, item.fdi, { scale, rootLength: root, mirror }) : library === 'simple' ? makeTooth(item.fdi, { scale, shape: type <= 3 ? shape : 'oval', cuspHeight: c.cusp, rootLength: root })
      : anatomicTooth(item.fdi, { scale, shape: type <= 3 ? shape : 'oval', rootLength: root, cusp: Math.max(0.3, c.cusp), wear: concept === 'monoplane' ? 1 : Math.max(0, 1 - c.cusp) * 0.6 });
    const basis = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
    const q = new THREE.Quaternion().setFromRotationMatrix(basis);
    // Labiale inclinatie (front) en curve van Wilson (zijdelings): rotatie om de mesiodistale as.
    let tilt = 0;
    if (id) tilt = id.torque;
    else if (type <= 3) tilt = c.labial * (type === 3 ? 0.5 : 1) * (frame.jaw === 'upper' ? 1 : 0.6);
    else tilt = (frame.jaw === 'upper' ? 1 : -1) * c.wilson * (type >= 6 ? 1 : 0.5);
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), tilt * Math.PI / 180));
    // angulatie (tip) uit de bibliotheek: + = kroon naar mesiaal; rotatie om lokale z kantelt y naar −x
    if (id) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -(mirror ? -1 : 1) * id.tip * Math.PI / 180));
    // exacte hoogte: hoogste kroonpunt langs N op het occlusievlak (na kanteling)
    let top = -Infinity; const tv = new THREE.Vector3(), st = Math.max(3, Math.floor(tooth.soup.length / 3 / 2000) * 3);
    for (let i = 0; i < tooth.soup.length; i += st) { tv.set(tooth.soup[i], tooth.soup[i + 1], tooth.soup[i + 2]).applyQuaternion(q); top = Math.max(top, tv.dot(N)); }
    const position = new THREE.Vector3(...P).addScaledVector(N, plane + shift - top).addScaledVector(zAxis, lingual);
    const mesial = mesialW;
    return { fdi: item.fdi, soup: tooth.soup, mesh: tooth.mesh ?? null, position, quaternion: q, dims, root, mesial, buccal: zAxis.clone(), planeHeight: plane, arch2d: item.position, distance: item.distance };
  });
}

// Automatische occlusie: elke tand langs N verplaatsen tot hij de antagonist raakt (met optionele speling).
export function autoOcclude(toothObjects, antagonistMesh, N, clearance = 0) {
  const ray = new THREE.Raycaster(); ray.firstHitOnly = true;
  const n = new THREE.Vector3(...N).normalize(), report = [];
  const v = new THREE.Vector3(), o = new THREE.Vector3();
  for (const obj of toothObjects) {
    obj.updateMatrixWorld();
    const pos = obj.geometry.getAttribute('position'), h = obj.userData.dims.height;
    let best = Infinity;
    const stride = Math.max(1, Math.floor(pos.count / 600));
    for (let i = 0; i < pos.count; i += stride) {
      if (pos.getY(i) < h * 0.45) continue; // alleen het occlusale deel
      v.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld);
      o.copy(v).addScaledVector(n, -15);
      ray.set(o, n); ray.far = 60;
      const hit = ray.intersectObject(antagonistMesh, false)[0];
      if (hit) best = Math.min(best, hit.distance - 15);
    }
    if (Number.isFinite(best)) { obj.position.addScaledVector(n, best - clearance); obj.updateMatrixWorld(); report.push({ fdi: obj.userData.fdi, moved: best - clearance }); }
    else report.push({ fdi: obj.userData.fdi, moved: null });
  }
  return report;
}

// Contactkaart: kleurt tandpunten op afstand tot de antagonist en geeft per tand de kleinste afstand.
export function contactMap(toothObjects, antagonistMesh, N) {
  const tree = antagonistMesh.geometry.boundsTree, n = new THREE.Vector3(...N).normalize();
  const v = new THREE.Vector3(), target = {}, result = [];
  const base = new THREE.Color(0xf4f0e6), colors = [[-Infinity, 0, new THREE.Color(0xe0303d)], [0, 0.1, new THREE.Color(0xff8a2a)], [0.1, 0.3, new THREE.Color(0xf5d742)], [0.3, 0.8, new THREE.Color(0x58c76a)]];
  for (const obj of toothObjects) {
    obj.updateMatrixWorld();
    const geo = obj.geometry, pos = geo.getAttribute('position');
    let col = geo.getAttribute('color');
    if (!col) { col = new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3); geo.setAttribute('color', col); obj.material.vertexColors = true; obj.material.needsUpdate = true; }
    let min = Infinity, contacts = 0;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld);
      const hit = tree.closestPointToPoint(v, target, 0, 3);
      let d = Infinity;
      if (hit) {
        d = hit.distance;
        if (target.point.clone().sub(v).dot(n) < 0) d = -d; // punt voorbij het antagonistoppervlak
      }
      min = Math.min(min, d);
      if (d < 0.1) contacts++;
      const band = colors.find(([lo, hi]) => d >= lo && d < hi);
      const c = band ? band[2] : base;
      col.setXYZ(i, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
    result.push({ fdi: obj.userData.fdi, min, contacts });
  }
  return result;
}

export function clearContactMap(toothObjects) {
  for (const obj of toothObjects) { if (obj.geometry.getAttribute('color')) { obj.geometry.deleteAttribute('color'); obj.material.vertexColors = false; obj.material.needsUpdate = true; } }
}

export { archPoint };

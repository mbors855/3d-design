// Virtuele half-instelbare articulator (Bonwill-driehoek, Balkwill-hoek). De bovenkaak staat vast, de onderkaak
// beweegt: protrusie, laterotrusie links/rechts (met Bennett-hoek en directe zijwaartse verschuiving) en openen.
// Alles in het boogframe van de werkkaak: X = patiënt-links, Y = anterior, U = craniaal (omhoog).
import * as THREE from 'three';

export const ARTICULATOR_DEFAULTS = {
  intercondylar: 110,   // mm tussen de condylen
  bonwill: 105,         // mm condylus → incisaal punt
  balkwill: 22,         // ° tussen Bonwill-driehoek en occlusievlak
  condylar: 30,         // ° sagittale condylusbaanhelling
  bennett: 15,          // ° Bennett-hoek (mediotrusiezijde)
  sideShift: 0.5,       // mm directe zijwaartse verschuiving (ISS)
  incisal: 10,          // ° protrusieve geleiding van de incisaaltafel
  lateralIncisal: 15,   // ° laterale geleiding (hoektandgeleiding)
};

// Referentiepunten in wereldcoördinaten. incisal = incisaal punt (middellijn op het occlusievlak).
export function articulatorPoints(frame, incisal, jaw, p = ARTICULATOR_DEFAULTS) {
  const X = new THREE.Vector3(...frame.X), Y = new THREE.Vector3(...frame.Y), N = new THREE.Vector3(...frame.N);
  const U = jaw === 'upper' ? N.clone().negate() : N.clone(); // craniaal
  const half = p.intercondylar / 2, back = Math.sqrt(Math.max(1, p.bonwill ** 2 - half ** 2)) * Math.cos(p.balkwill * Math.PI / 180);
  const up = Math.sqrt(Math.max(1, p.bonwill ** 2 - half ** 2)) * Math.sin(p.balkwill * Math.PI / 180);
  const I = new THREE.Vector3(...incisal);
  const CL = I.clone().addScaledVector(X, half).addScaledVector(Y, -back).addScaledVector(U, up);
  const CR = I.clone().addScaledVector(X, -half).addScaledVector(Y, -back).addScaledVector(U, up);
  return { I, CL, CR, X, Y, U };
}

// Starre transformatie die drie bronpunten zo goed mogelijk op drie doelpunten legt (driehoeksframe).
function frameOf(a, b, c) {
  const o = a.clone().add(b).multiplyScalar(0.5);
  const x = b.clone().sub(a).normalize();
  const t = c.clone().sub(o); const y = t.sub(x.clone().multiplyScalar(t.dot(x))).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(o);
}
export function rigidFrom3(src, dst) {
  const A = frameOf(...src), B = frameOf(...dst);
  return B.multiply(A.invert());
}

// Beweging: kind ∈ 'centric' | 'protrusion' | 'right' | 'left' | 'open'; amount in mm (incisaal), bij 'open' in graden.
export function mandiblePose(pts, kind, amount, p = ARTICULATOR_DEFAULTS) {
  const { I, CL, CR, X, Y, U } = pts, rad = d => d * Math.PI / 180;
  if (kind === 'centric' || !amount) return new THREE.Matrix4();
  if (kind === 'open') {
    // scharnieras door beide condylen
    const axis = CL.clone().sub(CR).normalize(), mid = CL.clone().add(CR).multiplyScalar(0.5);
    const R = new THREE.Matrix4().makeRotationAxis(axis, -rad(amount) * (axis.dot(X) > 0 ? 1 : -1));
    return new THREE.Matrix4().makeTranslation(mid.x, mid.y, mid.z).multiply(R).multiply(new THREE.Matrix4().makeTranslation(-mid.x, -mid.y, -mid.z));
  }
  const fwd = (d, incl) => Y.clone().multiplyScalar(d * Math.cos(rad(incl))).addScaledVector(U, -d * Math.sin(rad(incl)));
  if (kind === 'protrusion') {
    const dst = [CR.clone().add(fwd(amount, p.condylar)), CL.clone().add(fwd(amount, p.condylar)), I.clone().add(fwd(amount, p.incisal))];
    return rigidFrom3([CR, CL, I], dst);
  }
  // laterotrusie naar rechts: werkzijde = rechts (−X); balanszijde (links) gaat naar voren, mediaal en omlaag
  const right = kind === 'right', lateral = right ? X.clone().negate() : X.clone();
  const work = right ? CR : CL, bal = right ? CL : CR;
  const dBal = amount * p.intercondylar / p.bonwill;
  const medial = lateral.clone(); // balanscondylus beweegt naar de werkzijde (mediaal)
  const balDir = Y.clone().multiplyScalar(Math.cos(rad(p.bennett))).addScaledVector(medial, Math.sin(rad(p.bennett))).normalize();
  const balDst = bal.clone().addScaledVector(balDir, dBal * Math.cos(rad(p.condylar))).addScaledVector(U, -dBal * Math.sin(rad(p.condylar)));
  const workDst = work.clone().addScaledVector(lateral, Math.min(p.sideShift, amount * 0.5));
  const incDst = I.clone().addScaledVector(lateral, amount).addScaledVector(U, -amount * Math.tan(rad(p.lateralIncisal)));
  const src = right ? [CR, CL, I] : [CR, CL, I];
  const dst = right ? [workDst, balDst, incDst] : [balDst, workDst, incDst];
  return rigidFrom3(src, dst);
}

// Banen voor de bewegingscontacten: reeks standen per beweging.
export function excursionPoses(pts, { protrusion = 5, lateral = 5, steps = 6, kinds = ['protrusion', 'right', 'left'] } = {}, p = ARTICULATOR_DEFAULTS) {
  const out = [];
  for (const k of kinds) for (let i = 1; i <= steps; i++) out.push({ kind: k, amount: (k === 'protrusion' ? protrusion : lateral) * i / steps, matrix: mandiblePose(pts, k, (k === 'protrusion' ? protrusion : lateral) * i / steps, p) });
  return out;
}

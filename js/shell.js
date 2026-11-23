// Scanvolgende plaat: offset van een open kaakoppervlak tot een gesloten schaal.
import { weld, clean, orient, flipAll, boundaryLoops, fillHoles, vertexNormals, loopLength, tidySheet, toSoup, rimDistances } from './mesh.js';
import { bvhFor } from './bvh.js';
import { simplifyMesh, SCAN_LIMIT, SCAN_TARGET } from './decimate.js';

// rimSeal (mm, optioneel): de ruimte loopt in de laatste rimSeal mm (langs het oppervlak gemeten) vloeiend naar 0, zodat
// de rand van de plaat precies op de scan ligt (plaatrand = scanrand), ook met afdrukruimte.
export function shell(soup, opts = {}, report = {}) {
  const g = shellSteps(soup, opts, report);
  let r = g.next(); while (!r.done) r = g.next();
  return r.value;
}
// Zelfde berekening, maar met pauzes (pause() wordt elke ±0,1 s aangeroepen): de pagina blijft reageren.
export async function shellAsync(soup, opts = {}, report = {}, pause = () => new Promise(r => setTimeout(r, 0))) {
  const g = shellSteps(soup, opts, report);
  let r = g.next(); while (!r.done) { await pause(r.value); r = g.next(); }
  return r.value;
}

function* shellSteps(soup, { gap = 0, wall = 2, reverse = false, draftAngle = null, smoothing = 2, allowNegativeGap = false, maxScale = 1.3, rimSeal = 0, checkThin = false } = {}, report = {}) {
  let lastPause = performance.now();
  const due = () => { const t = performance.now(); if (t - lastPause < 100) return false; lastPause = t; return true; };
  if (!Number.isFinite(gap) || (gap < 0 && !allowNegativeGap) || !Number.isFinite(wall) || wall <= 0) throw Error('Vul een geldige ruimte en positieve dikte in.');
  let mesh = weld(soup, 1e-5);
  // Te groot oppervlak (hoge-resolutie scan): eerst vereenvoudigen met een harde foutgrens (rand blijft exact,
  // alleen originele scanpunten) in plaats van te stoppen. Normaal gebeurt dit al bij het openen van de scan.
  if (mesh.indices.length / 3 > SCAN_LIMIT) {
    const r = simplifyMesh(mesh, { tolerance: 0.01, maxTolerance: 0.02, targetFaces: SCAN_TARGET, maxFaces: SCAN_LIMIT });
    mesh = r.mesh; report.reduced = r.report;
    if (mesh.indices.length / 3 > SCAN_LIMIT * 1.5) throw Error(`Het oppervlak binnen de omtrek is te groot (${Math.round(mesh.indices.length / 3).toLocaleString('nl-NL')} facetten, ook na vereenvoudigen). Teken de omtrek kleiner of snijd de scan bij (Scan & mesh).`);
  }
  if (due()) yield 'opschonen';
  mesh = clean(mesh).mesh;
  // Echte scans: randen opschonen (vlinderpunten, losse eilandjes, oren) vóór het oriënteren.
  const tidy = tidySheet(mesh); mesh = tidy.mesh; report.tidied = tidy.removed;
  if (!mesh.indices.length) throw Error('Na opschonen bleef er geen bruikbaar oppervlak over.');
  if (due()) yield 'oriënteren';
  mesh = orient(mesh).mesh;
  if (reverse) mesh = flipAll(mesh);
  let { loops, branching } = boundaryLoops(mesh);
  if (branching) throw Error('De rand kruist of raakt zichzelf op een hoekpunt. Teken de omtrek iets ruimer of repareer de scan.');
  if (!loops.length) throw Error('De scan is gesloten. Teken eerst een omtrek of snijd het plaatoppervlak uit.');
  report.holesFilled = 0;
  if (loops.length > 1) {
    const filled = fillHoles(mesh, { keepLargest: true });
    mesh = filled.mesh;
    report.holesFilled = filled.filled;
    ({ loops, branching } = boundaryLoops(mesh));
    if (loops.length !== 1 || branching) throw Error('Gaten in het oppervlak konden niet automatisch worden gedicht.');
  }
  report.rimLength = loopLength(mesh, loops[0]);
  let positions = mesh.positions;
  const f = mesh.indices;
  if (draftAngle !== null && draftAngle > 0) {
    if (!(draftAngle <= 10)) throw Error('Kies een uitblokhoek van 0 tot 10 graden.');
    positions = blockout(positions, f, reverse ? -1 : 1, draftAngle, report);
  } else { report.changed = 0; report.maxLift = 0; }
  if (due()) yield 'normalen';
  const work = { positions, indices: f };
  let normals = vertexNormals(work);
  normals = smoothNormals(work, normals, smoothing);
  const vCount = positions.length / 3;
  const inner = new Float32Array(positions.length), outer = new Float32Array(positions.length);
  // Hoekcompensatie: een verschuiving langs de (gladgemaakte) puntnormaal is loodrecht op een schuin facet korter.
  // Schaal per punt met 1 / min(n_punt · n_facet), begrensd, zodat de wand nergens dunner wordt dan ingesteld.
  const scale = offsetScale(work, normals, maxScale);
  const rim = loops[0];
  // ruimte per punt: overal 'gap', behalve in de afsluitzone langs de rand (rimSeal) waar hij naar 0 loopt
  const gapAt = new Float32Array(vCount).fill(gap);
  if (gap > 0 && rimSeal > 0) {
    const dr = rimDistances(work, [rim], rimSeal);
    for (let v = 0; v < vCount; v++) if (dr[v] < rimSeal) { const t = dr[v] / rimSeal; gapAt[v] = gap * t * t * (3 - 2 * t); }
    report.rimSeal = rimSeal;
  }
  report.maxScale = 0;
  for (let v = 0; v < vCount; v++) {
    const k = scale[v], g = gapAt[v]; if (k > report.maxScale) report.maxScale = k;
    for (let j = 0; j < 3; j++) { const i = v * 3 + j; inner[i] = positions[i] + normals[i] * g * k; outer[i] = positions[i] + normals[i] * (g + wall) * k; }
  }
  // Ruimte exact maken (nauwkeurigheid 0,05 mm): de verschuiving langs de puntnormaal komt in holtes te dicht bij
  // en op bolle delen te ver van de scan. Per punt de echte afstand tot het (onverschoven) oppervlak meten en
  // binnen- en buitenkant samen bijstellen, zodat de wanddikte gelijk blijft.
  report.gapCorrected = 0;
  let surfBvh = null;
  if (gap > 0) {
    // Alleen punten die in de vorige ronde zijn verschoven opnieuw meten (de rest verandert niet); de afstand tot het
    // eigen scanpunt is een bovengrens voor het zoeken. Samen met de BVH: seconden in plaats van minuten.
    const bvh = surfBvh = bvhFor(toSoup(work)), q = bvh.point, onRim = new Uint8Array(vCount); for (const v of rim) onRim[v] = 1;
    let active = new Int32Array(vCount); for (let v = 0; v < vCount; v++) active[v] = v;
    let nActive = vCount;
    const moved = new Int32Array(vCount), maxDist = gap + 2;
    for (let it = 0; it < 5 && nActive; it++) {
      let changed = 0;
      for (let a = 0; a < nActive; a++) {
        if ((a & 1023) === 0 && due()) yield 'afstand';
        const v = active[a], g = gapAt[v], ix = inner[v * 3], iy = inner[v * 3 + 1], iz = inner[v * 3 + 2];
        const bound = Math.hypot(ix - positions[v * 3], iy - positions[v * 3 + 1], iz - positions[v * 3 + 2]);
        let d = bvh.closest(ix, iy, iz, Math.min(maxDist, bound * (1 + 1e-6) + 1e-6));
        if (d === Infinity) d = bvh.closest(ix, iy, iz, maxDist);
        if (d === Infinity) continue;
        let dx, dy, dz;
        if (d < g - 0.01) {
          // te dicht (holte, of de tegenoverliggende wand van een smalle plooi): weg van het dichtstbijzijnde scanpunt
          // tot precies de ingestelde ruimte (Minkowski-offset); zo overbrugt de lepel smalle plooien
          let ox = ix - q[0], oy = iy - q[1], oz = iz - q[2]; const l = Math.hypot(ox, oy, oz);
          if (l > 1e-6) { ox /= l; oy /= l; oz /= l; } else { ox = normals[v * 3]; oy = normals[v * 3 + 1]; oz = normals[v * 3 + 2]; }
          dx = q[0] + ox * g - ix; dy = q[1] + oy * g - iy; dz = q[2] + oz * g - iz;
        } else if (d > g + 0.03 && !onRim[v]) { const k2 = -(d - g) * 0.5; dx = normals[v * 3] * k2; dy = normals[v * 3 + 1] * k2; dz = normals[v * 3 + 2] * k2; }
        else continue;
        const len = Math.hypot(dx, dy, dz); if (len < 1e-6) continue;
        const sc = Math.min(1, 1.0 / len);
        inner[v * 3] += dx * sc; inner[v * 3 + 1] += dy * sc; inner[v * 3 + 2] += dz * sc;
        outer[v * 3] += dx * sc; outer[v * 3 + 1] += dy * sc; outer[v * 3 + 2] += dz * sc;
        moved[changed++] = v;
      }
      report.gapCorrected = Math.max(report.gapCorrected, changed);
      [active, nActive] = [moved.slice(0, changed), changed];
    }
  }
  // Controle buitenkant (v68): in smalle ruimtes (tussen tanden) kan de buitenkant over de scan heen schieten. Op
  // een steekproef: hoeveel buitenpunten liggen dichter dan ⅓ van (ruimte + dikte) bij de scan?
  if (checkThin) {
    if (due()) yield 'controle';
    surfBvh ??= bvhFor(toSoup(work));
    const stride = Math.max(1, Math.floor(vCount / 4000)), lim = (gap + wall) / 3, onR = new Uint8Array(vCount); for (const v of rim) onR[v] = 1;
    let thin = 0, cnt = 0;
    for (let v = 0; v < vCount; v += stride) { if (onR[v]) continue; cnt++; if (surfBvh.closest(outer[v * 3], outer[v * 3 + 1], outer[v * 3 + 2], lim) !== Infinity) thin++; }
    report.thin = cnt ? thin / cnt : 0;
  }
  const out = new Float32Array((f.length / 3 * 2 + rim.length * 2) * 9);
  let o = 0;
  const put = (arr, v) => { out[o++] = arr[v * 3]; out[o++] = arr[v * 3 + 1]; out[o++] = arr[v * 3 + 2]; };
  for (let i = 0; i < f.length; i += 3) {
    const a = f[i], b = f[i + 1], c = f[i + 2];
    put(inner, a); put(inner, c); put(inner, b);
    put(outer, a); put(outer, b); put(outer, c);
  }
  for (let i = 0; i < rim.length; i++) {
    const a = rim[i], b = rim[(i + 1) % rim.length];
    put(inner, a); put(inner, b); put(outer, b);
    put(inner, a); put(outer, b); put(outer, a);
  }
  report.vertices = vCount;
  return out;
}


function offsetScale(mesh, normals, maxScale = 1.3) {
  const f = mesh.indices, p = mesh.positions, n = normals.length / 3, minDot = new Float32Array(n).fill(1), fn = [0, 0, 0];
  for (let i = 0; i < f.length / 3; i++) {
    const a = f[i * 3] * 3, b = f[i * 3 + 1] * 3, c = f[i * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], wx = p[c] - p[a], wy = p[c + 1] - p[a + 1], wz = p[c + 2] - p[a + 2];
    fn[0] = uy * wz - uz * wy; fn[1] = uz * wx - ux * wz; fn[2] = ux * wy - uy * wx;
    const l = Math.hypot(fn[0], fn[1], fn[2]); if (l < 1e-12) continue;
    for (let k = 0; k < 3; k++) {
      const v = f[i * 3 + k], d = (normals[v * 3] * fn[0] + normals[v * 3 + 1] * fn[1] + normals[v * 3 + 2] * fn[2]) / l;
      if (d < minDot[v]) minDot[v] = d;
    }
  }
  const out = new Float32Array(n);
  for (let v = 0; v < n; v++) out[v] = Math.min(maxScale, 1 / Math.max(1 / maxScale, minDot[v]));
  return out;
}

function smoothNormals(mesh, normals, iterations) {
  if (!iterations) return normals;
  const f = mesh.indices, n = normals.length / 3;
  const neighbors = Array.from({ length: n }, () => new Set());
  for (let i = 0; i < f.length; i += 3) for (let k = 0; k < 3; k++) { neighbors[f[i + k]].add(f[i + (k + 1) % 3]); neighbors[f[i + k]].add(f[i + (k + 2) % 3]); }
  let cur = normals;
  for (let it = 0; it < iterations; it++) {
    const next = new Float32Array(cur.length);
    for (let v = 0; v < n; v++) {
      let x = cur[v * 3] * 2, y = cur[v * 3 + 1] * 2, z = cur[v * 3 + 2] * 2;
      for (const w of neighbors[v]) { x += cur[w * 3]; y += cur[w * 3 + 1]; z += cur[w * 3 + 2]; }
      const l = Math.hypot(x, y, z) || 1;
      next[v * 3] = x / l; next[v * 3 + 1] = y / l; next[v * 3 + 2] = z / l;
    }
    cur = next;
  }
  return cur;
}

// Uitblokken langs de Z-as: bovenste omhullende van kegels rond de invoerrichting.
export function blockout(positions, f, sign, angle, report) {
  let winding = 0;
  for (let i = 0; i < f.length; i += 3) {
    const a = f[i] * 3, b = f[i + 1] * 3, c = f[i + 2] * 3;
    const area = (positions[b] - positions[a]) * (positions[c + 1] - positions[a + 1]) - (positions[b + 1] - positions[a + 1]) * (positions[c] - positions[a]);
    winding ||= Math.sign(area);
    if (winding * area <= 1e-10) throw Error('Uitblokken langs deze as vereist een oppervlak zonder overhang of verticale facetten. Kies de andere richting of pas de scan aan.');
  }
  report.changed = 0; report.maxLift = 0;
  const tangent = Math.tan(angle * Math.PI / 180);
  let low = Infinity, high = -Infinity;
  for (let i = 2; i < positions.length; i += 3) { const h = sign * positions[i]; low = Math.min(low, h); high = Math.max(high, h); }
  const radius = (high - low) * tangent;
  if (!(radius > 0)) return positions;
  const cells = new Map(), key = (x, y) => x + ':' + y, n = positions.length / 3;
  for (let v = 0; v < n; v++) {
    const id = key(Math.floor(positions[v * 3] / radius), Math.floor(positions[v * 3 + 1] / radius));
    if (!cells.has(id)) cells.set(id, []);
    cells.get(id).push(v);
  }
  const out = Float32Array.from(positions);
  let comparisons = 0;
  for (let v = 0; v < n; v++) {
    const px = positions[v * 3], py = positions[v * 3 + 1], cx = Math.floor(px / radius), cy = Math.floor(py / radius);
    const start = sign * positions[v * 3 + 2];
    let height = start;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const near = cells.get(key(cx + dx, cy + dy));
      if (!near) continue;
      comparisons += near.length;
      if (comparisons > 40_000_000) throw Error('De uitblokberekening is te zwaar voor deze scan.');
      for (const w of near) {
        const hz = sign * positions[w * 3 + 2];
        if (hz <= height) continue;
        height = Math.max(height, hz - Math.hypot(positions[w * 3] - px, positions[w * 3 + 1] - py) / tangent);
      }
    }
    const lift = height - start;
    if (lift > 1e-8) { report.changed++; report.maxLift = Math.max(report.maxLift, lift); out[v * 3 + 2] = sign * height; }
  }
  return out;
}

// Scanvolgende plaat: offset van een open kaakoppervlak tot een gesloten schaal.
import { weld, clean, orient, flipAll, boundaryLoops, fillHoles, vertexNormals, loopLength, tidySheet, toSoup, pointToSurfaceDistances } from './mesh.js';

export function shell(soup, { gap = 0, wall = 2, reverse = false, draftAngle = null, smoothing = 2, allowNegativeGap = false, maxScale = 1.3 } = {}, report = {}) {
  if (!Number.isFinite(gap) || (gap < 0 && !allowNegativeGap) || !Number.isFinite(wall) || wall <= 0) throw Error('Vul een geldige ruimte en positieve dikte in.');
  if (soup.length / 9 > 400000) throw Error('Gebruik een uitgesneden scan met maximaal 400.000 facetten.');
  let mesh = clean(weld(soup, 1e-5)).mesh;
  // Echte scans: randen opschonen (vlinderpunten, losse eilandjes, oren) vóór het oriënteren.
  const tidy = tidySheet(mesh); mesh = tidy.mesh; report.tidied = tidy.removed;
  if (!mesh.indices.length) throw Error('Na opschonen bleef er geen bruikbaar oppervlak over.');
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
  const work = { positions, indices: f };
  let normals = vertexNormals(work);
  normals = smoothNormals(work, normals, smoothing);
  const vCount = positions.length / 3;
  const inner = new Float32Array(positions.length), outer = new Float32Array(positions.length);
  // Hoekcompensatie: een verschuiving langs de (gladgemaakte) puntnormaal is loodrecht op een schuin facet korter.
  // Schaal per punt met 1 / min(n_punt · n_facet), begrensd, zodat de wand nergens dunner wordt dan ingesteld.
  const scale = offsetScale(work, normals, maxScale);
  report.maxScale = 0;
  for (let v = 0; v < vCount; v++) {
    const k = scale[v]; if (k > report.maxScale) report.maxScale = k;
    for (let j = 0; j < 3; j++) { const i = v * 3 + j; inner[i] = positions[i] + normals[i] * gap * k; outer[i] = positions[i] + normals[i] * (gap + wall) * k; }
  }
  const rim = loops[0];
  // Ruimte exact maken (nauwkeurigheid 0,05 mm): de verschuiving langs de puntnormaal komt in holtes te dicht bij
  // en op bolle delen te ver van de scan. Per punt de echte afstand tot het (onverschoven) oppervlak meten en
  // binnen- en buitenkant samen bijstellen, zodat de wanddikte gelijk blijft.
  report.gapCorrected = 0;
  if (gap > 0) {
    const surfaceSoup = toSoup(work), onRim = new Uint8Array(vCount); for (const v of rim) onRim[v] = 1;
    const cp = new Float32Array(inner.length);
    for (let it = 0; it < 5; it++) {
      const d = pointToSurfaceDistances(inner, surfaceSoup, { maxDist: gap + 2, closest: cp });
      let changed = 0;
      for (let v = 0; v < vCount; v++) {
        if (!Number.isFinite(d[v])) continue;
        let delta = [0, 0, 0];
        if (d[v] < gap - 0.01) {
          // te dicht (holte, of de tegenoverliggende wand van een smalle plooi): weg van het dichtstbijzijnde scanpunt
          // tot precies de ingestelde ruimte (Minkowski-offset); zo overbrugt de lepel smalle plooien
          const o = [inner[v * 3] - cp[v * 3], inner[v * 3 + 1] - cp[v * 3 + 1], inner[v * 3 + 2] - cp[v * 3 + 2]], l = Math.hypot(...o);
          const dir = l > 1e-6 ? o.map(x => x / l) : [normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]];
          delta = [0, 1, 2].map(k => cp[v * 3 + k] + dir[k] * gap - inner[v * 3 + k]);
        } else if (d[v] > gap + 0.03 && !onRim[v]) { const k2 = -(d[v] - gap) * 0.5; delta = [normals[v * 3] * k2, normals[v * 3 + 1] * k2, normals[v * 3 + 2] * k2]; }
        else continue;
        const len = Math.hypot(...delta); if (len < 1e-6) continue;
        const sc = Math.min(1, 1.0 / len); changed++;
        for (let j = 0; j < 3; j++) { inner[v * 3 + j] += delta[j] * sc; outer[v * 3 + j] += delta[j] * sc; }
      }
      report.gapCorrected = Math.max(report.gapCorrected, changed);
      if (!changed) break;
    }
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

// Scanvolgende plaat: offset van een open kaakoppervlak tot een gesloten schaal.
import { weld, clean, orient, flipAll, boundaryLoops, fillHoles, vertexNormals, loopLength, tidySheet, toSoup, rimDistances, flipSoup } from './mesh.js';
import { bvhFor, TriBVH } from './bvh.js';
import { simplifyMesh, SCAN_LIMIT, SCAN_TARGET } from './decimate.js';
import { adjacency, smoothVectors, reference, gaussLoop, loopArc, vertexNormalsInto, heightToLevel } from './offset.js';
import { isoSurface, loftLoops } from './isosheet.js';
import { concatSoups } from './stl.js';

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

function* shellSteps(soup, { gap = 0, wall = 2, reverse = false, draftAngle = null, smoothing = 2, allowNegativeGap = false, maxScale = 1.3, rimSeal = 0, checkThin = false, method = 'iso', round = 0.9, quick = false, trimSpikes = false } = {}, report = {}) {
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
  // v69 (trimSpikes, bij een rand langs de scanrand): dunne punten aan de rand (smaller dan 2 mm en langer dan 2 mm,
  // bv. een punt die het bijsnijden liet staan) weghalen. De rest van de rand blijft exact gelijk.
  if (method === 'iso' && !quick && trimSpikes) {
    const o = openSheet(mesh, loops[0], 1.0);
    if (o) { mesh = o; ({ loops, branching } = boundaryLoops(mesh)); report.openedFaces = o.removed; if (loops.length !== 1 || branching) throw Error('De rand kon na het weghalen van dunne uitsteeksels niet worden gevolgd. Teken de omtrek iets ruimer.'); }
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
  const rim = loops[0];
  // ruimte per punt: overal 'gap', behalve in de afsluitzone langs de rand (rimSeal) waar hij naar 0 loopt
  const gapAt = new Float32Array(vCount).fill(gap);
  if (gap > 0 && rimSeal > 0) {
    const dr = rimDistances(work, [rim], rimSeal);
    for (let v = 0; v < vCount; v++) if (dr[v] < rimSeal) { const t = dr[v] / rimSeal; gapAt[v] = gap * t * t * (3 - 2 * t); }
    report.rimSeal = rimSeal;
  }
  if (method === 'iso') return yield* isoShell({ work, normals, rim, gapAt, gap, wall, round, quick, checkThin, due }, report);
  // Oude methode (t/m v68, alleen nog ter vergelijking): elk punt langs zijn gladgemaakte normaal verschuiven.
  report.method = 'normal';
  const inner = new Float32Array(positions.length), outer = new Float32Array(positions.length);
  // Hoekcompensatie: een verschuiving langs de (gladgemaakte) puntnormaal is loodrecht op een schuin facet korter.
  // Schaal per punt met 1 / min(n_punt · n_facet), begrensd, zodat de wand nergens dunner wordt dan ingesteld.
  const scale = offsetScale(work, normals, maxScale);
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


// ---- v69: buitenkant (en afdrukruimte) als iso-oppervlak van de afstand tot de scan -------------------------------
// Pasvlak: bij ruimte 0 (beetplaat, basis) exact de scan. Buitenkant: het iso-oppervlak op 'ruimte + dikte' mm van de
// scan (isosheet.js): glad, overbrugt spleten tussen tanden, kan niet omklappen. Rand: rechte wand vanaf de scanrand
// met een afgeronde bovenkant (straal 'round'), met een smalle strook aangesloten op het iso-oppervlak.
// Afdrukruimte > 0,05 mm (lepel): het pasvlak is ook een iso-oppervlak (op 'ruimte' mm), met een afsluitstrook naar de rand.
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
function* isoShell({ work, normals, rim, gapAt, gap, wall, round, quick, checkThin, due }, report) {
  report.method = 'iso';
  const t0 = performance.now(), tm = report.timing = {}; let tl = t0; const mark = (k) => { const t = performance.now(); tm[k] = Math.round(t - tl); tl = t; };
  const P = work.positions, f = work.indices, vCount = P.length / 3, nr = rim.length;
  const sheetGap = gap > 0.05, level = gap + wall;
  const adjF = adjacency(f, vCount);
  const ref = reference(work, normals);
  const nRim = smoothVectors(adjF, normals, 10);
  mark('voorbereiden');
  // 1. randframe: normaal en richting naar buiten (loodrecht op de rand), langs de booglengte gladgemaakt (Gauss),
  // zodat de kartelige scanrand geen ribbels in de wand en de afronding geeft
  const innerFine = sheetGap ? null : new Float32Array(P.length);
  if (innerFine) for (let v = 0; v < vCount; v++) { const g = gapAt[v]; for (let j = 0; j < 3; j++) innerFine[v * 3 + j] = P[v * 3 + j] + normals[v * 3 + j] * g; }
  let rn = new Float64Array(nr * 3);
  for (let i = 0; i < nr; i++) for (let j = 0; j < 3; j++) rn[i * 3 + j] = nRim[rim[i] * 3 + j];
  const A = new Float32Array(nr * 3); // binnenkant van de rand: scanrand (+ ruimte als die daar niet naar 0 loopt)
  for (let i = 0; i < nr; i++) { const v = rim[i], g = gapAt[v]; for (let j = 0; j < 3; j++) A[i * 3 + j] = innerFine ? innerFine[v * 3 + j] : P[v * 3 + j] + rn[i * 3 + j] * g; }
  const { cum, total } = loopArc(A);
  const As = gaussLoop(A, cum, total, 1.0);
  rn = gaussLoop(rn, cum, total, 2.5, true);
  // kartelige scanrand (traptjes van een intraorale scan) gladstrijken: elk randpunt schuift in het raakvlak naar de
  // gladde lijn (hooguit een paar tiende mm), zolang geen enkele aanliggende driehoek daardoor omklapt. Zo krijgt de
  // wand geen ribbels; het pasvlak verandert alleen in die laatste driehoekjes.
  if (innerFine && !quick) report.rimSmoothed = relaxRim(innerFine, f, rim, A, As, rn);
  let rt = new Float64Array(nr * 3);
  for (let i = 0; i < nr; i++) {
    const a = ((i - 1 + nr) % nr) * 3, b = ((i + 1) % nr) * 3, o = i * 3;
    const dx = As[b] - As[a], dy = As[b + 1] - As[a + 1], dz = As[b + 2] - As[a + 2];
    rt[o] = dy * rn[o + 2] - dz * rn[o + 1]; rt[o + 1] = dz * rn[o] - dx * rn[o + 2]; rt[o + 2] = dx * rn[o + 1] - dy * rn[o];
  }
  rt = gaussLoop(rt, cum, total, 0.8, true);
  for (let i = 0; i < nr; i++) { // n loodrecht op t
    const o = i * 3, d = rn[o] * rt[o] + rn[o + 1] * rt[o + 1] + rn[o + 2] * rt[o + 2];
    const x = rn[o] - d * rt[o], y = rn[o + 1] - d * rt[o + 1], z = rn[o + 2] - d * rt[o + 2], l = Math.hypot(x, y, z) || 1;
    rn[o] = x / l; rn[o + 1] = y / l; rn[o + 2] = z / l;
  }
  // 2. welk randpunt hoort bij een plek (voor het afsnijden van het iso-oppervlak bij de rand)
  const h = quick ? clamp(level / 4, 0.4, 2) : clamp(level / 5, 0.3, 1.6);
  const r = quick ? 0 : clamp(round ?? 0, 0, wall * 0.45), segs = r > 0.05 ? 4 : 0;
  const seal = report.rimSeal || 0;
  const gapFace = (face) => face < 0 ? gap : (gapAt[f[face * 3]] + gapAt[f[face * 3 + 1]] + gapAt[f[face * 3 + 2]]) / 3;
  // dichtstbijzijnd punt op de (gladde) randlijn: BVH over de randstukjes (als platte driehoeken a-b-b)
  const rimSoup = new Float32Array(nr * 9);
  for (let i = 0; i < nr; i++) { const a = i * 3, b = ((i + 1) % nr) * 3; rimSoup.set([As[a], As[a + 1], As[a + 2], As[b], As[b + 1], As[b + 2], As[b], As[b + 1], As[b + 2]], i * 9); }
  const rimBvh = new TriBVH(rimSoup), reach = Math.max(r, seal) + 3 * h + 1.5;
  // u: hoe ver een punt naar buiten ligt t.o.v. het dichtstbijzijnde randpunt (langs de richting naar buiten daar);
  // > 0 = voorbij de plaatrand. Verder dan 'reach' van de rand: -Infinity (ruim binnen).
  const uAt = (x, y, z) => {
    if (rimBvh.closest(x, y, z, reach) === Infinity) return -Infinity;
    const i = rimBvh.face, j = (i + 1) % nr, cp = rimBvh.point;
    const k = (cp[0] - As[i * 3]) ** 2 + (cp[1] - As[i * 3 + 1]) ** 2 + (cp[2] - As[i * 3 + 2]) ** 2 <= (cp[0] - As[j * 3]) ** 2 + (cp[1] - As[j * 3 + 1]) ** 2 + (cp[2] - As[j * 3 + 2]) ** 2 ? i : j;
    const o = k * 3; return (x - cp[0]) * rt[o] + (y - cp[1]) * rt[o + 1] + (z - cp[2]) * rt[o + 2];
  };
  // startpunten: langs de normaal omhoog tot de gevraagde afstand, op een deel van de scanpunten
  const seedsFor = (lvFn) => {
    const out = [], step = Math.max(1, Math.floor(vCount / 2500)), bvh = ref.bvh;
    for (let v = 0; v < vCount; v += step) {
      if (rimBvh.closest(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], r + seal + 2 * h) !== Infinity) continue;
      const px = P[v * 3], py = P[v * 3 + 1], pz = P[v * 3 + 2], nx = normals[v * 3], ny = normals[v * 3 + 1], nz = normals[v * 3 + 2];
      // stappen van minstens het tekort (de afstand groeit hooguit even hard als de stap)
      for (let t = h * 0.5, s = 0; t < level + 4 && s < 12; s++) {
        const x = px + nx * t, y = py + ny * t, z = pz + nz * t, d = bvh.closest(x, y, z, level + 5);
        if (d === Infinity) break;
        const lv = lvFn(bvh.face);
        if (d >= lv) { out.push(x, y, z); break; }
        t += Math.max(lv - d, h * 0.25);
      }
    }
    return Float32Array.from(out);
  };
  // 3. buitenkant
  if (due()) yield 'buitenkant';
  // buitenkant overal op 'ruimte + dikte' van de scan (ook in een afsluitzone: daar wordt de rand iets dikker)
  const lvOut = level;
  const lvOutFn = typeof lvOut === 'number' ? () => lvOut : lvOut;
  mark('rand en startpunten');
  // randringen: de buitenkant ligt bij de rand op het iso-oppervlak zelf (hoogte per randpunt gemeten langs de
  // randnormaal), zodat de afgeronde rand ook op een schuine wand (vestibulum) netjes aansluit
  const hOut = new Float64Array(nr), hIn = new Float64Array(nr);
  for (let i = 0; i < nr; i++) {
    const o = i * 3;
    const ho = heightToLevel(ref, As[o] - r * rt[o], As[o + 1] - r * rt[o + 1], As[o + 2] - r * rt[o + 2], rn[o], rn[o + 1], rn[o + 2], lvOutFn, level + 6);
    hOut[i] = ho ?? level;
    if (sheetGap && !seal) { const hi = heightToLevel(ref, As[o], As[o + 1], As[o + 2], rn[o], rn[o + 1], rn[o + 2], () => gap, gap + 6); hIn[i] = hi ?? gap; }
  }
  { // langs de rand gladmaken (Gauss over 1 mm), en de buitenhoogte minstens 'dikte' boven de binnenkant
    const tmp = new Float64Array(nr * 3); for (let i = 0; i < nr; i++) { tmp[i * 3] = hOut[i]; tmp[i * 3 + 1] = hIn[i]; }
    const sm = gaussLoop(tmp, cum, total, 1.0);
    for (let i = 0; i < nr; i++) { hIn[i] = Math.max(0, sm[i * 3 + 1]); hOut[i] = Math.max(sm[i * 3], hIn[i] + wall * 0.75, r + 0.3); }
  }
  // binnenring: zonder ruimte de (gladgestreken) scanrand; met ruimte zonder afsluitzone op de binnen-iso-hoogte
  // de ringen boven de scanrand op een gelijkmatige onderlinge afstand (± 0,3 mm), langs de booglengte
  // geïnterpoleerd: de randpunten van een scan liggen heel onregelmatig (0,05 mm … enkele mm bij een rechte rand), en
  // de aansluitstroken worden zo geen waaiers van splinters
  const step = 0.3, ns = Math.max(8, Math.round(total / step)), tq = new Float64Array(ns);
  { let i = 0; for (let q = 0; q < ns; q++) { const sq = total * q / ns; while (i + 1 < nr && cum[i + 1] <= sq) i++; const segLen = (i + 1 < nr ? cum[i + 1] : total) - cum[i]; tq[q] = i + (segLen > 0 ? (sq - cum[i]) / segLen : 0); } }
  const lerp3 = (V, t, out, w) => { const i = Math.floor(t), j = (i + 1) % nr, f = t - i; for (let k = 0; k < 3; k++) out[w + k] = V[i * 3 + k] * (1 - f) + V[j * 3 + k] * f; };
  const lerp1 = (V, t) => { const i = Math.floor(t), j = (i + 1) % nr, f = t - i; return V[i] * (1 - f) + V[j] * f; };
  const qP = new Float64Array(ns * 3), qN = new Float64Array(ns * 3), qT = new Float64Array(ns * 3), qH = new Float64Array(ns), qI = new Float64Array(ns);
  for (let q = 0; q < ns; q++) { lerp3(As, tq[q], qP, q * 3); lerp3(rn, tq[q], qN, q * 3); lerp3(rt, tq[q], qT, q * 3); qH[q] = lerp1(hOut, tq[q]); qI[q] = lerp1(hIn, tq[q]); }
  const ring = (fn) => { const R = new Float32Array(ns * 3); for (let q = 0; q < ns; q++) fn(q, q * 3, R); return R; };
  // afronding plaatselijk kleiner bij een scherpe bolle punt van de omtrek (straal van de bocht < r): anders snijdt
  // de naar binnen verschoven bovenrand van de afronding zichzelf. Kromtestraal over ± 0,6 mm, in het raakvlak.
  const rq = new Float64Array(ns).fill(r);
  if (r > 0) {
    const k = Math.max(1, Math.round(0.6 / step));
    for (let q = 0; q < ns; q++) {
      const a = ((q - k + ns) % ns) * 3, b = q * 3, c = ((q + k) % ns) * 3;
      // binnenwaartse kromming: hoek tussen de twee stukken, gemeten met de richting naar buiten (qT)
      const ux = qP[b] - qP[a], uy = qP[b + 1] - qP[a + 1], uz = qP[b + 2] - qP[a + 2], vx = qP[c] - qP[b], vy = qP[c + 1] - qP[b + 1], vz = qP[c + 2] - qP[b + 2];
      const lu = Math.hypot(ux, uy, uz), lv = Math.hypot(vx, vy, vz); if (!(lu > 1e-9 && lv > 1e-9)) continue;
      const turnOut = ((vx / lv - ux / lu) * qT[b] + (vy / lv - uy / lu) * qT[b + 1] + (vz / lv - uz / lu) * qT[b + 2]); // < 0: bolle bocht
      const cosA = (ux * vx + uy * vy + uz * vz) / (lu * lv), ang = Math.acos(Math.max(-1, Math.min(1, cosA)));
      if (turnOut < 0 && ang > 1e-6) { const rho = (lu + lv) / 2 / ang; rq[q] = Math.min(rq[q], Math.max(0.05, 0.8 * rho)); }
    }
    // ook de buren (het afgeronde stuk loopt een eindje door)
    const tmp = Float64Array.from(rq); for (let q = 0; q < ns; q++) for (let d = -k; d <= k; d++) tmp[q] = Math.min(tmp[q], rq[(q + d + ns) % ns] + Math.abs(d) * step * 0.5);
    rq.set(tmp);
  }
  // binnenring: zonder ruimte (of met afsluitzone) de scanrand zelf (alle punten, exact of gladgestreken); met ruimte
  // zonder afsluitzone de gelijkmatige ring op de binnen-iso-hoogte
  const freeInner = sheetGap && !seal;
  const A0 = freeInner ? ring((q, o, R) => { for (let j = 0; j < 3; j++) R[o + j] = qP[o + j] + qN[o + j] * qI[q]; }) : A;
  const rings = [A0];
  if (segs) {
    for (let s = 0; s <= segs; s++) {
      const phi = Math.PI / 2 * (1 - s / segs), cs = Math.cos(phi), sn = Math.sin(phi);
      rings.push(ring((q, o, R) => { const rr = rq[q]; for (let j = 0; j < 3; j++) R[o + j] = qP[o + j] + (qH[q] - rr) * qN[o + j] - rr * qT[o + j] + rr * (sn * qT[o + j] + cs * qN[o + j]); }));
    }
  } else rings.push(ring((q, o, R) => { for (let j = 0; j < 3; j++) R[o + j] = qP[o + j] + qH[q] * qN[o + j]; }));
  const T = rings[rings.length - 1];
  mark('randhoogtes');
  const outerRaw = yield* isoSurface({ ref, level: lvOut, h, seeds: seedsFor(lvOutFn), inside: (x, y, z) => uAt(x, y, z) <= -r - 2 * h, due, label: 'buitenkant' });
  mark('iso-oppervlak buiten');
  const outer = finishPatch(outerRaw, ref, lvOutFn, { smooth: quick ? 2 : 8, h, exact: false, lvMax: level, limitU: (x, y, z) => uAt(x, y, z) + r + h });
  report.outerCells = outerRaw.stats.cells; report.outerQueries = outerRaw.stats.queries; report.outerLoops = outer.loops; report.outerFilled = outer.filled;
  if (report.debug) report.outerRaw = outerRaw;
  mark('buitenkant');
  // 4. pasvlak met afdrukruimte (alleen als die er is)
  let inner = null;
  if (sheetGap) {
    if (due()) yield 'afdrukruimte';
    // afsluitzone: het iso-oppervlak stopt 'seal' mm voor de rand; een schuine strook loopt van daar naar de scanrand
    const lvIn = gap, lvInFn = () => lvIn;
    const sealU = Math.max(0.75 * seal, 2 * h); // gemeten in het raakvlak; langs een schuine wand is de weg naar de rand langer
    const insideIn = (x, y, z) => uAt(x, y, z) <= -sealU;
    const innerRaw = yield* isoSurface({ ref, level: lvIn, h, seeds: seedsFor(lvInFn), inside: insideIn, due, label: 'afdrukruimte' });
    inner = finishPatch(innerRaw, ref, lvInFn, { smooth: 6, h, exact: true, lvMax: gap, limitU: (x, y, z) => uAt(x, y, z) + sealU - h });
    report.innerCells = innerRaw.stats.cells; report.innerLoops = inner.loops; report.innerFilled = inner.filled;
  }
  mark('afdrukruimte');
  // 5. controle: buitenpunten te dicht bij de scan (zou niet meer moeten voorkomen)
  if (checkThin) {
    const p = outer.mesh.positions, n = p.length / 3, stride = Math.max(1, Math.floor(n / 4000)), lim = level / 3, bvh = ref.bvh;
    let thin = 0, cnt = 0;
    for (let v = 0; v < n; v += stride) { cnt++; if (bvh.closest(p[v * 3], p[v * 3 + 1], p[v * 3 + 2], lim) !== Infinity) thin++; }
    report.thin = cnt ? thin / cnt : 0;
  }
  // 6. samenstellen
  const parts = [];
  const soupOf = (mesh, flip) => { const p = mesh.positions, F = mesh.indices, out = new Float32Array(F.length * 3); for (let t = 0; t < F.length; t += 3) { const a = F[t], b = flip ? F[t + 2] : F[t + 1], c = flip ? F[t + 1] : F[t + 2]; out.set([p[a * 3], p[a * 3 + 1], p[a * 3 + 2], p[b * 3], p[b * 3 + 1], p[b * 3 + 2], p[c * 3], p[c * 3 + 1], p[c * 3 + 2]], t * 3); } return out; };
  if (inner) parts.push(flipSoup(concatSoups([loftLoops(A0, inner.loop, rn), soupOf(inner.mesh, false)])));
  else parts.push(soupOf({ positions: innerFine, indices: f }, true));
  // ringen (scanrand → afgeronde rand): scanrand (alle punten) naar de eerste gelijkmatige ring met een strook,
  // daarna ring op ring (zelfde aantal punten)
  const strip = new Float32Array(ns * 2 * Math.max(0, rings.length - 2) * 9); let o = 0;
  const put = (R, i) => { strip[o++] = R[i * 3]; strip[o++] = R[i * 3 + 1]; strip[o++] = R[i * 3 + 2]; };
  for (let k = 1; k + 1 < rings.length; k++) {
    const R0 = rings[k], R1 = rings[k + 1];
    for (let i = 0; i < ns; i++) { const a = i, b = (i + 1) % ns; put(R0, a); put(R0, b); put(R1, b); put(R0, a); put(R1, b); put(R1, a); }
  }
  // eerste strook: van de binnenring naar de eerste gelijkmatige ring (bij de scanrand: plek op de rand = tq)
  const first = freeInner ? (() => { const st = new Float32Array(ns * 6 * 3); let w = 0; const R0 = A0, R1 = rings[1]; for (let i = 0; i < ns; i++) { const a = i, b = (i + 1) % ns; for (const [R, v] of [[R0, a], [R0, b], [R1, b], [R0, a], [R1, b], [R1, a]]) { st[w++] = R[v * 3]; st[w++] = R[v * 3 + 1]; st[w++] = R[v * 3 + 2]; } } return st; })()
    : loftLoops(A, rings[1], null, 0, tq);
  parts.push(first, strip, loftLoops(T, outer.loop, rn), soupOf(outer.mesh, false));
  if (report.debug) {
    report.outerSoup = soupOf(outer.mesh, false); report.innerSoup = parts[0]; if (inner) report.innerPatch = soupOf(inner.mesh, false);
    report.probe = (x, y, z) => ({ u: uAt(x, y, z), r, h });
  }
  report.vertices = vCount;
  mark('samenstellen');
  report.ms = Math.round(performance.now() - t0);
  return concatSoups(parts);
}

// Iso-oppervlak opschonen en gladmaken: grootste stuk, geen vlinderpunten/oren, gaatjes dicht, een paar rondes
// Taubin-glad (krimpt niet) en daarna terug op (minstens) de gevraagde afstand. Geeft { mesh, loop (randlus als posities) }.
function finishPatch(raw, ref, lvFn, { smooth = 8, h = 0.4, exact = false, limitU = null, lvMax = 10 } = {}) {
  let mesh = tidySheet({ positions: raw.positions, indices: raw.indices }).mesh;
  let { loops } = boundaryLoops(mesh);
  const loopsBefore = loops.length; let filled = 0;
  if (loops.length > 1) { const fh = fillHoles(mesh, { keepLargest: true }); mesh = fh.mesh; filled = fh.filled; ({ loops } = boundaryLoops(mesh)); }
  if (!loops.length) throw Error('De buitenkant kon niet worden opgebouwd (geen rand gevonden).');
  const lens = loops.map(l => loopLength(mesh, l)), loop = loops[lens.indexOf(Math.max(...lens))];
  const p = Float32Array.from(mesh.positions), n = p.length / 3, adj = adjacency(mesh.indices, n);
  const onB = new Uint8Array(n); for (const v of loop) onB[v] = 1;
  // Taubin: λ/μ-paren, rand vast
  const tmp = new Float32Array(p.length);
  for (let it = 0; it < smooth; it++) for (const lam of [0.5, -0.53]) {
    for (let v = 0; v < n; v++) {
      const i = v * 3, c = adj.off[v + 1] - adj.off[v];
      if (onB[v] || !c) { tmp[i] = p[i]; tmp[i + 1] = p[i + 1]; tmp[i + 2] = p[i + 2]; continue; }
      let x = 0, y = 0, z = 0; for (let j = adj.off[v]; j < adj.off[v + 1]; j++) { const w = adj.nb[j] * 3; x += p[w]; y += p[w + 1]; z += p[w + 2]; }
      tmp[i] = p[i] + lam * (x / c - p[i]); tmp[i + 1] = p[i + 1] + lam * (y / c - p[i + 1]); tmp[i + 2] = p[i + 2] + lam * (z / c - p[i + 2]);
    }
    p.set(tmp);
  }
  // randlus gladmaken langs de booglengte (de traptjes van het raster)
  const L = new Float32Array(loop.length * 3); for (let i = 0; i < loop.length; i++) for (let j = 0; j < 3; j++) L[i * 3 + j] = p[loop[i] * 3 + j];
  const { cum, total } = loopArc(L), Ls = gaussLoop(L, cum, total, h * 1.2);
  for (let i = 0; i < loop.length; i++) for (let j = 0; j < 3; j++) p[loop[i] * 3 + j] = Ls[i * 3 + j];
  const bvh = ref.bvh, nrm = new Float32Array(p.length);
  // randlus binnen de plaatrand houden (anders ligt de aansluitstrook dubbel): limitU > 0 = te ver naar buiten.
  // Terugschuiven langs de richting waarin u het snelst daalt (numeriek, kleine stapjes).
  if (limitU) for (const v of loop) {
    const i = v * 3;
    for (let k = 0; k < 6; k++) {
      const d = bvh.closest(p[i], p[i + 1], p[i + 2]); if (d === Infinity) break;
      const e = limitU(p[i], p[i + 1], p[i + 2], bvh.face); if (!(e > 0) || e === Infinity) break;
      const eps = 0.05, g = [0, 0, 0];
      for (let j = 0; j < 3; j++) { p[i + j] += eps; bvh.closest(p[i], p[i + 1], p[i + 2]); g[j] = (limitU(p[i], p[i + 1], p[i + 2], bvh.face) - e) / eps; p[i + j] -= eps; }
      const gl = Math.hypot(g[0], g[1], g[2]); if (!(gl > 1e-6) || !Number.isFinite(gl)) break;
      const st = e / gl / gl; p[i] -= g[0] * st; p[i + 1] -= g[1] * st; p[i + 2] -= g[2] * st;
    }
  }
  // terug op de afstand: langs de oppervlaknormaal (twee rondes; kleine correcties, dus geen omklappen)
  for (let pass = 0; pass < (exact ? 2 : 1); pass++) {
    vertexNormalsInto(p, mesh.indices, nrm);
    for (let v = 0; v < n; v++) {
      const i = v * 3, d = bvh.closest(p[i], p[i + 1], p[i + 2], lvMax + 1); if (d === Infinity) continue;
      const lv = lvFn(bvh.face), t = d < lv ? lv - d : exact && d > lv + 0.005 ? lv - d : 0;
      if (t) { p[i] += nrm[i] * t; p[i + 1] += nrm[i + 1] * t; p[i + 2] += nrm[i + 2] * t; }
    }
  }
  const out = { positions: p, indices: mesh.indices };
  const loopPos = new Float32Array(loop.length * 3); for (let i = 0; i < loop.length; i++) for (let j = 0; j < 3; j++) loopPos[i * 3 + j] = p[loop[i] * 3 + j];
  return { mesh: out, loop: loopPos, loops: loopsBefore, filled };
}

// Randpunten van het pasvlak in het raakvlak naar de gladde randlijn schuiven (alleen langs 'naar buiten', t),
// zonder dat een aanliggende driehoek omklapt of plat wordt. A wordt bijgewerkt. Geeft de grootste verschuiving.
function relaxRim(pos, f, rim, A, As, rn) {
  const nr = rim.length, onRim = new Map(); rim.forEach((v, i) => onRim.set(v, i));
  const faces = new Map(); for (const v of rim) faces.set(v, []);
  for (let t = 0; t < f.length; t += 3) for (let k = 0; k < 3; k++) { const l = faces.get(f[t + k]); if (l) l.push(t); }
  const nrmOf = (t) => { const a = f[t] * 3, b = f[t + 1] * 3, c = f[t + 2] * 3; const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], wx = pos[c] - pos[a], wy = pos[c + 1] - pos[a + 1], wz = pos[c + 2] - pos[a + 2]; return [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx]; };
  let maxMove = 0;
  for (let i = 0; i < nr; i++) {
    const v = rim[i], o = i * 3, list = faces.get(v);
    // verschuiving: verschil met de gladde lijn, zonder de component langs de normaal (hoogte blijft)
    let dx = As[o] - A[o], dy = As[o + 1] - A[o + 1], dz = As[o + 2] - A[o + 2];
    const dn = dx * rn[o] + dy * rn[o + 1] + dz * rn[o + 2]; dx -= dn * rn[o]; dy -= dn * rn[o + 1]; dz -= dn * rn[o + 2];
    const dl = Math.hypot(dx, dy, dz); if (dl > 0.3) { const c = 0.3 / dl; dx *= c; dy *= c; dz *= c; } // hooguit 0,3 mm
    const before = list.map(nrmOf), x0 = pos[v * 3], y0 = pos[v * 3 + 1], z0 = pos[v * 3 + 2];
    let k = 1;
    for (let tries = 0; tries < 4; tries++, k /= 2) {
      pos[v * 3] = x0 + dx * k; pos[v * 3 + 1] = y0 + dy * k; pos[v * 3 + 2] = z0 + dz * k;
      let ok = true;
      for (let j = 0; j < list.length && ok; j++) {
        const nb = before[j], na = nrmOf(list[j]), lb = Math.hypot(...nb), la = Math.hypot(...na);
        if (!(la > 1e-12) || (na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2]) < 0.5 * la * lb || la < 0.2 * lb) ok = false;
      }
      if (ok) break;
      if (tries === 3) { pos[v * 3] = x0; pos[v * 3 + 1] = y0; pos[v * 3 + 2] = z0; k = 0; }
    }
    A[o] = pos[v * 3]; A[o + 1] = pos[v * 3 + 1]; A[o + 2] = pos[v * 3 + 2];
    maxMove = Math.max(maxMove, Math.hypot(dx, dy, dz) * k);
  }
  return maxMove;
}

function meshArea(mesh) {
  const p = mesh.positions, f = mesh.indices; let s = 0;
  for (let i = 0; i < f.length; i += 3) {
    const a = f[i] * 3, b = f[i + 1] * 3, c = f[i + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], wx = p[c] - p[a], wy = p[c + 1] - p[a + 1], wz = p[c + 2] - p[a + 2];
    s += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
  }
  return s;
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
  return smoothVectors(adjacency(mesh.indices, normals.length / 3), normals, iterations);
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


// Dunne uitsteeksels langs de rand weghalen (morfologisch 'openen', afstanden langs het oppervlak), maar alleen
// echte punten: stukken die meer dan 2·delta buiten de 'kern' (alles verder dan delta van de rand) uitsteken. Een
// kartelige of trapjesrand blijft zo exact staan (plaatrand = scanrand). Geeft null als er niets verandert.
function openSheet(mesh, rim, delta) {
  const n = mesh.positions.length / 3, f = mesh.indices;
  const d1 = rimDistances(mesh, [rim], delta * 1.5);
  const core = new Uint8Array(n); let coreCount = 0; for (let v = 0; v < n; v++) if (d1[v] >= delta) { core[v] = 1; coreCount++; }
  if (!coreCount) return null; // alles is smal: niet aankomen
  const isSrc = new Uint8Array(n);
  for (let t = 0; t < f.length; t += 3) { const a = f[t], b = f[t + 1], c = f[t + 2], k = core[a] + core[b] + core[c]; if (k > 0 && k < 3) { if (core[a]) isSrc[a] = 1; if (core[b]) isSrc[b] = 1; if (core[c]) isSrc[c] = 1; } }
  const srcs = []; for (let v = 0; v < n; v++) if (isSrc[v]) srcs.push([v]);
  if (!srcs.length) return null;
  const reach = delta * 2.5, d2 = rimDistances(mesh, srcs, reach);
  // facetten buiten het 'geopende' gebied, gegroepeerd in samenhangende stukken (via gedeelde punten)
  const out = new Uint8Array(f.length / 3); let any = false;
  for (let t = 0; t < f.length / 3; t++) for (let k = 0; k < 3; k++) { const v = f[t * 3 + k]; if (!core[v] && !(d2[v] <= delta * 1.15)) { out[t] = 1; any = true; break; } }
  if (!any) return null;
  const parent = new Int32Array(n); for (let v = 0; v < n; v++) parent[v] = v;
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < f.length / 3; t++) if (out[t]) { const a = find(f[t * 3]); parent[find(f[t * 3 + 1])] = a; parent[find(f[t * 3 + 2])] = find(f[t * 3]); }
  const far = new Map(); // stuk → verste afstand tot de kern
  for (let t = 0; t < f.length / 3; t++) if (out[t]) for (let k = 0; k < 3; k++) { const v = f[t * 3 + k], r = find(v), d = d2[v] === Infinity ? reach * 2 : d2[v]; if (!(far.get(r) >= d)) far.set(r, d); }
  const keep = []; let removed = 0;
  for (let t = 0; t < f.length / 3; t++) {
    if (out[t] && far.get(find(f[t * 3])) > 2 * delta) { removed++; continue; }
    keep.push(f[t * 3], f[t * 3 + 1], f[t * 3 + 2]);
  }
  if (!removed) return null;
  const t = tidySheet({ positions: mesh.positions, indices: Uint32Array.from(keep) });
  const res = t.mesh; res.removed = removed + t.removed;
  return res;
}
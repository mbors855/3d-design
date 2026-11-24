// Headless tests (Node 20+):  node tests/run.mjs
// Dekken de rekenmodules die in v61 zijn toegevoegd of op echte scans zijn aangepast.
import assert from 'node:assert/strict';
const J = '../js/';
const { parseName, parse3ox, parseInf, universalToFDI, jawOfTooth, analyseOrders, simulatePrint, classifyGeometry, levenshtein, orderStem } = await import(J + 'orders.js');
const { listZip, readZipEntry } = await import(J + 'unzip.js');
const { makeZip } = await import(J + 'zip.js');
const { weld, quality, tidySheet, boundaryLoops, pointToSurfaceDistances } = await import(J + 'mesh.js');
const { shell } = await import(J + 'shell.js');
const { extractIntaglio } = await import(J + 'intaglio.js');
const { demoJaw } = await import(J + 'demo.js');
const { autoLandmarks, occlusalAxis } = await import(J + 'analysis.js');
const { Sculpt } = await import(J + 'sculpt.js');
const { anatomicJaw } = await import(J + 'demo.js');
const { archFrame } = await import(J + 'setup.js');
const A = await import(J + 'anatomy.js');
const { validContour } = await import(J + 'contour.js');
// eenvoudige 'straal van boven' voor hoogtevelden (z = occlusaal), zonder three.js
function verticalCaster(soup, cell = 1) {
  const grid = new Map(), key = (x, y) => Math.floor(x / cell) + ',' + Math.floor(y / cell);
  for (let f = 0; f < soup.length / 9; f++) { const o = f * 9, xs = [soup[o], soup[o + 3], soup[o + 6]], ys = [soup[o + 1], soup[o + 4], soup[o + 7]];
    for (let x = Math.floor(Math.min(...xs) / cell); x <= Math.floor(Math.max(...xs) / cell); x++) for (let y = Math.floor(Math.min(...ys) / cell); y <= Math.floor(Math.max(...ys) / cell); y++) { const k = x + ',' + y; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(f); } }
  return (o, d) => {
    let best = null;
    for (const f of grid.get(key(o[0], o[1])) ?? []) {
      const b = f * 9, ax = soup[b], ay = soup[b + 1], bx = soup[b + 3], by = soup[b + 4], cx = soup[b + 6], cy = soup[b + 7];
      const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy); if (Math.abs(det) < 1e-12) continue;
      const w1 = ((by - cy) * (o[0] - cx) + (cx - bx) * (o[1] - cy)) / det, w2 = ((cy - ay) * (o[0] - cx) + (ax - cx) * (o[1] - cy)) / det, w3 = 1 - w1 - w2;
      if (w1 < -1e-9 || w2 < -1e-9 || w3 < -1e-9) continue;
      const z = w1 * soup[b + 2] + w2 * soup[b + 5] + w3 * soup[b + 8];
      if (z < o[2] && (!best || z > best[2])) best = [o[0], o[1], z];
    }
    return best ? { point: best } : null;
  };
}

let pass = 0, fail = 0;
async function test(name, fn) { try { await fn(); pass++; console.log('✓', name); } catch (e) { fail++; console.log('✗', name, '\n   ', e.message); } }

await test('naam: patiënt eerst', () => { const n = parseName('jansen 1234 beetplaat ok_0.stl'); assert.equal(n.orderNo, '1234'); assert.equal(n.product, 'beetplaat'); assert.equal(n.jaw, 'ok'); assert.equal(n.patient, 'jansen'); });
await test('naam: product eerst + hoofdletters', () => { const n = parseName('Lepel bk 5678 Pietersen_0_01.stl'); assert.equal(n.base, 'Lepel bk 5678 Pietersen'); assert.equal(n.jaw, 'bk'); assert.equal(n.patient, 'pietersen'); });
await test('naam: kaak vastgeplakt', () => { const n = parseName('devriesbk 0042.stl'); assert.equal(n.jaw, 'bk'); assert.equal(n.patient, 'devries'); });
await test('naam: ACTA met datum', () => { const n = parseName('bakker_bk_acta_19_11_2026.stl'); assert.equal(n.date, '2026-11-19'); assert.equal(n.orderNo, null); assert.equal(orderStem('bakker_bk_acta_19_11_2026.stl'), 'bakker_bk_acta_19_11_2026'); });
await test('naam: vp/vb en kleur', () => { assert.equal(parseName('ten berge vp copydenture 0819_1.stl').jaw, 'ok+bk'); const n = parseName('smit po a3.5 0777_2.stl'); assert.equal(n.shade, 'A3.5'); assert.equal(n.product, 'provisorium'); });
await test('universeel → FDI', () => { assert.equal(universalToFDI(18), 37); assert.equal(universalToFDI(1), 18); assert.equal(universalToFDI(16), 28); assert.equal(universalToFDI(32), 48); assert.equal(jawOfTooth(46), 'ok'); assert.equal(jawOfTooth(16), 'bk'); });
await test('3ox en inf lezen', () => {
  const ox = parse3ox(`<OrderInfo><ThreeShapeOrderNo>x 1234 lepel ok</ThreeShapeOrderNo><OperatorID>paula</OperatorID><CaseTypeID>Customized impression tray 37</CaseTypeID><DeliveryDate>2026-11-16T10:00:00Z</DeliveryDate><Material>"Denture base"</Material></OrderInfo><ModelElement displayName="Tray"><TypeID uNN="18" typeID="a" typeClass="CustomImpressionTray"/><Material displayName="Denture base" materialFamily="None">m</Material><CAMFile path="\\\\NAS\\x 1234 lepel ok_0.stl"/></ModelElement>`);
  assert.equal(ox.operator, 'paula'); assert.equal(ox.delivery, '2026-11-16'); assert.deepEqual(ox.elements[0].teeth, [37]); assert.deepEqual(ox.elements[0].cam, ['x 1234 lepel ok_0.stl']);
  const inf = parseInf('ThreeShapeOrderNo: x\r\nTooth No. / Type of restoration: 46/Temporary\r\nDelivery date: 2026-11-17\r\n'); assert.equal(inf.tooth, 46); assert.equal(inf.restorationType, 'Temporary');
});
await test('controles: kaak tegen FDI, spelling, fragment', () => {
  const m = (v, t = 5000) => ({ triangles: t, watertight: true, open: 0, nonManifold: 0, components: 1, volume: v, area: v, dims: [60, 50, 20], meanWall: 2, flatUp: 10 });
  const r = analyseOrders([
    { name: 'jansen 1111 lepel ok_0.stl', metrics: m(6000) }, { name: 'jansen 1111 lepel ok_0.inf', text: 'Tooth No. / Type of restoration: 16/Not specified' },
    { name: 'jansn 1111 lepel bk_0_00.stl', metrics: m(6000) }, { name: 'jansn 1111 lepel bk_0_01.stl', metrics: m(0.1, 100) },
  ], { today: '2026-01-01' });
  const all = r.orders.flatMap(o => o.issues.map(i => i[1])).join('\n');
  assert.match(all, /Naam zegt OK/); assert.match(all, /Spelling patiëntnaam/); assert.match(all, /mini-fragment/);
  assert.equal(r.patients.length, 1);
});
await test('levenshtein', () => { assert.equal(levenshtein('pietersen', 'pitersen'), 1); assert.equal(levenshtein('vandenberg', 'vandenbreg'), 2); });
await test('printsimulatie verdeelt over platen', () => {
  const parts = Array.from({ length: 20 }, (_, i) => ({ id: 'p' + i, label: 'p' + i, dims: [68, 55, 22], volume: 8000 }));
  const s = simulatePrint(parts, { printer: 'ultra50', orientation: 'staand' });
  assert.ok(s.plates.length >= 2 && s.plates.length <= 4, 'platen ' + s.plates.length); assert.equal(s.tooBig.length, 0);
  assert.equal(s.plates.reduce((a, p) => a + p.items.length, 0), 20); assert.ok(Math.abs(s.resinMl - 20 * 8 * 1.35) < 1);
});
await test('zip: schrijven en stapsgewijs lezen', async () => {
  const zip = makeZip([{ name: 'a.inf', data: 'hallo' }, { name: 'map/b.stl', data: new Uint8Array([1, 2, 3]) }]);
  const buf = zip instanceof Blob ? await zip.arrayBuffer() : (zip.buffer ? zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) : zip);
  const e = await listZip(buf); assert.deepEqual(e.map(x => x.name), ['a.inf', 'map/b.stl']);
  assert.equal(new TextDecoder().decode(await readZipEntry(buf, e[0])), 'hallo');
});
await test('tidySheet: vlinderpunt wordt opgelost', () => {
  // twee driehoeken die elkaar in één punt raken + een los driehoekje
  // twee fijne vlakjes (raster) die elkaar in één hoekpunt raken + een los driehoekje
  const grid = (ox, oy, n = 6) => { const o = []; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const x = ox + i, y = oy + j; o.push(x, y, 0, x + 1, y, 0, x + 1, y + 1, 0, x, y, 0, x + 1, y + 1, 0, x, y + 1, 0); } return o; };
  const soup = Float32Array.from([...grid(0, 0), ...grid(-6, -6, 6), 50, 50, 0, 51, 50, 0, 50, 51, 0]);
  const before = weld(soup, 1e-6); assert.equal(boundaryLoops(before).branching, true);
  const t = tidySheet(before); assert.equal(boundaryLoops(t.mesh).branching, false); assert.ok(t.mesh.indices.length / 3 >= 60, 'faces ' + t.mesh.indices.length / 3);
});
const jaw = demoJaw();
const plate = shell(jaw, { gap: 0, wall: 2 });
await test('schaal op demo-kaak gesloten', () => { assert.equal(quality(weld(plate, 1e-5)).watertight, true); });
await test('weefselzijde terug uit gesloten plaat ≈ originele kaak', () => {
  const z = s => { let t = 0; for (let i = 2; i < s.length; i += 3) t += s[i]; return t / (s.length / 3); };
  const side = z(plate) > z(jaw) ? -1 : 1;
  const { soup } = extractIntaglio(plate, { side });
  const qa = quality(weld(soup, 1e-5)), qj = quality(weld(jaw, 1e-5));
  assert.ok(Math.abs(qa.area - qj.area) / qj.area < 0.08, `oppervlak ${qa.area.toFixed(0)} vs ${qj.area.toFixed(0)}`);
  const again = shell(soup, { gap: 0, wall: 2 }); assert.equal(quality(weld(again, 1e-5)).watertight, true);
  assert.ok(z(again) * -side > z(soup) * -side - 1e-6, 'nieuwe plaat groeit van het weefsel af');
});
await test('autoLandmarks: geen stack overflow bij veel punten', () => {
  const big = new Float32Array(jaw.length * 4); for (let k = 0; k < 4; k++) big.set(jaw, k * jaw.length);
  const lm = autoLandmarks(big, occlusalAxis(big)); assert.ok(lm.R && lm.M && lm.L);
});
await test('wand nergens dunner dan ingesteld (v69: buitenkant op de afstand tot de scan)', () => {
  const rep = { debug: true }; shell(jaw, { gap: 0, wall: 2 }, rep);
  assert.equal(rep.method, 'iso');
  const d = pointToSurfaceDistances(rep.outerSoup, jaw, { maxDist: 5 });
  let min = Infinity, max = 0; for (const x of d) { if (x < min) min = x; if (x > max && x !== Infinity) max = x; }
  assert.ok(min >= 2 - 0.02, 'dunste plek ' + min.toFixed(3));
  assert.ok(max <= 2 + 1.2, 'dikste plek ' + max.toFixed(3));
  // oude methode blijft beschikbaar (weefselblok)
  const r2 = {}; shell(jaw, { gap: 0, wall: 2, method: 'normal' }, r2); assert.ok(r2.maxScale >= 1 && r2.maxScale <= 1.3 + 1e-6);
});
await test('geometrie-indeling', () => {
  assert.equal(classifyGeometry({ volume: 0.5, triangles: 100, dims: [1, 1, 1] }), 'fragment');
  assert.equal(classifyGeometry({ volume: 150, triangles: 9000, dims: [8, 9, 7], meanWall: 1.3, flatUp: 2 }), 'provisorium');
  assert.equal(classifyGeometry({ volume: 15000, triangles: 9e4, dims: [65, 55, 25], meanWall: 3, flatUp: 600 }), 'beetwal');
  assert.equal(classifyGeometry({ volume: 5000, triangles: 9e4, dims: [65, 55, 20], meanWall: 1.9, flatUp: 60 }), 'plaat');
});

await test('penselen: toevoegen/wegnemen/gladmaken, pasvlak beschermd, blijft gesloten, ongedaan maken', () => {
  const vol = s => Math.abs(quality(weld(s, 1e-5)).volume);
  // pasvlak = punten die op de kaak liggen (binnenkant van de plaat)
  const onJaw = new Set(); const jw = weld(jaw, 1e-5); for (let i = 0; i < jw.positions.length; i += 3) onJaw.add(jw.positions[i].toFixed(3) + ',' + jw.positions[i + 1].toFixed(3) + ',' + jw.positions[i + 2].toFixed(3));
  const sc = new Sculpt(plate, { protect: (i, x, y, z) => onJaw.has(x.toFixed(3) + ',' + y.toFixed(3) + ',' + z.toFixed(3)) });
  assert.ok(sc.lockedCount > 0 && sc.lockedCount < sc.count, 'beschermd ' + sc.lockedCount);
  const locked = []; for (let i = 0; i < sc.count; i++) if (sc.locked[i]) locked.push(i, sc.positions[i * 3 + 2]);
  // midden van de buitenkant zoeken: hoogste niet-beschermde punt
  let top = -1; for (let i = 0; i < sc.count; i++) if (!sc.locked[i] && (top < 0 || sc.positions[i * 3 + 2] > sc.positions[top * 3 + 2])) top = i;
  const c = [sc.positions[top * 3], sc.positions[top * 3 + 1], sc.positions[top * 3 + 2]], n = [sc.normals[top * 3], sc.normals[top * 3 + 1], sc.normals[top * 3 + 2]];
  const v0 = vol(sc.toSoup());
  sc.begin(); for (let k = 0; k < 5; k++) sc.dab('add', c, n, { radius: 5, strength: 0.3 }); sc.end();
  const v1 = vol(sc.toSoup()); assert.ok(v1 > v0 + 5, `toevoegen ${v0.toFixed(0)} → ${v1.toFixed(0)}`);
  sc.begin(); for (let k = 0; k < 10; k++) sc.dab('remove', c, n, { radius: 5, strength: 0.3 }); sc.end();
  assert.ok(vol(sc.toSoup()) < v0, 'wegnemen');
  sc.begin(); for (let k = 0; k < 5; k++) sc.dab('smooth', c, n, { radius: 6, strength: 0.8 }); sc.end();
  for (let k = 0; k < locked.length; k += 2) assert.equal(sc.positions[locked[k] * 3 + 2], locked[k + 1], 'pasvlak bewoog');
  assert.equal(quality(weld(sc.toSoup(), 1e-5)).open, 0, 'open randen na bewerken');
  sc.undo(); sc.undo(); sc.undo(); assert.ok(Math.abs(vol(sc.toSoup()) - v0) < 1e-3, 'ongedaan maken');
  sc.redo(); assert.ok(Math.abs(vol(sc.toSoup()) - v1) < 1e-3, 'opnieuw');
  // verschuiven met symmetrie
  sc.grab(c, 4, { O: [0, c[1], 0], X: [1, 0, 0] }); sc.dragTo([0, 0, 1]); sc.release();
  assert.ok(sc.positions[top * 3 + 2] > c[2] + 0.5, 'verschuiven');
});

for (const jawName of ['upper', 'lower']) {
  await test(`anatomie ${jawName}: plooi, frenula, omtrek, zones, ideaal`, () => {
    const { soup, truth } = anatomicJaw({ jaw: jawName, torus: jawName === 'upper' });
    const lm = autoLandmarks(soup, { ...occlusalAxis(soup), axis: [0, 0, 1] });
    assert.ok(Math.abs(lm.M[1] - truth.M[1]) < 3, `M op de kam (y ${lm.M[1].toFixed(1)} vs ${truth.M[1]})`);
    const frame = archFrame(lm, jawName, [0, 0, 1]), cast = verticalCaster(soup);
    const an = A.analyseArch(cast, frame);
    const sd = an.profiles.filter(p => p.buccal?.sulcus).map(p => p.buccal.sulcus.d).sort((a, b) => a - b), med = sd[Math.floor(sd.length / 2)];
    assert.ok(Math.abs(med - truth.sulcusD) < 1, `plooi-afstand ${med.toFixed(1)} vs ${truth.sulcusD}`);
    assert.ok(Math.abs(an.stats.sulcusDepthMedian - truth.sulcusDepth) < 1, 'plooidiepte');
    const labial = an.frena.filter(f => f.side === 'buccal' && Math.abs(f.at[0]) < 4);
    assert.ok(labial.length >= 1, 'labiaal frenulum gevonden');
    assert.ok(an.frena.filter(f => f.side === 'buccal').length >= 3, 'drie buccale/labiale frenula');
    if (jawName === 'lower') assert.ok(an.frena.some(f => f.side === 'lingual'), 'tongriem gevonden');
    for (const kind of ['lepel', 'beetplaat']) { const o = A.proposeOutline(cast, an, kind); assert.ok(validContour(o.points.map(p => [p[0] * 10, p[1] * 10])), 'omtrek ' + kind + ' kruist zichzelf'); }
    // lepel ligt binnen de beetplaat (2 mm korter dan de plooi): gemiddeld hoger (dichter bij de kam)
    const h = pts => pts.reduce((t, p) => t + p[2], 0) / pts.length;
    assert.ok(h(A.proposeOutline(cast, an, 'lepel').points) > h(A.proposeOutline(cast, an, 'beetplaat').points) + 0.8, 'lepelrand korter dan beetplaatrand');
    const zi = A.tissueZones(soup, an);
    assert.equal(!!zi.torus, jawName === 'upper', 'torus-herkenning');
    const cnt = z => zi.zones.filter(v => v === z).length;
    assert.ok(cnt(A.ZONE.primary) > 0 && cnt(A.ZONE.relief) > 0 && cnt(A.ZONE.seal) > 0, 'alle zonetypes aanwezig');
    const id = A.idealizeScan(soup, zi, { frame });
    assert.ok(id.report.relieved > 0, 'ontlast'); if (jawName === 'upper') assert.ok(id.report.postDam > 0, 'post-dam');
    assert.equal(id.soup.length, soup.length, 'zelfde topologie');
  });
}

// ---------- v63: kamlijn, opstelling op de kam, plooiregel ----------
const T = await import(J + 'teeth.js');
const C = await import(J + 'construct.js');
const { placeTeeth } = await import(J + 'setup.js');
function crestSetup(jawName, asym = 1) {
  const { soup, truth } = anatomicJaw({ jaw: jawName, asym });
  const lm = autoLandmarks(soup, { ...occlusalAxis(soup), axis: [0, 0, 1] });
  const frame = archFrame(lm, jawName, [0, 0, 1]), cast = verticalCaster(soup);
  const an1 = A.analyseArch(cast, frame), an = A.analyseArch(cast, frame, { arch: A.crestArch(an1) });
  const world = (x, y) => [0, 1].map(i => frame.O[i] + frame.X[i] * x + frame.Y[i] * y);
  const dTruth = ([wx, wy]) => { let b = Infinity; for (let x = -truth.archY.xEnd; x <= truth.archY.xEnd; x += 0.1) b = Math.min(b, Math.hypot(wx - x, wy - truth.crestY(x))); return b; };
  const err = arch => { const e = []; for (let t = -0.85; t <= 0.85; t += 0.05) { const w = world(...arch(t)); if (Math.abs(w[0]) < truth.archY.xEnd - 2) e.push(dTruth(w)); } return Math.max(...e); };
  return { soup, truth, frame, cast, an, world, dTruth, err };
}
for (const jawName of ['upper', 'lower']) {
  await test(`kamlijn ${jawName}: gemeten boog volgt een scheve kam (beter dan parabool)`, () => {
    const { frame, an, err } = crestSetup(jawName);
    const crest = A.crestArch(an), eC = err(crest), eP = err(T.formArch({ width: frame.width, depth: frame.depth }));
    assert.ok(eC < 0.8, `kamlijn max ${eC.toFixed(2)} mm`);
    assert.ok(eP > eC + 0.3, `parabool ${eP.toFixed(2)} vs kamlijn ${eC.toFixed(2)}`);
  });
  await test(`opstelling ${jawName}: zijdelingse tanden boven de kam, front labiaal, occlusievlak volgens plooiregel`, () => {
    const { frame, an, world, dTruth, truth } = crestSetup(jawName);
    const arch = A.setupArch(an, { concept: 'gysi' }), rule = A.occlusalPlaneRule(an);
    const exp = jawName === 'upper' ? [-9 + 22, -9 + 18] : [-8 + 18, null];
    assert.ok(Math.abs(rule.front - exp[0]) < 1.5, `voor ${rule.front.toFixed(1)} vs ${exp[0]}`);
    if (exp[1] != null) assert.ok(Math.abs(rule.back - exp[1]) < 2, `achter ${rule.back.toFixed(1)}`);
    assert.ok(rule.back < rule.front, 'occlusievlak achter lager dan voor (t.o.v. de kam)');
    const ids = jawName === 'upper' ? T.FDI_UPPER.filter(i => i % 10 <= 7) : T.FDI_LOWER.filter(i => i % 10 <= 7);
    const placed = placeTeeth(ids, frame, { arch, occlusalHeight: rule.at, concept: 'gysi' });
    for (const t of placed) {
      const w = world(...t.arch2d), d = dTruth(w), type = t.fdi % 10;
      if (type >= 4 && type <= 6) assert.ok(d < (type === 4 ? 1.6 : 1.2), `${t.fdi} ${d.toFixed(2)} mm naast de kam`);
      if (type === 1 && jawName === 'upper') assert.ok(d > 2.5 && d < 5.5 && w[1] > truth.crestY(w[0]), `${t.fdi} labiaal ${d.toFixed(2)} mm`);
    }
    const front = placed.find(t => t.fdi % 10 === 1).planeHeight, back = placed.find(t => t.fdi % 10 === 7).planeHeight;
    assert.ok(Math.abs(front - rule.front) < 0.8 && back < front, `vlak ${front.toFixed(1)} → ${back.toFixed(1)}`);
    // beetwal op dezelfde boog met plooiregel-hoogte: gesloten
    const rim = C.biteRim(frame, { arch, height: t => rule.at(Math.abs(t), 1), width: 8, anteriorWidth: 5 });
    assert.ok(quality(weld(rim, 1e-6)).watertight, 'beetwal gesloten');
  });
}

await test('statiek: boven de kam ok, 3 mm buccaal en voorbij de kam worden gemeld', () => {
  const { frame, an } = crestSetup('lower', 0);
  const arch = A.setupArch(an), ids = T.FDI_LOWER;
  const placed = placeTeeth(ids, frame, { arch, occlusalHeight: 10 });
  const teeth = placed.map(t => ({ fdi: t.fdi, x: t.arch2d[0], y: t.arch2d[1] }));
  const rep = A.staticsReport(teeth, an);
  for (const r of rep.filter(r => [4, 5, 6].includes(r.fdi % 10))) assert.equal(r.level, 'ok', `${r.fdi}: ${r.msg}`);
  assert.ok(rep.some(r => r.fdi % 10 === 8 && r.beyond > 2 && r.level === 'warn'), 'verstandskies voorbij de pad gemeld');
  const t46 = placed.find(t => t.fdi === 46), ys = A.crestArch(an).points.map(p => p[1]); // verschuif 3 mm weg van het boogmidden
  const c = [0, Math.min(...ys) + 0.35 * (Math.max(...ys) - Math.min(...ys))], v = [t46.arch2d[0] - c[0], t46.arch2d[1] - c[1]], l = Math.hypot(...v);
  const moved = A.staticsReport([{ fdi: 46, x: t46.arch2d[0] + v[0] / l * 3, y: t46.arch2d[1] + v[1] / l * 3 }], an)[0];
  assert.equal(moved.level, 'warn', moved.msg); assert.ok(moved.offset > 2, 'buccaal');
});

// ---------- v64: scan voorbereiden, exacte uitsnede, aanvullen ----------
const PR = await import(J + 'prep.js');
const TR = await import(J + 'trim.js');
function dirtyJaw(jawName = 'upper') {
  const { soup, truth } = anatomicJaw({ jaw: jawName });
  const extra = [];
  const tri = (a, b, c) => extra.push(...a, ...b, ...c);
  // los eilandje (scanvlek) boven de kaak, sokkelplaat (groot!) 12 mm onder de kaak, dubbele facetten
  for (let i = 0; i < 6; i++) tri([60 + i, 0, 5], [61 + i, 0, 5], [60 + i, 1, 5]);
  for (let x = -40; x < 40; x += 4) for (let y = -25; y < 50; y += 4) { tri([x, y, -14], [x, y + 4, -14], [x + 4, y, -14]); tri([x + 4, y, -14], [x, y + 4, -14], [x + 4, y + 4, -14]); }
  for (let k = 0; k < 90; k++) extra.push(soup[k]);
  const all = new Float32Array(soup.length + extra.length); all.set(soup); all.set(extra, soup.length);
  // spikes: drie punten 3 mm omhoog trekken
  const spiked = all.slice(); const targets = [[0, 20], [10, 25], [-12, 22]];
  for (const [tx, ty] of targets) { let best = -1, bd = 1e9; for (let i = 0; i < soup.length; i += 3) { const d = Math.hypot(soup[i] - tx, soup[i + 1] - ty); if (d < bd) { bd = d; best = i; } }
    const ox = soup[best], oy = soup[best + 1], oz = soup[best + 2]; for (let i = 0; i < soup.length; i += 3) if (soup[i] === ox && soup[i + 1] === oy && soup[i + 2] === oz) spiked[i + 2] = oz + 3; }
  return { soup: spiked, clean: soup, truth };
}
await test('scan voorbereiden: eilandjes, spikes, dubbele facetten weg; punten niet verschoven', () => {
  const { soup, clean: orig } = dirtyJaw();
  const a = PR.analyzeScan(soup);
  assert.ok(a.components >= 3 && a.spikes >= 3, `analyse: ${a.components} delen, ${a.spikes} spikes`);
  const { soup: rep, report } = PR.repairScan(soup);
  assert.ok(report.spikes >= 3 && report.duplicate >= 10 && report.islands >= 1, JSON.stringify(report));
  const set = new Set(); for (let i = 0; i < orig.length; i += 3) set.add(orig[i] + ',' + orig[i + 1] + ',' + orig[i + 2]);
  for (let i = 0; i < report.designedFrom * 9; i += 3) assert.ok(set.has(rep[i] + ',' + rep[i + 1] + ',' + rep[i + 2]) || rep[i + 2] === -14, 'punt verschoven');
});
for (const jawName of ['upper', 'lower']) await test(`uitsnede ${jawName}: langs de omtrek, sokkel weg, pasvlak exact, één rand`, () => {
  const { soup } = dirtyJaw(jawName);
  const { soup: rep } = PR.repairScan(soup);
  const lm = autoLandmarks(rep, { ...occlusalAxis(rep), axis: [0, 0, 1] });
  const frame = archFrame(lm, jawName, [0, 0, 1]), cast = verticalCaster(rep);
  const an = A.analyseArch(cast, frame), ol = A.proposeOutline(cast, an, 'basis');
  const t = TR.trimByOutline(rep, ol.points, frame.N, { margin: 0 });
  const m = weld(t.soup, 1e-6), q = quality(m);
  assert.equal(q.holes, 1, `${q.holes} randen`); assert.equal(q.nonManifold, 0);
  let minZ = Infinity; for (let i = 2; i < t.soup.length; i += 3) minZ = Math.min(minZ, t.soup[i]);
  assert.ok(minZ > -13, 'sokkel verwijderd');
  assert.ok(t.report.kept > 1000 && t.report.clipped > 50, JSON.stringify(t.report));
  // rand ligt op de omtrek: geprojecteerde randpunten op ≤ 0,05 mm van de gladde lijn
  const basis = TR.axisBasis(frame.N), field = new TR.PolygonField(t.polygon), loops = boundaryLoops(m).loops;
  const origV = new Set(); for (let i = 0; i < rep.length; i += 3) origV.add(rep[i] + ',' + rep[i + 1] + ',' + rep[i + 2]);
  let worst = 0, onLine = 0, scanEdge = 0;
  for (const v of loops[0]) { const P = [m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]], [u, w] = basis.project(P), d = field.distance(u, w);
    if (origV.has(P.join(',')) && d > 0.05) { scanEdge++; continue; } // omtrek ligt hier buiten de scan: rand = scanrand
    worst = Math.max(worst, d); onLine++; }
  assert.ok(worst < 0.05, `rand ${worst.toFixed(3)} mm naast de lijn`);
  assert.ok(onLine > scanEdge, `${onLine} op de lijn, ${scanEdge} op de scanrand`);
  // met marge 4 mm: groter
  const t4 = TR.trimByOutline(rep, ol.points, frame.N, { margin: 4 });
  assert.ok(t4.soup.length > t.soup.length * 1.1, 'marge vergroot de uitsnede');
});
await test('aanvullen: scan die vóór de plooi ophoudt wordt verlengd (ontworpen deel apart, geen naden)', () => {
  const { soup } = anatomicJaw({ jaw: 'upper' });
  const lm = autoLandmarks(soup, { ...occlusalAxis(soup), axis: [0, 0, 1] });
  const frame = archFrame(lm, 'upper', [0, 0, 1]), cast = verticalCaster(soup);
  const an = A.analyseArch(cast, frame);
  // scan houdt 3 mm buccaal van de kam op (zoals de weefselzijde van een 3Shape-beetplaat): omtrek op 3 mm
  const pts = an.profiles.filter(p => p.buccal?.pts?.length > 8).map(p => p.buccal.pts.find(q => q.d >= 3).p);
  const pal = [[0, 5, 0]]; // palatinaal binnen de boog: omtrek sluiten via de achterkant
  const short = TR.trimByOutline(soup, [...pts, [pts.at(-1)[0], pts.at(-1)[1] - 6, 0], [pts[0][0], pts[0][1] - 6, 0]], frame.N).soup;
  const an2 = A.analyseArch(verticalCaster(short), frame);
  assert.ok(an2.stats.edge > an2.stats.profiles * 0.6, 'plooi niet gescand');
  const ext = PR.extendBorder(short, { length: 6 });
  const m = weld(ext.soup, 1e-6), q = quality(m);
  assert.equal(q.nonManifold, 0); assert.equal(q.holes, 1);
  assert.ok(ext.soup.length / 9 > ext.report.designedFrom + 100, 'ontworpen facetten toegevoegd');
  const an3 = A.analyseArch(verticalCaster(ext.soup), frame);
  const reach = s => Math.max(...s.profiles.filter(p => p.buccal?.pts?.length).map(p => p.buccal.pts.at(-1).d));
  assert.ok(reach(an3) > reach(an2) + 3, `verder gescand: ${reach(an2).toFixed(1)} → ${reach(an3).toFixed(1)} mm`);
});

await test('was: ondersnijdingen langs een schuine insteekas opvullen, bewerken, scan onveranderd', async () => {
  const { WaxLayer } = await import(J + 'wax.js');
  const { soup } = anatomicJaw({ jaw: 'upper' });
  const a = 30 * Math.PI / 180, axis = [0, Math.sin(a), Math.cos(a)];
  const overhang = s2 => { let n = 0, tot = 0; for (let i = 0; i < s2.length; i += 9) { const u = [s2[i + 3] - s2[i], s2[i + 4] - s2[i + 1], s2[i + 5] - s2[i + 2]], v = [s2[i + 6] - s2[i], s2[i + 7] - s2[i + 1], s2[i + 8] - s2[i + 2]];
    const nn = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], l = Math.hypot(...nn); if (l < 1e-9) continue; tot += l; if ((nn[0] * axis[0] + nn[1] * axis[1] + nn[2] * axis[2]) / l < -0.02) n += l; } return n / tot; };
  const w = new WaxLayer(soup, axis), before = overhang(soup), r = w.blockout(2);
  assert.ok(before > 0.005 && r.changed > 50, `ondersnijding ${(before * 100).toFixed(1)}%, ${r.changed} punten was`);
  const after = overhang(w.waxedSoup());
  assert.ok(after < before * 0.4, `na uitblokken ${(after * 100).toFixed(2)}% (was ${(before * 100).toFixed(1)}%)`);
  const st = w.stats(); w.snap(); w.brush('remove', [0, 30, 0], { radius: 50, strength: 100 }); assert.equal(w.stats().points, 0, 'wegnemen tot 0');
  w.undo(); assert.equal(w.stats().points, st.points, 'ongedaan maken');
  assert.deepEqual(Array.from(w.soup.slice(0, 30)), Array.from(soup.slice(0, 30)), 'scan onveranderd');
});

// ---------- v65: tandenbibliotheek, opstelling, articulator, inslijpen ----------
{
  const THREE = await import('three');
  const BVH = await import('../vendor/three-mesh-bvh.module.js');
  THREE.BufferGeometry.prototype.computeBoundsTree = BVH.computeBoundsTree; THREE.Mesh.prototype.raycast = BVH.acceleratedRaycast;
  const { parseOFF } = await import(J + 'off.js');
  const L = await import(J + 'library.js');
  const { edgeMap } = await import(J + 'mesh.js');
  // open 'kroon': halve bol, hals open in het vlak z = 0 (exocad-lokaal: z = occlusaal)
  function crownOFF(rx = 4, ry = 3.5, rz = 5, seg = 24, rings = 10, closed = false) {
    const V = [], F = [];
    for (let r = 0; r <= rings; r++) { const t = r / rings * Math.PI / 2; for (let k = 0; k < seg; k++) { const a = k / seg * 2 * Math.PI; V.push([rx * Math.cos(t) * Math.cos(a), ry * Math.cos(t) * Math.sin(a), rz * Math.sin(t) - 1]); } }
    const top = V.length; V.push([0, 0, rz - 1]);
    for (let r = 0; r < rings; r++) for (let k = 0; k < seg; k++) { const a = r * seg + k, b = r * seg + (k + 1) % seg, c = a + seg, d = b + seg; F.push([a, b, d], [a, d, c]); }
    for (let k = 0; k < seg; k++) F.push([rings * seg + k, rings * seg + (k + 1) % seg, top]);
    if (closed) { const bot = V.length; V.push([0, 0, -8]); for (let k = 0; k < seg; k++) F.push([(k + 1) % seg, k, bot]); } // 'wortel': gesloten tand
    const head = new TextEncoder().encode('OFF BINARY\n'), buf = new ArrayBuffer(head.length + 12 + V.length * 12 + F.length * 14), dv = new DataView(buf);
    new Uint8Array(buf).set(head); let p = head.length;
    dv.setInt32(p, V.length, true); dv.setInt32(p + 4, F.length, true); dv.setInt32(p + 8, 0, true); p += 12;
    for (const v of V) for (const c of v) { dv.setFloat32(p, c, true); p += 4; }
    for (const f of F) { dv.setUint16(p, 3, true); p += 2; for (const i of f) { dv.setInt32(p, i, true); p += 4; } }
    return new Uint8Array(buf);
  }
  const bowXML = jaw => { const q = jaw === 'upper' ? [1, 2] : [4, 3]; let x = '<ToothBow>';
    for (const qq of q) for (let t = 1; t <= 8; t++) { const side = (qq === 1 || qq === 4) ? -1 : 1, s = (t - 0.5) * 8, a = s / 40;
      x += `<ModelTooth><Number>${qq * 10 + t}</Number><Position><x>${side * 30 * Math.sin(a)}</x><y>${30 * Math.cos(a)}</y><z>0</z></Position><AxisOcclusal><x>0</x><y>${t <= 3 ? 0.17 : -0.1}</y><z>0.98</z></AxisOcclusal><AxisMesial><x>${-side * Math.cos(a)}</x><y>${Math.sin(a)}</y><z>0</z></AxisMesial></ModelTooth>`; }
    return x + '</ToothBow>'; };
  const fakeFiles = () => { const out = []; const add = (path, bytes) => out.push({ name: path.split('/').pop(), webkitRelativePath: path, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    for (const j of ['upperjaw', 'lowerjaw']) { for (let t = 1; t <= 8; t++) add(`Lib/teeth/Test Set/${j}/${t}.eoff`, crownOFF(3 + t * 0.2)); add(`Lib/teeth/Test Set/${j}/1-reduced-thimble.eoff`, crownOFF()); add(`Lib/metadata/Test Set/${j}.xml`, new TextEncoder().encode(bowXML(j === 'upperjaw' ? 'upper' : 'lower'))); }
    return out; };

  await test('v65 OFF BINARY (exocad, 16-bits aantallen) inlezen', () => {
    const m = parseOFF(crownOFF());
    assert.equal(m.indices.length % 3, 0); assert.ok(m.positions.length / 3 > 200);
    assert.ok(Math.max(...m.indices) < m.positions.length / 3);
  });
  await test('v65 AES: FIPS-197-vectoren + WinZip-AES ontsleutelen met wachtwoord', async () => {
    const { expandKey, encryptBlock, ctrWinZip, decryptWinZip } = await import(J + 'aes.js');
    const o = new Uint32Array(4); encryptBlock(expandKey(Uint8Array.from({ length: 32 }, (_, i) => i)), 0x00112233, 0x44556677, 0x8899aabb, 0xccddeeff, o);
    assert.equal([...o].map(x => x.toString(16).padStart(8, '0')).join(''), '8ea2b7ca516745bfeafc49904b496089');
    const salt = crypto.getRandomValues(new Uint8Array(16)), pw = 'geheim';
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 1000, hash: 'SHA-1' }, base, 66 * 8));
    const plain = new TextEncoder().encode('elementen '.repeat(50)), enc = ctrWinZip(bits.subarray(0, 32), plain.slice());
    const blob = new Uint8Array(16 + 2 + enc.length + 10); blob.set(salt); blob.set(bits.subarray(64, 66), 16); blob.set(enc, 18);
    assert.equal(new TextDecoder().decode(await decryptWinZip(blob, pw, 3)), 'elementen '.repeat(50));
    await assert.rejects(() => decryptWinZip(blob, 'fout', 3), /wachtwoord/);
  });
  let set;
  await test('v65 bibliotheek: sets herkennen, thimble-varianten negeren, ToothBow lezen', async () => {
    const sets = await L.readLibraryFiles(fakeFiles());
    assert.equal(sets.length, 1); set = sets[0];
    assert.equal(set.name, 'Test Set'); assert.equal(Object.keys(set.teeth.upper).length, 8); assert.equal(set.bow.upper.length, 16);
    L.registerSet(set);
  });
  await test('v65 bibliotheek: kroon wordt gesloten, manifold element met wortelstomp (ook gespiegeld)', () => {
    for (const [fdi, mirror] of [[11, false], [21, true], [36, false], [46, true]]) {
      const t = L.libraryTooth(set, fdi, { rootLength: 4, mirror });
      const e = edgeMap(t.mesh); let open = 0, bad = 0; for (const v of e.values()) { if (v.count === 1) open++; else if (v.count > 2 || v.sameDir) bad++; }
      assert.equal(open, 0, `${fdi} open randen`); assert.equal(bad, 0, `${fdi} niet-manifold`);
      assert.ok(L.signedVolume(t.mesh.positions, t.mesh.indices) > 0, `${fdi} volume positief`);
      assert.ok(t.occlusalY > 3 && t.md > 5, `${fdi} maten`);
    }
  });
  await test('v65 bibliotheek: gesloten tand met wortel wordt op de halslijn afgesneden en krijgt een stomp', async () => {
    const files = [{ name: '1.eoff', webkitRelativePath: 'X/teeth/Wortel/upperjaw/1.eoff', arrayBuffer: async () => crownOFF(4, 3.5, 11, 24, 10, true).buffer }];
    const [ws] = await L.readLibraryFiles(files);
    const t = L.libraryTooth(ws, 11, { rootLength: 3 });
    const e = edgeMap(t.mesh); let open = 0; for (const v of e.values()) if (v.count !== 2 || v.sameDir) open++;
    assert.equal(open, 0, 'gesloten en manifold'); assert.ok(t.height > 8 && t.height < 12, `kroonhoogte ${t.height.toFixed(1)}`);
    let minY = Infinity; for (let i = 1; i < t.mesh.positions.length; i += 3) minY = Math.min(minY, t.mesh.positions[i]);
    assert.ok(minY > -4.5, `wortel ingekort tot de stomp (${minY.toFixed(1)})`);
  });
  await test('v65 bibliotheek: ideale standen (tip/torque/niveau) uit de ToothBow', () => {
    const id = L.bowIdeal(set, 'upper');
    assert.ok(id[11] && id[26]); assert.ok(id[11].torque > 5, `front torque ${id[11].torque}`); assert.ok(id[16].torque < -1, `molaar torque ${id[16].torque}`); assert.ok(Math.abs(id[11].level) < 5);
  });

  const { ArchRow, packRow, extents, moveAlong, rowState, morph } = await import(J + 'arrange.js');
  const frame = { O: [0, 0, 0], X: [1, 0, 0], Y: [0, 1, 0], N: [0, 0, 1] };
  const curve = t => [t * 25, 30 - 25 * t * t];
  const box = (w = 8) => { const g = new THREE.BoxGeometry(w, 8, 7); g.translate(0, 4, 0); const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial()); m.userData.dims = { height: 8 }; return m; };
  const placeAt = (row, m, s) => { const f = row.at(s), p = row.to3D(f.p[0], f.p[1], 5); m.position.set(...p); const tx = new THREE.Vector3(f.t[0], f.t[1], 0), up = new THREE.Vector3(0, 0, 1); m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(tx, up, new THREE.Vector3().crossVectors(tx, up))); m.updateMatrix(); m.updateMatrixWorld(); };
  await test('v65 rij: aansluiten op de middellijn (≤ 0,05 mm), slepen herschikt de buren', async () => {
    const row = new ArchRow(frame, curve), teeth = [-30, -18, -6, 7, 20, 33].map(s => { const m = box(); placeAt(row, m, s); return m; });
    packRow(row, teeth);
    const e = teeth.map(t => extents(row, t)).sort((a, b) => a.s - b.s);
    const { gapBetween } = await import(J + 'arrange.js');
    const ord = () => teeth.map(t => ({ t, s: rowState(row, t).s })).sort((x, y) => x.s - y.s).map(x => x.t);
    let o = ord(); for (let i = 1; i < o.length; i++) { const g = gapBetween(row, o[i - 1], o[i]); assert.ok(Math.abs(g) < 0.05, `contact ${i}: ${g.toFixed(3)} mm`); }
    assert.ok(Math.abs(e[2].s + e[3].s) < 0.1, `middellijn symmetrisch (${e[2].s.toFixed(2)} / ${e[3].s.toFixed(2)})`);
    // element 0 (meest rechts) over zijn buur heen slepen → volgorde wisselt, rij blijft gesloten
    const a = teeth[2], st = rowState(row, a); moveAlong(row, a, st.s - 12); packRow(row, teeth, { float: a }); packRow(row, teeth);
    const e2 = teeth.map(t => ({ t, ...extents(row, t) })).sort((x, y) => x.s - y.s);
    assert.equal(e2[1].t, a, 'versleept element staat nu op de tweede plek');
    o = ord(); for (let i = 1; i < o.length; i++) assert.ok(Math.abs(gapBetween(row, o[i - 1], o[i])) < 0.05, 'rij gesloten na slepen');
    // morphen maakt het element breder; aansluiten schuift de buren op
    const before = extents(row, teeth[5]).s; morph(teeth[3], 1.2, 1, 1); packRow(row, teeth);
    assert.ok(extents(row, teeth[5]).s > before + 1, 'buren schuiven op na morph');
  });

  const { articulatorPoints, mandiblePose } = await import(J + 'articulator.js');
  await test('v65 articulator: protrusie naar voren/omlaag, laterotrusie zijwaarts, starre beweging', () => {
    const fr = { O: [0, 0, 0], X: [1, 0, 0], Y: [0, 1, 0], N: [0, 0, -1] }, pts = articulatorPoints(fr, [0, 45, -10], 'upper'); // bovenkaak: N omlaag, U = +z
    const I = pts.I.clone(), mv = (k, a) => { const M = mandiblePose(pts, k, a); return { i: I.clone().applyMatrix4(M), cl: pts.CL.clone().applyMatrix4(M), cr: pts.CR.clone().applyMatrix4(M) }; };
    const p = mv('protrusion', 4); assert.ok(p.i.y - I.y > 3 && p.i.z < I.z, 'protrusie');
    assert.ok(Math.abs(p.cl.distanceTo(p.cr) - pts.CL.distanceTo(pts.CR)) < 1e-6, 'condylusafstand blijft');
    const r = mv('right', 4); assert.ok(I.x - r.i.x > 3, 'naar rechts = −X'); assert.ok(r.cl.y > pts.CL.y + 2, 'balanscondylus naar voren');
    const l = mv('left', 4); assert.ok(l.i.x - I.x > 3, 'naar links = +X');
    const o = mv('open', 10); assert.ok(o.i.z < I.z - 10, 'openen: incisaal omlaag');
  });

  const { grindStep } = await import(J + 'grind.js');
  const { contactsFor } = await import(J + 'contacts.js');
  await test('v65 inslijpen: penetratie verdwijnt tot contact, alleen het doelelement verandert', () => {
    const mk = (y) => { let g = new THREE.SphereGeometry(4, 48, 32); g.deleteAttribute('uv'); g.deleteAttribute('normal'); g = (g.index ? g : g); const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial()); m.userData.dims = { height: 1 }; m.position.set(0, y, 0); m.updateMatrixWorld(); g.computeBoundsTree(); return m; };
    const a = mk(0), b = mk(7.4); // 0,6 mm overlap
    const before = contactsFor(a, [b], { color: false, max: 2 }).min;
    assert.ok(before < -0.3, `start penetratie ${before}`);
    const bPos = b.geometry.getAttribute('position').array.slice();
    const r = grindStep([a], [b], { cervicalProtect: -10, maxTotal: 2 });
    const after = contactsFor(a, [b], { color: false, max: 2 }).min;
    assert.ok(r.verts > 10 && after > -0.03, `na slijpen ${after.toFixed(3)}`);
    assert.deepEqual(Array.from(b.geometry.getAttribute('position').array), Array.from(bPos), 'antagonist onveranderd');
  });
}

// ---------- v65.3: scanbewerking ----------
{
  const E = await import(J + 'scan-edit.js');
  const { demoJaw } = await import(J + 'demo.js');
  const { weld, boundaryLoops, edgeMap } = await import(J + 'mesh.js');
  const jaw = demoJaw({ step: 1.0 }), n0 = jaw.length / 9;
  const bounds = s => { const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9]; for (let i = 0; i < s.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], s[i + k]); hi[k] = Math.max(hi[k], s[i + k]); } return { lo, hi }; };
  const B = bounds(jaw);
  await test('v65.3 scan: vlak afsnijden snijdt exact op het vlak en houdt de juiste kant', () => {
    const z = (B.lo[2] + B.hi[2]) / 2, cut = E.planeCut(jaw, [0, 0, z], [0, 0, 1]), b = bounds(cut);
    assert.ok(cut.length < jaw.length && cut.length > 0);
    assert.ok(Math.abs(b.lo[2] - z) < 1e-4, `onderkant op het vlak (${b.lo[2].toFixed(4)} vs ${z.toFixed(4)})`);
    assert.ok(Math.abs(b.hi[2] - B.hi[2]) < 1e-6, 'bovenkant onveranderd');
    // gesneden rand is één nette lijn: geen niet-manifold randen erbij
    const m = weld(cut, 1e-5); let bad = 0; for (const v of edgeMap(m).values()) if (v.count > 2) bad++; assert.equal(bad, 0);
  });
  await test('v65.3 scan: lasso (door en door / alleen zichtbaar) en gum selecteren de juiste driehoeken', () => {
    const cx = (B.lo[0] + B.hi[0]) / 2, cy = (B.lo[1] + B.hi[1]) / 2;
    const project = (x, y, z) => [x, y, z]; // bovenaanzicht, 1 mm = 1 px
    const poly = [[cx - 5, cy - 5], [cx + 5, cy - 5], [cx + 5, cy + 5], [cx - 5, cy + 5]];
    const all = E.lassoMask(jaw, poly, project), front = E.lassoMask(jaw, poly, project, { viewDir: [0, 0, -1], frontOnly: true });
    assert.ok(E.countMask(all) > 0 && E.countMask(front) <= E.countMask(all));
    for (let f = 0; f < n0; f++) if (all[f]) { const x = (jaw[f * 9] + jaw[f * 9 + 3] + jaw[f * 9 + 6]) / 3; assert.ok(Math.abs(x - cx) <= 5.01); }
    const del = E.deleteMask(jaw, all); assert.equal(del.length / 9, n0 - E.countMask(all));
    // strakke rand: zelfde aantal driehoeken, de oorspronkelijke buitenrand onveranderd
    const clean = E.deleteMaskClean(jaw, all); assert.ok(clean.length <= del.length && clean.length > del.length * 0.98);
    const rimKey = s2 => { const m = weld(s2, 1e-5); const L = boundaryLoops(m).loops; const big = L.reduce((a, b) => b.length > a.length ? b : a); return big.map(v => [0, 1, 2].map(c => m.positions[v * 3 + c].toFixed(3)).join()).sort().join('|'); };
    assert.equal(rimKey(clean), rimKey(jaw), 'buitenrand exact behouden');
    const sm = E.sphereMask(jaw, [jaw[0], jaw[1], jaw[2]], 2); assert.ok(sm[0] === 1 && E.countMask(sm) < n0 / 4);
  });
  await test('v66 scan: rand opschonen geeft één vloeiende rand zonder oortjes, binnenpunten blijven', () => {
    // gerafelde rand maken: losse driehoekjes aan de rand + gaatje + nul-lange snijranden
    const rough = E.planeCut(jaw, [0, 0, (B.lo[2] + B.hi[2]) / 2], [0, 0, 1]);
    const mid = Math.floor(rough.length / 18) * 9, holed = E.deleteMask(rough, E.sphereMask(rough, [rough[mid], rough[mid + 1], rough[mid + 2]], 1.2));
    const r = E.cleanRim(holed);
    const m = weld(r.soup, 1e-5), e = edgeMap(m); let ears = 0, nm = 0; const fb = new Uint8Array(m.indices.length / 3);
    for (const v of e.values()) { if (v.count > 2) nm++; if (v.count === 1) fb[v.faces[0]]++; } for (const c of fb) if (c >= 2) ears++;
    assert.equal(ears, 0, 'geen oortjes'); assert.equal(nm, 0, 'manifold'); assert.ok(r.loops <= boundaryLoops(weld(rough, 1e-5)).loops.length, 'gaatje dicht');
    const so = E.smoothOutline([[0, 0, 0], [10, 0, 0], [10, 10, 0], [5, 4, 0], [0, 10, 0]], 6); assert.equal(so.length, 5);
  });
  await test('v65.3 scan: losse delen weg, gladmaken laat de rand en de rest ongemoeid, gaten dicht', () => {
    // los eilandje toevoegen
    const island = new Float32Array([100, 100, 0, 101, 100, 0, 100, 101, 0]), withIsland = new Float32Array(jaw.length + 9); withIsland.set(jaw); withIsland.set(island, jaw.length);
    const k = E.keepLargest(withIsland); assert.equal(k.removed, 1); assert.equal(k.soup.length, jaw.length);
    const mask = new Uint8Array(n0); for (let f = 0; f < n0; f += 3) mask[f] = 1;
    const sm = E.smoothMask(jaw, mask, { iterations: 2 }), b2 = bounds(sm);
    assert.equal(sm.length, jaw.length); for (let k2 = 0; k2 < 3; k2++) assert.ok(Math.abs(b2.lo[k2] - B.lo[k2]) < 1.5);
    // gat maken en dichten
    // punt ver van de scanrand: het hoekpunt dat het verst van alle randpunten ligt
    const wm = weld(jaw, 1e-5), rim = boundaryLoops(wm).loops.flat(); let far = 0, fd = -1;
    for (let v = 0; v < wm.positions.length / 3; v++) { let d = Infinity; for (const r of rim) d = Math.min(d, Math.hypot(wm.positions[v * 3] - wm.positions[r * 3], wm.positions[v * 3 + 1] - wm.positions[r * 3 + 1], wm.positions[v * 3 + 2] - wm.positions[r * 3 + 2])); if (d > fd) { fd = d; far = v; } }
    const hole = E.sphereMask(jaw, [wm.positions[far * 3], wm.positions[far * 3 + 1], wm.positions[far * 3 + 2]], 2.5);
    const holed = E.deleteMask(jaw, hole), loops = s => boundaryLoops(weld(s, 1e-5)).loops.length;
    assert.ok(loops(holed) > loops(jaw)); const c = E.closeHoles(holed); assert.ok(c.filled >= 1); assert.equal(loops(c.soup), loops(jaw));
  });
}

// ---------- v67: grote scans (snel lassen, uitsnijden met cache, vereenvoudigen met foutgrens) ----------
{
  const M = await import(J + 'mesh.js'), TR = await import(J + 'trim.js'), D = await import(J + 'decimate.js');
  const { anatomicJaw: AJ } = await import(J + 'demo.js');
  // referentie: de oude weld met tekstsleutels
  const weldRef = (soup, tol) => { const inv = 1 / tol, map = new Map(), pos = [], idx = new Uint32Array(soup.length / 3);
    for (let i = 0; i < soup.length; i += 3) { const k = Math.round(soup[i] * inv) + ',' + Math.round(soup[i + 1] * inv) + ',' + Math.round(soup[i + 2] * inv); let id = map.get(k); if (id === undefined) { id = pos.length / 3; map.set(k, id); pos.push(soup[i], soup[i + 1], soup[i + 2]); } idx[i / 3] = id; }
    return { positions: Float32Array.from(pos), indices: idx }; };
  // ruisige testkaak (onregelmatig, zoals een labscan)
  const noisy = (soup, amp = 0.004) => { const out = Float32Array.from(soup); const h = (x, y) => { const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return v - Math.floor(v) - 0.5; }; for (let i = 0; i < out.length; i += 3) out[i + 2] += h(out[i], out[i + 1]) * 2 * amp; return out; };
  await test('v67 weld: snelle versie geeft exact dezelfde punten en indices', () => {
    const r = new Float32Array(9 * 5000); for (let i = 0; i < r.length; i++) r[i] = Math.round((Math.sin(i * 7.1) * 10) * 1e3) / 1e3 + (i % 7 === 0 ? 4e-6 : 0);
    for (const soup of [r, AJ({ jaw: 'lower' }).soup, Float32Array.from([-0.5e-5, 0, 0, 0.5e-5, 0, 0, 1, 1, 1])]) for (const tol of [1e-6, 1e-5, 1e-3]) {
      const a = weldRef(soup, tol), b = M.weld(soup, tol);
      assert.deepEqual(Array.from(b.indices), Array.from(a.indices)); assert.deepEqual(Array.from(b.positions), Array.from(a.positions));
    }
  });
  await test('v67 uitsnijden: tweede keer (cache) identiek, kant-test gelijk aan het teken van de afstand', () => {
    const { soup } = AJ({ jaw: 'upper', torus: true });
    const ring = [[-30, -2, 0], [-32, 14, 0], [-24, 30, 0], [-10, 38, 0], [0, 40, 0], [10, 38, 0], [24, 30, 0], [32, 14, 0], [30, -2, 0]];
    const a = TR.trimByOutline(soup, ring, [0, 0, 1]), b = TR.trimByOutline(soup, ring, [0, 0, 1]), c = TR.trimByOutline(soup, ring, [0.1, 0, 0.99]);
    assert.deepEqual(Array.from(a.soup), Array.from(b.soup)); assert.deepEqual(Array.from(a.faces), Array.from(b.faces));
    assert.ok(c.soup.length > 0 && c.soup.length !== a.soup.length, 'andere as = andere uitsnede (cache per as)');
    const field = new TR.PolygonField(a.polygon);
    for (let i = 0; i < 4000; i++) { const x = Math.sin(i) * 40, y = 20 + Math.cos(i * 1.3) * 25, s1 = field.side(x, y), s2 = field.signed(x, y); assert.equal(s1 < 0, s2 < 0 && s2 !== 0); }
  });
  await test('v67 vereenvoudigen: elk origineel punt binnen 0,01 mm, rand exact, manifold, alleen originele punten', () => {
    const soup = noisy(AJ({ jaw: 'lower', step: 0.2 }).soup), mesh = M.weld(soup, 1e-6);
    const r = D.simplifyMesh(mesh, { tolerance: 0.01 }), q = M.quality(r.mesh), q0 = M.quality(mesh);
    assert.ok(r.report.after < r.report.before * 0.6, `te weinig vereenvoudigd: ${r.report.before} → ${r.report.after}`);
    assert.equal(q.nonManifold, 0); assert.equal(q.flipped, 0); assert.equal(q.degenerate, 0); assert.equal(q.components, q0.components); assert.equal(q.open, q0.open); assert.equal(q.holes, q0.holes);
    const d = M.pointToSurfaceDistances(mesh.positions, M.toSoup(r.mesh), { maxDist: 0.2, cell: 0.5 });
    let mx = 0; for (const x of d) mx = Math.max(mx, x);
    assert.ok(mx <= 0.01 + 1e-6, `afwijking ${mx.toFixed(4)} mm`); assert.ok(Math.abs(mx - r.report.maxDeviation) < 1e-4, 'gemeten afwijking klopt met het rapport');
    const key = (p, v) => p[v * 3] + ',' + p[v * 3 + 1] + ',' + p[v * 3 + 2], orig = new Set(); for (let v = 0; v < mesh.positions.length / 3; v++) orig.add(key(mesh.positions, v));
    for (let v = 0; v < r.mesh.positions.length / 3; v++) assert.ok(orig.has(key(r.mesh.positions, v)), 'nieuw punt verzonnen');
    const rim = m => M.boundaryLoops(m).loops.map(l => l.map(v => key(m.positions, v)).sort().join(';')).sort().join('|');
    assert.equal(rim(r.mesh), rim(mesh), 'rand veranderd');
    // streefaantal: stopt op het doel en blijft dan ruim binnen de tolerantie
    const t = D.simplifyMesh(mesh, { tolerance: 0.01, targetFaces: Math.round(r.report.before * 0.8) });
    assert.ok(Math.abs(t.report.after - r.report.before * 0.8) <= 2 && t.report.maxDeviation <= r.report.maxDeviation + 1e-9);
  });
  await test('v67 vereenvoudigen: ontworpen (aangevuld) deel blijft ongewijzigd achteraan, naad dicht', () => {
    const soup = noisy(AJ({ jaw: 'upper', step: 0.3 }).soup), n = soup.length / 9, lockFrom = Math.floor(n * 0.9);
    const r = D.simplifySoup(soup, { tolerance: 0.01, lockFrom });
    assert.equal(r.soup.length / 9 - r.lockFrom, n - lockFrom, 'aantal ontworpen facetten gelijk');
    assert.deepEqual(Array.from(r.soup.subarray(r.lockFrom * 9)), Array.from(soup.subarray(lockFrom * 9)), 'ontworpen facetten exact gelijk');
    const q = M.quality(M.weld(r.soup, 1e-6)), q0 = M.quality(M.weld(soup, 1e-6)); assert.equal(q.open, q0.open); assert.equal(q.nonManifold, 0);
  });
  await test('v67 schaal: oppervlak boven 400.000 facetten wordt vereenvoudigd en de plaat is gesloten', () => {
    // fijn hoogteveld (koepel met ruis), ~460.000 facetten
    const N = 480, out = new Float32Array((N - 1) * (N - 1) * 18); let o = 0; const z = (x, y) => 6 * Math.exp(-(x * x + y * y) / 500) + 0.003 * Math.sin(x * 91.7 + y * 37.3);
    for (let i = 0; i < N - 1; i++) for (let j = 0; j < N - 1; j++) { const x0 = -24 + i * 0.1, y0 = -24 + j * 0.1, x1 = x0 + 0.1, y1 = y0 + 0.1;
      out.set([x0, y0, z(x0, y0), x1, y0, z(x1, y0), x1, y1, z(x1, y1), x0, y0, z(x0, y0), x1, y1, z(x1, y1), x0, y1, z(x0, y1)], o); o += 18; }
    assert.ok(out.length / 9 > 400000);
    const rep = {}, plate = shell(out, { gap: 0, wall: 2 }, rep);
    assert.ok(rep.reduced && rep.reduced.after <= 400000 && rep.reduced.maxDeviation <= 0.0101, JSON.stringify(rep.reduced));
    assert.equal(quality(weld(plate, 1e-6)).watertight, true);
  });
}

// ---------- v67: omtrek tekenen, overtekenen, wegtrekken ----------
{
  const CE = await import(J + 'contour-edit.js'), { ContourSet } = await import(J + 'contour.js');
  const circle = (R = 20, n = 120, z = 0) => Array.from({ length: n }, (_, i) => { const a = i / n * 2 * Math.PI; return [R * Math.cos(a), R * Math.sin(a), z]; });
  const radius = p => Math.hypot(p[0], p[1]);
  await test('v67 omtrek: herbemonsteren houdt lengte en gelijke afstand', () => {
    const c = circle(), r = CE.resample(c, 2, { closed: true });
    assert.ok(Math.abs(CE.pathLength(r, true) - CE.pathLength(c, true)) < 0.2);
    const gaps = r.map((p, i) => Math.hypot(...p.map((v, k) => v - r[(i + 1) % r.length][k]))); assert.ok(Math.max(...gaps) - Math.min(...gaps) < 0.05);
    const open = CE.resample([[0, 0, 0], [10, 0, 0], [10, 7, 0]], 1, { closed: false }); assert.deepEqual(open[0], [0, 0, 0]); assert.deepEqual(open.at(-1), [10, 7, 0]);
  });
  await test('v67 omtrek: overtekenen vervangt alleen het stuk tussen begin en eind (beide richtingen)', () => {
    const c = circle(), st = [];
    for (let a = -20; a <= 20; a++) { const r = a * Math.PI / 180, R = Math.abs(a) > 17 ? 20.5 : 25; st.push([R * Math.cos(r), R * Math.sin(r), 0]); }
    for (const [s0, flip] of [[st, false], [st.slice().reverse(), true]]) {
      const u0 = CE.nearestOnPath(c, s0[0], { closed: true }).u, u1 = CE.nearestOnPath(c, s0.at(-1), { closed: true }).u, r = CE.spliceClosed(c, s0, u0, u1);
      assert.ok(Math.abs(r.replacedLength - 2 * Math.PI * 20 * 40 / 360) < 0.6, `vervangen ${r.replacedLength.toFixed(1)} mm (flip ${flip})`);
      const far = r.points.filter(p => radius(p) > 21), kept = r.points.filter(p => Math.abs(radius(p) - 20) < 1e-6);
      assert.ok(far.length >= 30 && far.every(p => Math.abs(Math.atan2(p[1], p[0])) < 0.36), 'nieuwe rand alleen in het overgetekende stuk');
      assert.ok(kept.length >= 120 - 15, 'rest van de omtrek onveranderd');
      assert.ok(validContour(r.points.map(p => [p[0] * 10, p[1] * 10])), 'geldige omtrek');
    }
  });
  await test('v67 omtrek: uitstulping (begin en eind op dezelfde plek) wordt ingevoegd, niet de hele lijn vervangen', () => {
    const c = circle(), st = [];
    for (let k = 0; k <= 30; k++) { const a = (k / 30) * Math.PI; st.push([20 + 6 * Math.sin(a), 3 * Math.cos(a) - 0.0, 0]); } // lus naar buiten bij hoek 0
    const u0 = CE.nearestOnPath(c, st[0], { closed: true }).u, u1 = CE.nearestOnPath(c, st.at(-1), { closed: true }).u, r = CE.spliceClosed(c, st, u0, u1);
    assert.ok(r.replacedLength < 8, `vervangen ${r.replacedLength.toFixed(1)} mm`); assert.ok(r.points.length > 120);
  });
  await test('v67 omtrek: wegtrekken verplaatst de greep exact, buren zacht, rest blijft', () => {
    const c = circle(), d = CE.dragPoints(c, 30, [0, 3, 0], 6, { closed: true });
    assert.deepEqual(d.points[30], [c[30][0], c[30][1] + 3, 0]);
    let moved = 0; d.points.forEach((p, i) => { if (p[1] !== c[i][1]) moved++; }); assert.ok(moved > 3 && moved < 15, `${moved} punten`);
    assert.ok(Math.abs(d.weights[29] - d.weights[31]) < 1e-6 && d.weights[29] < 1 && d.weights[29] > 0.5, 'symmetrisch en zacht');
    const z = CE.dragPoints(c, 30, [0, 3, 0], 0, { closed: true }); let m0 = 0; z.points.forEach((p, i) => { if (p[1] !== c[i][1]) m0++; }); assert.equal(m0, 1, 'zone 0 = alleen het punt');
    const w = CE.arcWeights(c, 30.5, 6, { closed: true }); assert.ok(w[30] > 0.9 && w[31] > 0.9 && w[24] < 0.2);
  });
  await test('v67 omtrek: verder tekenen, streek opschonen, rondgang herkennen', () => {
    const open = [[0, 0, 0], [5, 0, 0], [10, 0, 0]];
    assert.deepEqual(CE.extendOpen(open, [[10.1, 0, 0], [15, 0, 0]]).at(-1), [15, 0, 0]);
    assert.deepEqual(CE.extendOpen(open, [[-0.1, 0, 0], [-5, 0, 0]]).at(-1), [-5, 0, 0], 'vanaf het begin verder: lijn omgedraaid');
    const raw = []; for (let i = 0; i <= 400; i++) raw.push([i * 0.05, Math.sin(i * 0.05) * 3 + (i % 2 ? 0.05 : -0.05), 0]);
    const cl = CE.cleanStroke(raw, { spacing: 1.25 }), gaps = cl.slice(1).map((p, i) => Math.hypot(p[0] - cl[i][0], p[1] - cl[i][1]));
    assert.ok(gaps.every(g => g > 1 && g < 1.5), 'gelijkmatig'); assert.ok(Math.abs(Math.hypot(cl[0][0] - raw[0][0], cl[0][1] - raw[0][1])) < 0.1, 'begin blijft');
    assert.equal(CE.isLoop(circle(10, 40).concat([[10, 0.5, 0]])), true); assert.equal(CE.isLoop(raw.slice(0, 100)), false);
  });
  await test('v67 omtrek: punten die in de insteekrichting samenvallen geven geen onterechte kruisingsmelding', () => {
    const cs = new ContourSet(), pts = circle(20, 60);
    pts.splice(10, 0, [pts[10][0] + 0.02, pts[10][1], 3], [pts[10][0] + 0.03, pts[10][1], 6]); // steile wand: zelfde plek, andere hoogte
    const s = cs.setPoints('beetplaat', pts, [0, 0, 1]);
    assert.equal(s.closed, true); assert.ok(s.points.length <= 61);
  });
}

// ---------- v68: vastlopen (snelheid) en plaatrand = scanrand ----------
{
  const M = await import(J + 'mesh.js'), B = await import(J + 'bvh.js'), T = await import(J + 'trim.js'), SH = await import(J + 'shell.js');
  const { WaxLayer } = await import(J + 'wax.js'), { ContourSet, editableOutline } = await import(J + 'contour.js'), C = await import(J + 'csg.js');
  const lower = anatomicJaw({ jaw: 'lower' }).soup;
  // referentie (v67-vorm): randstatistiek met een Map
  const refEdges = mesh => { const f = mesh.indices, map = new Map(); for (let i = 0; i < f.length; i += 3) for (let k = 0; k < 3; k++) { const a = f[i + k], b = f[i + (k + 1) % 3], key = a < b ? a * 4294967296 + b : b * 4294967296 + a, e = map.get(key); if (e) { e.count++; e.faces.push(i / 3); if (e.from === a) e.sameDir = true; } else map.set(key, { from: a, to: b, count: 1, faces: [i / 3], sameDir: false }); } return [...map.values()]; };
  const withDefects = () => { const a = Array.from(lower.subarray(0, 9 * 6000)), n = a.length / 9; for (let i = 0; i < 60; i++) { const f = (i * 97) % n; a.push(...a.slice(f * 9, f * 9 + 9)); } for (let i = 0; i < 40; i++) { const o = ((i * 71 + 3) % n) * 9; a.push(a[o], a[o + 1], a[o + 2], a[o + 3], a[o + 4], a[o + 5], a[o] + 0.3, a[o + 1] + 0.2, a[o + 2] + 1); } for (let i = 0; i < 40; i++) { const o = ((i * 131 + 7) % n) * 9; for (let k = 0; k < 3; k++) { const t = a[o + 3 + k]; a[o + 3 + k] = a[o + 6 + k]; a[o + 6 + k] = t; } } return Float32Array.from(a); };

  await test('v68 randentabel: zelfde randen, volgorde en facetten als de Map-versie (ook met fouten)', () => {
    for (const soup of [lower, withDefects()]) {
      const m = M.weld(soup, 1e-5), ref = refEdges(m), got = [...M.edgeMap(m).values()];
      assert.equal(got.length, ref.length);
      for (let i = 0; i < ref.length; i++) assert.deepEqual(got[i], ref[i]);
      const q = M.quality(m); assert.equal(q.open, ref.filter(e => e.count === 1).length); assert.equal(q.nonManifold, ref.filter(e => e.count > 2).length);
    }
  });
  await test('v68 dubbele/platte facetten weg en oriënteren: zelfde aantallen, consistente richting', () => {
    const m = M.weld(withDefects(), 1e-5), c = M.clean(m);
    assert.ok(c.duplicate >= 60, `${c.duplicate} dubbel`);
    const o = M.orient(c.mesh), q = M.quality(o.mesh); assert.ok(o.flips > 0); assert.equal(q.flipped, 0, 'na oriënteren geen omgekeerde buren');
    const t = M.tidySheet(o.mesh), q2 = M.quality(t.mesh); assert.equal(q2.nonManifold, 0); assert.equal(q2.components, 1);
  });
  await test('v68 BVH: dichtstbijzijnd punt exact gelijk aan alle driehoeken aflopen', () => {
    const soup = lower.subarray(0, 9 * 4000), bvh = new B.TriBVH(soup);
    let s = 3; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 300; i++) {
      const f = Math.floor(rnd() * 4000) * 9, p = [soup[f] + (rnd() - 0.5) * 6, soup[f + 1] + (rnd() - 0.5) * 6, soup[f + 2] + (rnd() - 0.5) * 6];
      let best = Infinity; for (let g = 0; g < soup.length; g += 9) best = Math.min(best, B.pointTriangle2(p[0], p[1], p[2], soup, g));
      const d = bvh.closest(p[0], p[1], p[2]); assert.ok(Math.abs(d - Math.sqrt(best)) < 1e-9, `${d} vs ${Math.sqrt(best)}`);
      const lim = bvh.closest(p[0], p[1], p[2], 0.5); assert.equal(lim === Infinity, Math.sqrt(best) > 0.5);
    }
    const pts = Float32Array.from([0, 30, 5, 10, 25, 3]), d1 = M.pointToSurfaceDistances(pts, soup, { maxDist: 8 }), d2 = M.pointToSurfaceDistances(pts, soup, { maxDist: 8, bound: Float32Array.from([1, 1]) });
    assert.deepEqual(Array.from(d1), Array.from(d2), 'een te krappe bovengrens geeft toch de juiste afstand');
  });
  await test('v68 schaal met afdrukruimte: snel, en shellAsync geeft exact hetzelfde', async () => {
    const t0 = performance.now(), a = SH.shell(lower, { gap: 2, wall: 2 }), ms = performance.now() - t0;
    let pauses = 0; const b = await SH.shellAsync(lower, { gap: 2, wall: 2 }, {}, async () => { pauses++; });
    assert.equal(a.length, b.length); for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw Error('verschil op ' + i);
    assert.ok(ms < 4000, `${ms.toFixed(0)} ms`);
  });
  await test('v68 rand sluit aan: met 2 mm afstand ligt de plaatrand precies op de scanrand', () => {
    const rep = {}, plate = SH.shell(lower, { gap: 2, wall: 2, rimSeal: 2 }, rep);
    // rand zoals de plaat hem gebruikt (na opschonen: losse 'oortjes' aan de trapjesrand van de demokaak vallen weg)
    const m = M.tidySheet(M.orient(M.clean(M.weld(lower, 1e-5)).mesh).mesh).mesh;
    const rim = M.boundaryLoops(m).loops.sort((x, y) => y.length - x.length)[0], bvh = new B.TriBVH(plate);
    let worst = 0; for (const v of rim) worst = Math.max(worst, bvh.closest(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]));
    assert.ok(worst < 0.01, `scanrand tot plaat ${worst.toFixed(3)} mm`);
    const plain = new B.TriBVH(SH.shell(lower, { gap: 2, wall: 2 })); let far = 0; for (const v of rim) far = Math.max(far, plain.closest(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]));
    assert.ok(far > 1.5, 'zonder afsluitzone zweeft de rand ~2 mm boven de scan');
    const f = M.fitReport(lower, plate, 2, { rimSeal: 2 }); assert.ok(f.within > 0.6, `binnen 0,05: ${f.within}`);
  });
  await test('v68 rand langs de scanrand: hele scan (exact) of tot een vaste afstand binnen de rand', () => {
    const e0 = T.trimByEdge(lower); assert.equal(e0.soup, lower); assert.equal(e0.faces.length, lower.length / 9); assert.ok(e0.outline.length > 100);
    const m = M.weld(lower, 1e-5), rim = M.boundaryLoops(m).loops.sort((x, y) => y.length - x.length)[0];
    const P = v => [m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]];
    const near = (p, list) => { let best = Infinity; for (let i = 0; i < list.length; i++) { const a = P(list[i]), b = P(list[(i + 1) % list.length]), d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / (d[0] ** 2 + d[1] ** 2 + d[2] ** 2 || 1))); best = Math.min(best, Math.hypot(p[0] - a[0] - t * d[0], p[1] - a[1] - t * d[1], p[2] - a[2] - t * d[2])); } return best; };
    assert.ok(e0.outline.every(p => near(p, rim) < 1e-4), 'lijn exact op de scanrand');
    // zoals de plaat het gebruikt (shell schoont eerst op: losse snippers en zadelpunten op de snijlijn weg)
    const e2 = T.trimByEdge(lower, { inset: 2 }), m2 = M.tidySheet(M.weld(e2.soup, 1e-5)).mesh, loops = M.boundaryLoops(m2);
    assert.equal(loops.loops.length, 1); assert.equal(loops.branching, false);
    const sample = loops.loops[0].filter((_, i) => i % 7 === 0).map(v => [m2.positions[v * 3], m2.positions[v * 3 + 1], m2.positions[v * 3 + 2]]);
    // afstand langs het oppervlak ≈ 2 mm (rechte lijn is iets korter op een gebogen oppervlak); trapjesrand geeft uitschieters
    const ds = sample.map(p => near(p, rim)).sort((a, b) => a - b), q = f => ds[Math.floor(ds.length * f)];
    assert.ok(q(0.05) > 1.75 && q(0.5) > 1.9 && q(0.5) < 2.05 && q(0.95) < 2.3 && ds[0] > 1.3 && ds.at(-1) < 2.6, `rand p5 ${q(0.05).toFixed(2)}, mediaan ${q(0.5).toFixed(2)}, p95 ${q(0.95).toFixed(2)} mm binnen de scanrand`);
    assert.ok(e2.report.kept > e2.report.clipped * 10, 'binnenste facetten ongewijzigd');
    // aangevuld (ontworpen) deel telt niet mee: de rand is de echte scanrand
    const ext = Float32Array.from([...lower, ...lower.subarray(0, 9 * 50).map((v, i) => i % 3 === 2 ? v - 30 : v)]);
    const e3 = T.trimByEdge(ext, { splitAt: lower.length / 9 }); assert.equal(e3.soup.length, lower.length); assert.equal(e3.splitIndex, null);
  });
  await test('v68 omtrek langs de scanrand: uitsnede volgt de scan, slepen maakt er een gewone omtrek van, terugzetten herstelt', () => {
    const cs = new ContourSet(), out = editableOutline(T.trimByEdge(lower).outline, [0, 0, 1]);
    cs.setEdge('beetplaat', out, [0, 0, 1], 0);
    assert.equal(cs.surface('beetplaat', lower).length, lower.length);
    cs.snap('beetplaat'); cs.get('beetplaat').points = cs.get('beetplaat').points.map(p => [p[0] * 0.9, p[1] * 0.9 + 3, p[2]]); cs.setPoints('beetplaat', cs.get('beetplaat').points, [0, 0, 1], { record: false });
    assert.equal(cs.get('beetplaat').edge, null); assert.ok(cs.surface('beetplaat', lower).length < lower.length);
    cs.undo('beetplaat'); assert.deepEqual(cs.get('beetplaat').edge, { inset: 0 }); assert.equal(cs.surface('beetplaat', lower).length, lower.length);
    assert.deepEqual(cs.toJSON()[0].edge, { inset: 0 });
  });
  await test('v68 was blijft bij scan voorbereiden: lift per punt overgenomen, nieuwe punten zonder was', () => {
    const w = new WaxLayer(lower, [0, 0, 1]); w.brush('add', [0, 30, 0], { radius: 6, strength: 1 });
    const before = w.stats(); assert.ok(before.points > 50);
    const cut = lower.slice(0, lower.length - 9 * 2000), w2 = w.transferTo(cut), after = w2.stats();
    assert.ok(after.points > 0 && after.points <= before.points); assert.ok(Math.abs(after.max - before.max) < 1e-6);
    const extra = Float32Array.from([...lower, 0, 0, -20, 1, 0, -20, 0, 1, -20]); assert.equal(w.transferTo(extra).stats().points, before.points);
  });
  await test('v68 splinters na een booleaanse bewerking weg (zonder decompose)', async () => {
    const box = (c, h) => { const out = []; const P = [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => [c[0] + x * h, c[1] + y * h, c[2] + z * h]))); for (const [a, b, cc, d] of [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]) out.push(...P[a], ...P[b], ...P[cc], ...P[a], ...P[cc], ...P[d]); return Float32Array.from(out); };
    const r = await C.unionSoups([box([0, 0, 0], 5), box([20, 0, 0], 0.4)]), q = M.quality(M.weld(r.soup, 1e-5));
    assert.equal(q.components, 1, 'mini-blokje (0,5 mm³) weggelaten'); assert.ok(Math.abs(Math.abs(q.volume) - 1000) < 1e-3);
    const r2 = await C.unionSoups([box([0, 0, 0], 5), box([20, 0, 0], 3)]); assert.equal(M.quality(M.weld(r2.soup, 1e-5)).components, 2, 'groot los deel blijft');
  });
}

// ---- v69: buitenkant als iso-oppervlak (geen scherven meer op betande scans) ----
{
  const M = await import(J + 'mesh.js'), SH = await import(J + 'shell.js'), X = await import(J + 'meshcheck.js'), B = await import(J + 'bvh.js');
  const { dentateJaw } = await import(J + 'demo-dentate.js');
  const dent = (await dentateJaw({ missing: [36, 37], noise: 0.02, columns: 40, rows: 24 })).soup;
  const own = X.selfIntersections(M.weld(dent, 1e-6)).pairs; // de (ruisende) scan zelf
  await test('v69 zelfdoorsnijding: kruisende driehoeken gevonden, gesloten blok schoon', () => {
    const tri = (a, b, c) => [...a, ...b, ...c];
    const two = Float32Array.from([...tri([0, 0, 0], [2, 0, 0], [0, 2, 0]), ...tri([0.5, 0.5, -1], [0.5, 0.5, 1], [3, 3, 0])]);
    assert.equal(X.selfIntersections(M.weld(two, 1e-6)).pairs, 1);
    const box = []; const P = [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => [x, y, z])));
    for (const [a, b, c, d] of [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]) box.push(...P[a], ...P[b], ...P[c], ...P[a], ...P[c], ...P[d]);
    assert.equal(X.selfIntersections(M.weld(Float32Array.from(box), 1e-6)).pairs, 0);
  });
  await test('v69 betande scan, beetplaat 0 mm: gesloten, geen scherven (zelfdoorsnijding), wand overal 2 mm, pasvlak = scan', () => {
    const rep = { debug: true }, plate = SH.shell(dent, { gap: 0, wall: 2, checkThin: true }, rep), m = M.weld(plate, 1e-6), q = M.quality(m);
    assert.ok(q.watertight && q.nonManifold === 0, JSON.stringify(q));
    const si = X.selfIntersections(m).pairs; assert.ok(si <= own + 5, `zelfdoorsnijding ${si} (scan zelf ${own})`);
    const d = M.pointToSurfaceDistances(rep.outerSoup, dent, { maxDist: 6 }); let min = Infinity, max = 0; for (const x of d) { min = Math.min(min, x); if (x !== Infinity) max = Math.max(max, x); }
    assert.ok(min > 1.98 && max < 3.3, `wand ${min.toFixed(3)} … ${max.toFixed(3)} mm`);
    assert.equal(rep.thin, 0);
    // pasvlak = scan; alleen de kartelige scanrand is in het raakvlak gladgestreken (hooguit 0,3 mm)
    const f = M.fitReport(dent, plate, 0); assert.ok(f.p99 < 0.02 && f.within > 0.99 && f.max < 0.45, `pasvlak ${JSON.stringify(f)}`);
    // de oude methode gaf hier duizenden zelfdoorsnijdingen (de 'scherven' uit de praktijk)
    const old = X.selfIntersections(M.weld(SH.shell(dent, { gap: 0, wall: 2, method: 'normal' }), 1e-6)).pairs; assert.ok(old > si * 3 + 100, `oud ${old} / nieuw ${si}`);
  });
  await test('v69 betande scan, 2 mm afdrukruimte (met en zonder afsluitzone): gesloten, schoon, nergens te dicht', () => {
    for (const seal of [0, 2]) {
      const plate = SH.shell(dent, { gap: 2, wall: 2, rimSeal: seal }, {}), m = M.weld(plate, 1e-6), q = M.quality(m);
      assert.ok(q.watertight && q.nonManifold === 0, `afsluitzone ${seal}: ${JSON.stringify(q)}`);
      assert.equal(X.selfIntersections(m).pairs, 0, `zelfdoorsnijding (afsluitzone ${seal})`);
      // (met afsluitzone loopt de plaat in de overgang bewust schuin naar de scanrand: daar mag hij iets dichter komen)
      const f = M.fitReport(dent, plate, 2, { rimSeal: seal }); assert.ok(f.closeP99 < 0.06 && f.closeMax < (seal ? 0.6 : 0.25), `afsluitzone ${seal}: ${JSON.stringify(f)}`);
    }
  });
  await test('v69 plaatrand: afgerond, onderste ring op de scanrand, rand loopt mee met de scan', () => {
    const plate = SH.shell(dent, { gap: 0, wall: 2 }, {}), bvh = new B.TriBVH(plate);
    const m = M.tidySheet(M.orient(M.clean(M.weld(dent, 1e-5)).mesh).mesh).mesh, rim = M.boundaryLoops(m).loops.sort((x, y) => y.length - x.length)[0];
    let worst = 0; for (const v of rim) worst = Math.max(worst, bvh.closest(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]));
    assert.ok(worst < 0.4, `scanrand tot plaat ${worst.toFixed(3)} mm (kartels gladgestreken)`);
  });
}

// ---- v70: lepel langs de scanrand, nauwkeuriger afdrukruimte, dun weefselblok, binnen een omtrek knippen ----
{
  const M = await import(J + 'mesh.js'), SH = await import(J + 'shell.js'), X = await import(J + 'meshcheck.js');
  const TR = await import(J + 'trim.js'), CS = await import(J + 'csg.js');
  const { dentateJaw } = await import(J + 'demo-dentate.js');
  const dent = (await dentateJaw({ missing: [36, 37], noise: 0.02, columns: 40, rows: 24 })).soup;
  const own = X.selfIntersections(M.weld(dent, 1e-6)).pairs;
  await test('v70 lepel op een betande scan langs de scanrand: gesloten, schoon, afdrukruimte op 0,03 mm', () => {
    const surf = TR.trimByEdge(dent, { inset: 0 }).soup, t0 = performance.now();
    const rep = {}, plate = SH.shell(surf, { gap: 2, wall: 2.5, checkThin: true, trimSpikes: true }, rep), ms = performance.now() - t0;
    const m = M.weld(plate, 1e-6), q = M.quality(m);
    assert.ok(q.watertight && q.nonManifold === 0 && q.components === 1, JSON.stringify(q));
    const si = X.selfIntersections(m).pairs; assert.ok(si <= 150, `zelfdoorsnijding ${si} (scan zelf ${own})`);
    const f = M.fitReport(surf, plate, 2); assert.ok(f.closeP99 < 0.03, `te dicht (99%) ${f.closeP99.toFixed(3)} mm`);
    assert.ok(ms < 20000, `${ms.toFixed(0)} ms`);
  });
  await test('v70 afdrukruimte op een fijner raster: veel minder te dicht dan met het grove raster (tandeloze kaak)', () => {
    const jaw = anatomicJaw({ jaw: 'lower' }).soup;
    const plate = SH.shell(jaw, { gap: 2, wall: 2.5 }, {}), f = M.fitReport(jaw, plate, 2);
    const old = M.fitReport(jaw, SH.shell(jaw, { gap: 2, wall: 2.5, hInner: 0.9 }, {}), 2);
    assert.ok(f.closeP99 < 0.07 && f.closeP99 < 0.7 * old.closeP99, `te dicht (99%): oud ${old.closeP99.toFixed(3)} / nieuw ${f.closeP99.toFixed(3)} mm`);
  });
  await test('v70 dun weefselblok (iso, 2,5 mm) aan de weefselkant: gesloten, veel schoner dan het oude; 8 mm loopt niet meer weg', () => {
    for (const jaw of ['lower', 'upper']) {
      const surf = anatomicJaw({ jaw }).soup;
      const b = SH.shell(surf, { gap: 0.005, wall: 2.5, reverse: true, method: 'iso', quick: true }, {}), m = M.weld(b, 1e-6), q = M.quality(m);
      assert.ok(q.watertight && q.nonManifold === 0 && q.components === 1, `${jaw}: ${JSON.stringify(q)}`);
      const si = X.selfIntersections(m).pairs, old = X.selfIntersections(M.weld(SH.shell(surf, { gap: 0.005, wall: 8, reverse: true, method: 'normal' }), 1e-6)).pairs;
      assert.ok(si <= Math.max(10, old / 20), `${jaw}: zelfdoorsnijding oud blok ${old} / nieuw ${si}`);
    }
    const t0 = performance.now(); SH.shell(anatomicJaw({ jaw: 'upper' }).soup, { gap: 0.005, wall: 8, reverse: true, method: 'iso' }, {});
    assert.ok(performance.now() - t0 < 8000, `8 mm iso ${(performance.now() - t0).toFixed(0)} ms (liep rond de rand weg)`);
  });
  await test('v70 clipToOutline: alleen binnen de omtrek (0,4 mm erbinnen), een inham blijft vrij', async () => {
    const box = []; const P = [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => [x * 20, y * 20, z * 5])));
    for (const [a, b, c, d] of [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]) box.push(...P[a], ...P[b], ...P[c], ...P[a], ...P[c], ...P[d]);
    // U-vormige omtrek (10 × 10 mm met een inham van 4 mm breed, 6 mm diep) in het vlak z = 0, dicht bemonsterd zoals een echte omtrek
    const C0 = [[-5, -5], [5, -5], [5, 5], [2, 5], [2, -1], [-2, -1], [-2, 5], [-5, 5]], U = [];
    for (let i = 0; i < C0.length; i++) { const a = C0[i], b = C0[(i + 1) % C0.length], k = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.25); for (let j = 0; j < k; j++) U.push([a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k, 0]); }
    const out = await CS.clipToOutline(Float32Array.from(box), U, [0, 0, 1], { inset: 0.4, step: 0.2 }), q = M.quality(M.weld(out, 1e-6));
    assert.ok(q.watertight && q.components === 1, JSON.stringify(q));
    const inPoly = (x, y) => { let c = false; for (let i = 0, j = C0.length - 1; i < C0.length; j = i++) { const [xi, yi] = C0[i], [xj, yj] = C0[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
    const edgeDist = (x, y) => { let d = Infinity; for (let i = 0; i < C0.length; i++) { const [ax, ay] = C0[i], [bx, by] = C0[(i + 1) % C0.length], ex = bx - ax, ey = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey))); d = Math.min(d, Math.hypot(x - ax - ex * t, y - ay - ey * t)); } return d; };
    let worst = Infinity; for (let i = 0; i < out.length; i += 3) worst = Math.min(worst, inPoly(out[i], out[i + 1]) ? edgeDist(out[i], out[i + 1]) : -edgeDist(out[i], out[i + 1]));
    assert.ok(worst > 0.3, `dichtst bij of buiten de omtrek: ${worst.toFixed(3)} mm (moet ± 0,4 mm erbinnen)`);
    const vol = Math.abs(q.volume), expect = (9.2 * 9.2 - 4.8 * 6.4) * 10; assert.ok(Math.abs(vol - expect) / expect < 0.05, `volume ${vol.toFixed(1)} (verwacht ± ${expect.toFixed(1)})`);
  });
}
console.log(`\n${pass}/${pass + fail} geslaagd`); process.exit(fail ? 1 : 0);

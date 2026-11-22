// Headless tests (Node 20+):  node tests/run.mjs
// Dekken de rekenmodules die in v61 zijn toegevoegd of op echte scans zijn aangepast.
import assert from 'node:assert/strict';
const J = '../js/';
const { parseName, parse3ox, parseInf, universalToFDI, jawOfTooth, analyseOrders, simulatePrint, classifyGeometry, levenshtein, orderStem } = await import(J + 'orders.js');
const { listZip, readZipEntry } = await import(J + 'unzip.js');
const { makeZip } = await import(J + 'zip.js');
const { weld, quality, tidySheet, boundaryLoops } = await import(J + 'mesh.js');
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
await test('wand nergens dunner dan ingesteld (hoekcompensatie)', () => {
  const rep = {}; shell(jaw, { gap: 0, wall: 2 }, rep); assert.ok(rep.maxScale >= 1 && rep.maxScale <= 1.3 + 1e-6);
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
  function crownOFF(rx = 4, ry = 3.5, rz = 5, seg = 24, rings = 10) {
    const V = [], F = [];
    for (let r = 0; r <= rings; r++) { const t = r / rings * Math.PI / 2; for (let k = 0; k < seg; k++) { const a = k / seg * 2 * Math.PI; V.push([rx * Math.cos(t) * Math.cos(a), ry * Math.cos(t) * Math.sin(a), rz * Math.sin(t) - 1]); } }
    const top = V.length; V.push([0, 0, rz - 1]);
    for (let r = 0; r < rings; r++) for (let k = 0; k < seg; k++) { const a = r * seg + k, b = r * seg + (k + 1) % seg, c = a + seg, d = b + seg; F.push([a, b, d], [a, d, c]); }
    for (let k = 0; k < seg; k++) F.push([rings * seg + k, rings * seg + (k + 1) % seg, top]);
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
console.log(`\n${pass}/${pass + fail} geslaagd`); process.exit(fail ? 1 : 0);

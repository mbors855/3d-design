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
console.log(`\n${pass}/${pass + fail} geslaagd`); process.exit(fail ? 1 : 0);

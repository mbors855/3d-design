// Orderoverzicht: 3Shape-exports (3ox / inf / stl / pts) inlezen, groeperen per patiënt en controleren.
// Pure functies zonder DOM, zodat ze ook headless (Node) getest kunnen worden.
import { parseSTL } from './stl.js';
import { weld, quality } from './mesh.js';

export const PRODUCTS = {
  lepel: 'Individuele lepel', beetplaat: 'Beetplaat', beetwal: 'Beetplaat met wal', copydenture: 'Copydenture',
  provisorium: 'Tijdelijke kronen', onbekend: 'Onbekend',
};
const PRODUCT_WORDS = { lepel: 'lepel', beetplaat: 'beetplaat', copydenture: 'copydenture', po: 'provisorium', beetwal: 'beetwal' };
const JAW_WORDS = { ok: 'ok', bk: 'bk', vb: 'bk', vo: 'ok', vp: 'ok+bk' };
const NOISE = new Set(['acta']);

// ---------- bestandsnamen ----------
export function stem(name) { return name.replace(/^.*[\\/]/, '').replace(/\.(stl|3ox|inf|pts)$/i, ''); }
export function orderStem(name) { return stem(name).replace(/(_\d{1,2}){1,2}$/, ''); }
export function partIndex(name) { const m = stem(name).match(/_(\d{1,2})(?:_(\d{1,2}))?$/); return m ? { element: +m[1], piece: m[2] === undefined ? null : +m[2] } : null; }

export function parseName(name) {
  const base = orderStem(name);
  const tokens = base.toLowerCase().split(/[\s_]+/).filter(Boolean);
  const out = { base, orderNo: null, product: null, jaw: null, patientTokens: [], shade: null, date: null, keywords: [] };
  const dateTokens = [];
  for (let i = 0; i < tokens.length; i++) {
    let t = tokens[i];
    if (/^\d{4}$/.test(t) && !(i >= 2 && /^\d{1,2}$/.test(tokens[i - 1]) && /^\d{1,2}$/.test(tokens[i - 2]))) { out.orderNo ??= t; continue; }
    if (/^\d{1,2}$/.test(t) && /^\d{1,2}$/.test(tokens[i + 1] || '') && /^\d{4}$/.test(tokens[i + 2] || '')) { dateTokens.push(t, tokens[i + 1], tokens[i + 2]); i += 2; continue; }
    if (/^[abcd]\d(\.\d)?$/.test(t)) { out.shade = t.toUpperCase(); continue; }
    if (PRODUCT_WORDS[t]) { out.product ??= PRODUCT_WORDS[t]; continue; }
    if (JAW_WORDS[t]) { out.jaw ??= JAW_WORDS[t]; continue; }
    if (NOISE.has(t)) { out.keywords.push(t); continue; }
    // vastgeplakt: "jansenbk", "devriesok"
    const glued = t.match(/^([a-z]{3,})(ok|bk)$/);
    if (glued && !out.jaw) { out.jaw = glued[2]; t = glued[1]; out.keywords.push('kaak-vastgeplakt'); }
    if (/^[a-z][a-z'-]*$/.test(t)) out.patientTokens.push(t);
  }
  if (dateTokens.length) out.date = `${dateTokens[2]}-${dateTokens[1].padStart(2, '0')}-${dateTokens[0].padStart(2, '0')}`;
  out.patient = out.patientTokens.join(' ');
  return out;
}

// ---------- 3Shape-bestanden ----------
export function decodeText(buffer) {
  const b = new Uint8Array(buffer);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  if (b.length > 1 && b[1] === 0 && b[0] !== 0) return new TextDecoder('utf-16le').decode(b);
  return new TextDecoder('utf-8').decode(b);
}
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`)); return m ? m[1].trim() : null; };
const unxml = s => s?.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/^"|"$/g, '') ?? null;

export function parse3ox(text) {
  const info = text.match(/<OrderInfo>([\s\S]*?)<\/OrderInfo>/)?.[1] ?? '';
  const elements = [...text.matchAll(/<ModelElement displayName="([^"]*)">([\s\S]*?)<\/ModelElement>/g)].map(([, display, body]) => ({
    display: unxml(display),
    typeClass: body.match(/typeClass="([^"]*)"/)?.[1] ?? null,
    teeth: [...body.matchAll(/uNN="(\d+)"/g)].map(m => universalToFDI(+m[1])).filter(Boolean),
    material: unxml(body.match(/<Material displayName="([^"]*)"/)?.[1]),
    color: tag(body, 'Color') || null,
    cam: [...body.matchAll(/<CAMFile path="([^"]*)"/g)].map(m => m[1].replace(/^.*\\/, '')),
    scans: [...body.matchAll(/<ScanFile[^>]*fileType="([^"]*)"/g)].map(m => m[1]),
    height: +tag(body, 'ModelHeight') || null,
    status: tag(body, 'ProcessStatusID'),
  }));
  return {
    orderNo: unxml(tag(info, 'ThreeShapeOrderNo')), orderId: tag(text, 'OrderID'),
    lab: unxml(tag(info, 'LabName')), operator: tag(info, 'OperatorID'), caseType: unxml(tag(info, 'CaseTypeID')),
    material: unxml(tag(info, 'Material')), scanSource: tag(info, 'ScanSource'),
    delivery: tag(info, 'DeliveryDate')?.slice(0, 10) ?? null, app: tag(info, 'CreatedFromApp'),
    version: text.match(/key="CreatedIn" value="([^"]*)"/)?.[1] ?? null, elements,
  };
}

export function parseInf(text) {
  const get = k => text.match(new RegExp('^' + k.replace(/[.\/()]/g, '\\$&') + ':\\s*(.*)$', 'mi'))?.[1].trim() || null;
  const tooth = get('Tooth No. / Type of restoration');
  return { orderNo: get('ThreeShapeOrderNo'), restorations: +get('Number of restorations') || null, material: get('Material'), color: get('Color'),
    tooth: tooth ? +tooth.split('/')[0] : null, restorationType: tooth?.split('/')[1] ?? null, delivery: get('Delivery date'), comment: get('Comment') };
}

// Universele nummering (1–32) → FDI
export function universalToFDI(u) {
  if (!(u >= 1 && u <= 32)) return null;
  if (u <= 8) return 19 - u; if (u <= 16) return 12 + u; if (u <= 24) return 55 - u; return 16 + u;
}
export const jawOfTooth = t => !t ? null : (Math.floor(t / 10) === 1 || Math.floor(t / 10) === 2) ? 'bk' : (Math.floor(t / 10) === 3 || Math.floor(t / 10) === 4) ? 'ok' : null;
export function teethFromText(s) { return (s?.match(/\b[1-4][1-8]\b/g) ?? []).map(Number); }

export function parsePts(text) {
  const curves = []; let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^BEGIN/.test(line)) { cur = []; curves.push(cur); continue; }
    const v = line.trim().split(/\s+/).map(Number);
    if (cur && v.length === 3 && v.every(Number.isFinite)) cur.push(v);
  }
  return { curves: curves.length, points: curves.reduce((s, c) => s + c.length, 0) };
}

// ---------- geometrie ----------
// Kengetallen van een STL. Werkt op de soup; houdt geen grote buffers vast.
export function stlMetrics(buffer) {
  const soup = parseSTL(buffer);
  const q = quality(weld(soup, 1e-5));
  // grootste vlakke zone die (ongeveer) naar boven wijst: occlusievlak van een beetwal, ook als het schuin ligt
  const buckets = new Map(), faces = [];
  let zMax = -Infinity, zMin = Infinity;
  for (let i = 0; i < soup.length; i += 9) {
    const ux = soup[i + 3] - soup[i], uy = soup[i + 4] - soup[i + 1], uz = soup[i + 5] - soup[i + 2];
    const vx = soup[i + 6] - soup[i], vy = soup[i + 7] - soup[i + 1], vz = soup[i + 8] - soup[i + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz);
    if (l > 0 && nz / l > 0.7) {
      const a = l / 2, key = Math.round(nx / l * 20) + ',' + Math.round(ny / l * 20);
      buckets.set(key, (buckets.get(key) || 0) + a); faces.push(nx / l, ny / l, nz / l, a);
    }
  }
  let bestKey = null, best = 0; for (const [k, a] of buckets) if (a > best) { best = a; bestKey = k; }
  let flatUp = 0, tilt = 0;
  if (bestKey) {
    // gemiddelde normaal van het beste vak, dan alles binnen ~4° optellen
    let mx = 0, my = 0, mz = 0;
    for (let i = 0; i < faces.length; i += 4) if (Math.round(faces[i] * 20) + ',' + Math.round(faces[i + 1] * 20) === bestKey) { mx += faces[i] * faces[i + 3]; my += faces[i + 1] * faces[i + 3]; mz += faces[i + 2] * faces[i + 3]; }
    const ml = Math.hypot(mx, my, mz); mx /= ml; my /= ml; mz /= ml;
    for (let i = 0; i < faces.length; i += 4) if (faces[i] * mx + faces[i + 1] * my + faces[i + 2] * mz > 0.9975) flatUp += faces[i + 3];
    tilt = Math.acos(Math.min(1, mz)) * 180 / Math.PI;
  }
  const vol = Math.abs(q.volume);
  return { triangles: q.faces, watertight: q.watertight, open: q.open, nonManifold: q.nonManifold, components: q.components,
    volume: vol, area: q.area, dims: q.dimensions, meanWall: q.area ? 2 * vol / q.area : 0, flatUp, tilt };
}

export function classifyGeometry(m) {
  if (!m) return null;
  if (m.volume < 5 || m.triangles < 600) return 'fragment';
  if (m.dims[0] < 20 && m.dims[1] < 20) return 'provisorium';
  if (m.flatUp > 300 && m.dims[2] > 18 && m.meanWall > 2.0) return 'beetwal';
  if (m.meanWall < 2.6) return 'plaat';
  return null;
}

// ---------- groeperen & controleren ----------
export function levenshtein(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const titleCase = s => s.replace(/\b[a-z]/g, c => c.toUpperCase()).replace(/\b(De|Van|Ten|Der|Den)\b/g, w => w.toLowerCase()).replace(/^./, c => c.toUpperCase());

/**
 * files: [{ name, size, text?(3ox/inf/pts), metrics?(stl) }]
 * Geeft { orders, patients, issues, totals } terug.
 */
export function analyseOrders(files, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const orders = new Map();
  const get = name => { const k = orderStem(name); if (!orders.has(k)) orders.set(k, { key: k, name: parseName(name), stl: [], ox: null, inf: [], pts: [], issues: [] }); return orders.get(k); };
  for (const f of files) {
    const o = get(f.name), ext = f.name.split('.').pop().toLowerCase();
    if (ext === 'stl') o.stl.push({ file: f.name, part: partIndex(f.name), metrics: f.metrics, error: f.error });
    else if (ext === '3ox') { try { o.ox = parse3ox(f.text); } catch (e) { o.issues.push(['fout', '3ox onleesbaar: ' + e.message]); } }
    else if (ext === 'inf') o.inf.push({ file: f.name, ...parseInf(f.text) });
    else if (ext === 'pts') o.pts.push({ file: f.name, ...parsePts(f.text) });
  }
  const issue = (o, level, text) => o.issues.push([level, text]);
  for (const o of orders.values()) {
    const n = o.name;
    o.stl.sort((a, b) => a.file.localeCompare(b.file));
    // product
    const geo = o.stl.map(s => classifyGeometry(s.metrics)).filter(g => g && g !== 'fragment');
    const ct = o.ox?.elements?.[0]?.typeClass;
    o.product = n.product === 'provisorium' || ct === 'TemporaryCrownPontic' ? 'provisorium'
      : n.product === 'copydenture' || ct === 'CopyDentureTray' ? 'copydenture'
      : geo.includes('beetwal') ? 'beetwal' : n.product || (ct === 'CustomImpressionTray' ? 'plaat' : geo.includes('plaat') ? 'plaat' : 'onbekend');
    if (o.product === 'plaat') o.product = n.product || 'onbekend';
    // tanden / kaak
    const teeth = [...new Set([...(o.inf.map(i => i.tooth).filter(Boolean)), ...teethFromText(o.ox?.caseType)])];
    o.teeth = teeth;
    const jaws = new Set(teeth.map(jawOfTooth).filter(Boolean));
    o.jawFromTeeth = jaws.size === 2 ? 'ok+bk' : [...jaws][0] ?? null;
    o.jaw = n.jaw ?? o.jawFromTeeth;
    o.delivery = o.ox?.delivery ?? o.inf[0]?.delivery ?? n.date ?? null;
    o.operator = o.ox?.operator ?? null;
    o.source = o.ox ? (o.ox.app ?? '3Shape') + (o.ox.scanSource ? ' · ' + o.ox.scanSource : '') : n.keywords.includes('acta') ? 'los bestand (ACTA)' : 'los bestand';

    if (n.jaw && o.jawFromTeeth && o.jawFromTeeth !== 'ok+bk' && n.jaw !== 'ok+bk' && n.jaw !== o.jawFromTeeth)
      issue(o, 'fout', `Naam zegt ${n.jaw.toUpperCase()}, maar 3Shape-element ${teeth.join(', ')} hoort bij de ${o.jawFromTeeth.toUpperCase()}.`);
    if (!n.jaw && !o.jawFromTeeth) issue(o, 'let op', 'Kaak (OK/BK) niet te bepalen uit naam of 3Shape-gegevens.');
    if (!n.orderNo) issue(o, 'let op', 'Geen ordernummer (4 cijfers) in de naam.');
    if (n.keywords.includes('kaak-vastgeplakt')) issue(o, 'info', `Kaak vastgeplakt aan de naam ("${n.base}"): gebruik een spatie.`);
    if (!o.stl.length) issue(o, 'fout', 'Order zonder STL-bestand.');
    if (!o.ox && o.stl.length) issue(o, 'info', 'Los STL-bestand zonder 3Shape-order (3ox/inf).');
    if (o.ox) {
      const camExpected = o.ox.elements.flatMap(e => e.cam);
      const haveStl = new Set(o.stl.map(s => stem(s.file)));
      const missing = camExpected.filter(c => !haveStl.has(stem(c)) && !o.stl.some(s => stem(s.file).startsWith(stem(c) + '_')));
      if (missing.length) issue(o, 'fout', `STL ontbreekt: ${missing.join(', ')}.`);
      if (o.inf.length && o.inf.length !== o.ox.elements.length) issue(o, 'let op', `${o.ox.elements.length} elementen in 3ox, ${o.inf.length} inf-bestanden.`);
      if (o.product === 'provisorium' && /denture base/i.test(o.ox.material ?? '')) issue(o, 'let op', 'Tijdelijke kronen staan op materiaal "Denture base". Klopt het materiaal?');
      if (n.shade && !o.ox.elements.some(e => e.color)) issue(o, 'info', `Kleur ${n.shade} staat alleen in de naam, niet in het 3Shape-kleurveld.`);
    }
    for (const s of o.stl) {
      const m = s.metrics;
      if (s.error) { issue(o, 'fout', `${s.file}: ${s.error}`); continue; }
      if (!m) continue;
      if (!m.watertight) issue(o, 'fout', `${s.file}: niet gesloten (${m.open} open randen, ${m.nonManifold} niet-manifold).`);
      if (classifyGeometry(m) === 'fragment') issue(o, 'let op', `${s.file}: los mini-fragment (${m.triangles} driehoeken, ${m.volume.toFixed(1)} mm³). Waarschijnlijk restant/label: niet meeprinten of controleren.`);
      else if (m.components > 1) issue(o, 'let op', `${s.file}: bestaat uit ${m.components} losse delen.`);
      if (m.dims[2] > 60) issue(o, 'info', `${s.file}: hoog werkstuk (${m.dims[2].toFixed(0)} mm), let op printhoogte.`);
    }
    if (o.delivery && o.delivery < today) o.late = true;
    o.patientKey = n.orderNo ? 'nr' + n.orderNo : 'naam:' + n.patient;
  }

  // patiënten: per ordernummer, namen vergelijken
  const patients = new Map();
  for (const o of orders.values()) {
    if (!patients.has(o.patientKey)) patients.set(o.patientKey, { key: o.patientKey, orderNo: o.name.orderNo, names: new Map(), orders: [] });
    const p = patients.get(o.patientKey); p.orders.push(o);
    if (o.name.patient) p.names.set(o.name.patient, (p.names.get(o.name.patient) || 0) + 1);
  }
  for (const p of patients.values()) {
    const names = [...p.names.keys()];
    p.name = titleCase(names.sort((a, b) => (p.names.get(b) - p.names.get(a)) || b.length - a.length)[0] || '(geen naam)');
    if (names.length > 1) {
      const close = names.every(a => names.every(b => levenshtein(a, b) <= 2));
      for (const o of p.orders) issue(o, close ? 'let op' : 'fout', close
        ? `Spelling patiëntnaam wisselt bij order ${p.orderNo}: ${names.map(titleCase).join(' / ')}.`
        : `Ordernummer ${p.orderNo} gebruikt voor verschillende namen: ${names.map(titleCase).join(' / ')}.`);
    }
    const jaws = new Set(p.orders.map(o => o.jaw).filter(Boolean));
    p.jaws = [...jaws].sort();
    const kinds = new Set(p.orders.map(o => o.product));
    p.products = [...kinds];
    if ((kinds.has('lepel') || kinds.has('beetplaat')) && jaws.size === 1 && !jaws.has('ok+bk'))
      p.note = `Alleen ${[...jaws][0].toUpperCase()} aanwezig`;
  }
  // zelfde naam, ander ordernummer
  const byName = new Map();
  for (const p of patients.values()) { const k = p.name.toLowerCase(); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(p); }
  for (const list of byName.values()) if (list.length > 1 && list[0].name !== '(geen naam)')
    for (const p of list) for (const o of p.orders) issue(o, 'let op', `Patiënt ${p.name} komt voor met meerdere ordernummers: ${list.map(x => x.orderNo ?? '–').join(', ')}.`);
  // naamformaat
  const styles = new Set([...orders.values()].map(o => namingStyle(o.name.base)));
  const list = [...orders.values()];
  const totals = {
    orders: list.length, patients: patients.size, stl: list.reduce((s, o) => s + o.stl.length, 0),
    errors: list.filter(o => o.issues.some(i => i[0] === 'fout')).length,
    warnings: list.filter(o => o.issues.some(i => i[0] === 'let op')).length,
    namingStyles: [...styles],
    volume: list.reduce((s, o) => s + o.stl.reduce((t, x) => t + (x.metrics && classifyGeometry(x.metrics) !== 'fragment' ? x.metrics.volume : 0), 0), 0),
  };
  return { orders: list, patients: [...patients.values()], totals };
}

export function namingStyle(base) {
  const t = base.toLowerCase().split(/[\s_]+/);
  const first = t[0];
  if (PRODUCT_WORDS[first]) return 'product eerst';
  if (JAW_WORDS[first]) return 'kaak eerst';
  if (/_/.test(base)) return 'underscores';
  return 'patiënt eerst';
}
export function suggestedName(o, patient) {
  const prod = { lepel: 'lepel', beetplaat: 'beetplaat', beetwal: 'beetwal', copydenture: 'copydenture', provisorium: 'provisorium' }[o.product] ?? 'werkstuk';
  return [o.name.orderNo ?? '0000', patient.toLowerCase().replace(/\s+/g, '-'), prod, (o.jaw ?? '').replace('+', '')].filter(Boolean).join(' ');
}

// ---------- printsimulatie ----------
export const PRINTERS = {
  ultra32: { label: 'Asiga Ultra (32)', x: 119, y: 67, z: 130, layerSec: 6 },
  ultra50: { label: 'Asiga Ultra (50)', x: 189, y: 106, z: 130, layerSec: 6 },
  max: { label: 'Asiga MAX / MAX UV / Max 2', x: 119, y: 67, z: 75, layerSec: 7 },
  form4: { label: 'Formlabs Form 4/4B', x: 200, y: 125, z: 210, layerSec: 4.5 },
  sprintray: { label: 'SprintRay Pro 95', x: 192, y: 108, z: 200, layerSec: 6 },
};

/**
 * Plaatst werkstukken (footprint = bounding box in XY, staand of liggend) per printplaat met een eenvoudige
 * rij-indeling (shelf packing) en schat tijd en hars.
 * parts: [{ id, label, dims:[x,y,z], volume }]
 */
// Oriëntaties (benadering met de omhullende doos; +6 mm voor supports/basis):
//   rechtop: op de hielen, boog omhoog (smalste footprint, hoogste)   staand: op de rand, occlusaal opzij
//   schuin: ~45°   plat: weefselzijde omhoog   auto: per werkstuk de kleinste footprint die in de hoogte past
const ORIENT = {
  rechtop: (long, short, z) => [short, z, long + 6],
  staand: (long, short, z) => [long, z, short + 6],
  schuin: (long, short, z) => [long, short * 0.71 + z * 0.71, short * 0.71 + z * 0.71 + 6],
  plat: (long, short, z) => [long, short, z + 6],
};
export function simulatePrint(parts, { printer = 'ultra32', layer = 0.1, gap = 4, supportFactor = 1.35, orientation = 'auto', resinPerL = 150, baseMin = 10, layerSec = null } = {}) {
  const P = { ...(PRINTERS[printer] ?? PRINTERS.ultra32) };
  if (layerSec > 0) P.layerSec = layerSec;
  const items = parts.map(p => {
    const [x, y, z] = p.dims, long = Math.max(x, y), short = Math.min(x, y);
    const modes = long < 20 ? ['plat'] : orientation === 'auto' ? ['rechtop', 'staand', 'schuin', 'plat'] : [orientation];
    // schuin: hoek tussen 20° en 70° proberen (gekanteld om de lange as)
    const options = modes.flatMap(m => m === 'schuin' ? [20, 30, 40, 50, 60, 70].map(a => { const r = a * Math.PI / 180;
      return { mode: `schuin ${a}°`, dims: [long, short * Math.cos(r) + z * Math.sin(r), short * Math.sin(r) + z * Math.cos(r) + 6] }; }) : [{ mode: m, dims: ORIENT[m](long, short, z) }]);
    let best = null;
    for (const { mode, dims } of options) {
      let [w, d, h] = dims;
      if (w > P.x && w <= P.y && d <= P.x) [w, d] = [d, w]; // 90° draaien op de plaat
      const fits = w <= P.x && d <= P.y && h <= P.z;
      const score = (fits ? 0 : 1e9) + w * d + h * 0.01;
      if (!best || score < best.score) best = { mode, w, d, h, fits, score };
    }
    return { ...p, mode: best.mode, w: best.w + gap, d: best.d + gap, h: best.h, fits: best.fits };
  }).sort((a, b) => b.d - a.d || b.w - a.w);
  const plates = [];
  for (const it of items.filter(i => i.fits)) {
    let placed = false;
    for (const pl of plates) {
      for (const row of pl.rows) if (row.d >= it.d && row.x + it.w <= P.x + gap) { it.at = [row.x, row.y]; row.x += it.w; pl.items.push(it); placed = true; break; }
      if (placed) break;
      const used = pl.rows.reduce((s, r) => s + r.d, 0);
      if (used + it.d <= P.y + gap) { const row = { y: used, d: it.d, x: it.w }; pl.rows.push(row); it.at = [0, used]; pl.items.push(it); placed = true; break; }
    }
    if (!placed) { plates.push({ rows: [{ y: 0, d: it.d, x: it.w }], items: [it] }); it.at = [0, 0]; }
  }
  for (const pl of plates) {
    pl.height = Math.max(...pl.items.map(i => i.h));
    pl.layers = Math.ceil(pl.height / layer);
    pl.minutes = Math.round(baseMin + pl.layers * P.layerSec / 60);
    pl.resinMl = pl.items.reduce((s, i) => s + i.volume * supportFactor, 0) / 1000;
    pl.areaUse = pl.items.reduce((s, i) => s + (i.w - gap) * (i.d - gap), 0) / (P.x * P.y);
  }
  const resinMl = plates.reduce((s, p) => s + p.resinMl, 0);
  return { printer: P, plates, tooBig: items.filter(i => !i.fits), resinMl, resinCost: resinMl / 1000 * resinPerL, minutes: plates.reduce((s, p) => s + p.minutes, 0) };
}

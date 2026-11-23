// Anatomische analyse van een tandeloze kaak: plooi (vestibulum), frenula, omtreklijn per werkstuk,
// weefselzones (drukdragend / ontlasten / afsluiting) en aanpassen van de scan richting ideaal.
//
// Regels uit de prothetiekliteratuur (o.a. Zarb/Boucher, opleidingsdictaten):
//  - Individuele lepel: rand 2–3 mm korter dan de diepte van het vestibulum (ruimte voor randvormen), achter
//    door de hamulus-insnoeringen en 2–3 mm voorbij de A-lijn (vibrating line).
//  - Beetplaat/basis: tot in de plooi (functionele diepte); BK tot de A-lijn door de hamulus-insnoeringen;
//    OK over ⅔ van de retromolaire pad.
//  - Frenula: V-vormige uitsparing, net breed en diep genoeg.
//  - BK drukdragend: horizontale delen van het harde verhemelte naast de raphe, postero-laterale kamhellingen,
//    stevige tubera. Ontlasten: papilla incisiva, raphe mediana, torus palatinus, scherpe benige uitsteeksels.
//  - OK drukdragend: buccal shelf (tussen buccale frenulum en m. masseter), retromolaire pad. Ontlasten: scherpe
//    linea mylohyoidea, scherpe kam, tongriem.
//  - Post-dam (achterste afsluiting BK) in een smalle band vóór de A-lijn.
//
// Alles werkt in het boogassenstelsel (frame: O, X = patiënt-links, Y = naar voren, N = occlusaal).
// cast(origin, dir) → { point:[x,y,z] } | null  (eerste treffer op de scan; in de browser via de BVH van de scan).
import { archPoint, formArch, polylineArch, offsetArch, toothDimensions } from './teeth.js';
import { framePoint, frameBuccal } from './setup.js';
import { weld, toSoup, vertexNormals } from './mesh.js';

export const ZONE = { none: 0, primary: 1, secondary: 2, relief: 3, seal: 4, border: 5 };
export const ZONE_LABEL = { 1: 'Drukdragend (primair)', 2: 'Drukdragend (secundair)', 3: 'Ontlasten', 4: 'Afsluiting (post-dam / pad)', 5: 'Randgebied (plooi)' };
export const RULES = {
  lepel: { short: 2.0, posterior: 2.5, padCover: 1, label: 'Individuele lepel: 2 mm korter dan de plooi (ruimte voor randvormen), BK 2,5 mm voorbij de A-lijn, OK over de hele retromolaire pad' },
  beetplaat: { short: 0.5, posterior: 0, label: 'Beetplaat: tot in de plooi (0,5 mm marge), achter tot de A-lijn / ⅔ retromolaire pad' },
  basis: { short: 0, posterior: 0, label: 'Prothesebasis: tot de functionele plooidiepte, achter tot de A-lijn / ⅔ retromolaire pad' },
};

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = a => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };

/** Hoogte (langs N) van de scan boven het punt q, door van boven te stralen. */
function surfaceAt(cast, frame, q, reach = 40) {
  const hit = cast(add(q, frame.N, reach), frame.N.map(v => -v));
  return hit ? hit.point : null;
}

/**
 * Analyseer de boog: kamlijn, buccale (en voor OK linguale) profielen, plooi, frenula, tubera/pads.
 * opts.form: boogvorm, opts.samples: aantal profielen.
 */
export function analyseArch(cast, frame, { form = 'oval', samples = 60, maxReach = 22, stepD = 0.4, arch = null } = {}) {
  const upper = frame.jaw === 'upper', H = p => dot(sub(p, frame.O), frame.N);
  const curve = arch ?? formArch({ width: frame.width, depth: frame.depth, form: form === 'crest' ? 'oval' : form });
  const profiles = [];
  for (let i = 0; i <= samples; i++) {
    const t = -1 + 2 * i / samples;
    const [x, y] = curve(t);
    const [x2, y2] = curve(Math.min(1, t + 2e-3)), [x1, y1] = curve(Math.max(-1, t - 2e-3));
    const tl = Math.hypot(x2 - x1, y2 - y1) || 1, B = frameBuccal(frame, x, y, [(x2 - x1) / tl, (y2 - y1) / tl]);
    // kam: hoogste punt in een strook van ±4 mm loodrecht op de boog (de boogformule is een benadering)
    let crest = null;
    for (let d = -4; d <= 4; d += 0.5) { const p = surfaceAt(cast, frame, add(framePoint(frame, x, y, 0), B, d)); if (p && (!crest || H(p) > H(crest))) crest = p; }
    if (!crest) { profiles.push({ t, missing: true }); continue; }
    const sides = { buccal: walk(1), lingual: upper ? null : walk(-1) };
    profiles.push({ t, crest, B, h: H(crest), ...sides });
    function walk(sign) {
      const pts = [];
      for (let d = stepD; d <= maxReach; d += stepD) { const p = surfaceAt(cast, frame, add(crest, B, sign * d)); if (!p) break; pts.push({ d, p, h: H(p) }); }
      if (pts.length < 3) return { pts, sulcus: null, edge: true };
      // plooi: eerste duidelijke dal na de kam (≥ 2,5 mm onder de kam, daarna ≥ 0,8 mm omhoog) of de scanrand
      let iMin = 0;
      for (let k = 1; k < pts.length; k++) {
        if (pts[k].h < pts[iMin].h) iMin = k;
        else if (pts[iMin].h < H(crest) - 2.5 && pts[k].h > pts[iMin].h + 0.8) break;
      }
      const rises = pts.slice(iMin).some(q => q.h > pts[iMin].h + 0.8);
      return { pts, sulcus: pts[iMin], edge: !rises };
    }
  }
  // frenula: plooi plotseling ondieper dan de buren (smal), per zijde
  const frena = [];
  for (const side of upper ? ['buccal'] : ['buccal', 'lingual']) {
    const depth = profiles.map(p => p.missing || !p[side]?.sulcus ? null : p.h - p[side].sulcus.h);
    for (let i = 2; i < depth.length - 2; i++) {
      if (depth[i] == null) continue;
      const nb = [];
      for (let k = i - 6; k <= i + 6; k++) if (k >= 0 && k < depth.length && Math.abs(k - i) > 2 && depth[k] != null) nb.push(depth[k]);
      if (nb.length < 4) continue;
      nb.sort((a, b) => a - b); const ref = nb[Math.floor(nb.length / 2)];
      const isMin = depth[i] <= (depth[i - 1] ?? Infinity) && depth[i] <= (depth[i + 1] ?? Infinity);
      if (isMin && ref - depth[i] > 2) frena.push({ side, i, t: profiles[i].t, deficit: ref - depth[i], at: profiles[i][side].sulcus.p });
    }
  }
  // uiteinden: BK tuber/hamulus, OK retromolaire pad — het verlengde van de kam naar achteren volgen
  const ends = [profiles.find(p => !p.missing), [...profiles].reverse().find(p => !p.missing)].map(p => {
    if (!p) return null;
    const back = frame.Y.map(v => -v);
    let last = p.crest, lastH = p.h, drop = null, top = p.h;
    for (let d = 1; d <= 16; d += 0.5) {
      const q = surfaceAt(cast, frame, add(p.crest, back, d)); if (!q) break;
      if (upper && H(q) < lastH - 0.9 && !drop) drop = { d, p: q };   // insnoering achter het tuber (hamulus)
      if (!drop) top = Math.max(top, H(q));
      last = q; lastH = Math.max(lastH - 0.3, H(q));
    }
    // padTop: hoogste punt achter de kam (OK: retromolaire pad; BK: tuber), gemeten langs N
    return { t: p.t, crest: p.crest, hamular: drop?.p ?? add(p.crest, back, 4), hamularD: drop?.d ?? 4, padEnd: last, crestH: p.h, padTop: top };
  });
  const sulcusDepths = profiles.filter(p => p.buccal?.sulcus).map(p => p.h - p.buccal.sulcus.h);
  return { frame, form, profiles, frena, ends, stats: { sulcusDepthMedian: median(sulcusDepths), profiles: profiles.length, missing: profiles.filter(p => p.missing).length, edge: profiles.filter(p => p.buccal?.edge).length } };
}

/**
 * Gemeten kamlijn als boog: de kamtoppen uit de analyse, gladgestreken, in frame-coördinaten.
 * Geeft een boogfunctie (t ∈ [-1, 1] → [x, y], t = 0 op de middellijn) met .heightAt(t) (kamhoogte langs N), of null.
 */
export function crestArch(an, { smooth = 3, extend = 0 } = {}) {
  const f = an.frame, ok = an.profiles.filter(p => !p.missing);
  if (ok.length < 10) return null;
  let P = ok.map(p => { const d = sub(p.crest, f.O); return [dot(d, f.X), dot(d, f.Y), p.h]; });
  for (let it = 0; it < smooth; it++) P = P.map((p, i) => i === 0 || i === P.length - 1 ? p : [0, 1, 2].map(k => (P[i - 1][k] + 2 * p[k] + P[i + 1][k]) / 4));
  const arch = polylineArch(P.map(p => [p[0], p[1]]), { extend });
  const hs = P.map(p => p[2]);
  arch.heightAt = t => { const i = Math.max(0, Math.min(hs.length - 1, Math.round((t + 1) / 2 * (hs.length - 1)))); return hs[i]; };
  return arch;
}

/**
 * Buccolinguale positie van de tanden t.o.v. de kam (mm, + = buccaal/labiaal), als functie van de booglengte s vanaf
 * de middellijn. Regels (o.a. Gysi/Gerber, Pound-lijn):
 *  - BK front labiaal van de kam (resorptie verloopt naar palatinaal): centrale/laterale ~4 mm, hoektand ~2,5 mm;
 *  - BK zijdelings: centrale fissuur boven de kam (lingualiseerd: palatinale knobbel boven de kam → +1 mm);
 *  - OK front op of iets labiaal van de kam (~1 mm); OK zijdelings: centrale fissuur boven de kam (binnen de Pound-lijn).
 */
export function toothOffsetRule(jaw, { front = null, concept = 'gysi', scale = 1 } = {}) {
  const upper = jaw === 'upper';
  const q = upper ? 1 : 4, w = k => toothDimensions(q * 10 + k, scale).md;
  const sFront = w(1) + w(2) * 0.5, sCanine = w(1) + w(2) + w(3) * 0.5, sPost = w(1) + w(2) + w(3) + w(4) * 0.5;
  const fFront = front ?? (upper ? 4 : 1), fCanine = upper ? fFront * 0.65 : fFront * 0.8;
  const fPost = upper ? (concept === 'lingual' || concept === 'gerber' ? 1 : 0) : 0;
  const lerp = (a, b, u) => a + (b - a) * Math.max(0, Math.min(1, u));
  return s => s <= sFront ? fFront : s <= sCanine ? lerp(fFront, fCanine, (s - sFront) / (sCanine - sFront)) : lerp(fCanine, fPost, (s - sCanine) / (sPost - sCanine));
}

/** Boog voor tanden/beetwal: gemeten kamlijn verschoven volgens toothOffsetRule. */
export function setupArch(an, opts = {}) {
  const crest = crestArch(an, { extend: opts.extend ?? 6 }); if (!crest) return null;
  const arch = offsetArch(crest, toothOffsetRule(an.frame.jaw, opts));
  arch.crest = crest;
  return arch;
}

/**
 * Hoogte van het occlusievlak volgens de plooiregel (beetwalhoogte uit de prothetiekliteratuur):
 *  - BK: 22 mm vanaf de diepste plooi in het front, 18 mm in het tubergebied;
 *  - OK: 18 mm vanaf de plooi in het front, achter op ⅔ van de hoogte van de retromolaire pad.
 * Hoogtes langs N vanaf het boogvlak (frame), zodat ze direct bruikbaar zijn als 'kam → occlusievlak'.
 * Geeft { front, back, at(s, sMax), notes[] }.
 */
export function occlusalPlaneRule(an, { upperFront = 22, upperBack = 18, lowerFront = 18, padFraction = 2 / 3 } = {}) {
  const upper = an.frame.jaw === 'upper', notes = [];
  const fold = sel => {
    const v = an.profiles.filter(p => !p.missing && p.buccal?.pts?.length && sel(Math.abs(p.t))).map(p => ({ h: (p.buccal.sulcus ?? p.buccal.pts.at(-1)).h, edge: p.buccal.edge }));
    if (!v.length) return null;
    const hs = v.map(x => x.h).sort((a, b) => a - b);
    // diepste plooi: BK ligt de plooi 'boven' de kam (kleinere h), OK eronder (ook kleinere h) → laag kwartiel
    return { h: hs[Math.floor(hs.length * 0.25)], edge: v.filter(x => x.edge).length > v.length / 2 };
  };
  const ff = fold(t => t < 0.3), fb = fold(t => t > 0.7);
  if (!ff) return null;
  if (ff.edge || fb?.edge) notes.push('plooi niet volledig gescand: scanrand gebruikt');
  // de plooi ligt aan de andere kant van de kam dan het occlusievlak: hoogte = plooihoogte + regelafstand
  const front = ff.h + (upper ? upperFront : lowerFront);
  let back;
  if (upper) back = fb ? fb.h + upperBack : front - (upperFront - upperBack);
  else {
    const pads = an.ends.filter(e => e && e.padTop - e.crestH > 1);
    if (pads.length) back = pads.reduce((s, e) => s + e.crestH + (e.padTop - e.crestH) * padFraction, 0) / pads.length;
    else { back = front - 4; notes.push('retromolaire pad niet gevonden: achter 4 mm lager dan voor'); }
  }
  return { front, back, notes, edge: !!(ff.edge || fb?.edge), at: (s, sMax) => front + (back - front) * Math.max(0, Math.min(1, s / (sMax || 1))) };
}

/**
 * Statiek van de opstelling t.o.v. de gemeten kam. teeth: [{ fdi, x, y }] in frame-coördinaten (tandcentrum in het boogvlak).
 * Regels: zijdelingse tanden met de centrale fissuur boven de kam (BK ≤ 2 mm ernaast; OK ≤ 1,5 mm: binnen de Pound-lijn),
 * geen elementen voorbij het einde van de kam (BK tuber, OK retromolaire pad: kantelgevaar), front labiaal toegestaan.
 */
export function staticsReport(teeth, an) {
  const crest = crestArch(an); if (!crest) return null;
  const P = crest.points, upper = an.frame.jaw === 'upper';
  const ys = P.map(p => p[1]), c = [0, Math.min(...ys) + 0.35 * (Math.max(...ys) - Math.min(...ys))];
  return teeth.map(({ fdi, x, y }) => {
    let best = Infinity, bi = 0, bu = 0;
    for (let i = 1; i < P.length; i++) {
      const a = P[i - 1], b = P[i], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
      const u = ((x - a[0]) * dx + (y - a[1]) * dy) / L2, uc = Math.max(0, Math.min(1, u));
      const d = Math.hypot(x - a[0] - uc * dx, y - a[1] - uc * dy);
      if (d < best) { best = d; bi = i; bu = u; }
    }
    // voorbij het uiteinde: projectie valt buiten het eerste/laatste segment
    const segLen = i => Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
    const beyond = bi === 1 && bu < 0 ? -bu * segLen(1) : bi === P.length - 1 && bu > 1 ? (bu - 1) * segLen(P.length - 1) : 0;
    const a = P[bi - 1], b = P[bi], uc = Math.max(0, Math.min(1, bu)), q = [a[0] + uc * (b[0] - a[0]), a[1] + uc * (b[1] - a[1])];
    const sign = Math.hypot(x - c[0], y - c[1]) >= Math.hypot(q[0] - c[0], q[1] - c[1]) ? 1 : -1;
    const offset = sign * best, type = fdi % 10, posterior = type >= 4;
    const limit = upper ? 2 : 1.5;
    let level = 'ok', msg = '';
    if (beyond > 2) { level = 'warn'; msg = `${fmt1(beyond)} mm voorbij het einde van de kam (${upper ? 'tuber' : 'retromolaire pad'}): kantelgevaar, weglaten of kleiner kiezen`; }
    else if (posterior && Math.abs(offset) > limit) { level = 'warn'; msg = `${fmt1(Math.abs(offset))} mm ${offset > 0 ? 'buccaal' : 'linguaal'} van de kam (max ${fmt1(limit)}${upper ? '' : ', Pound-lijn'})`; }
    else msg = posterior ? `${fmt1(Math.abs(offset))} mm ${offset >= 0 ? 'buccaal' : 'linguaal'} van de kam` : `${fmt1(offset)} mm labiaal van de kam`;
    return { fdi, offset, beyond, level, msg };
  });
}
const fmt1 = v => v.toFixed(1).replace('.', ',');

const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/** Punt op het profiel waar de hoogte de plooidiepte + 'short' bereikt (vanaf de plooi terug naar de kam).
 * Is de plooi niet gescand (profiel loopt door tot de scanrand of het aangevulde deel), dan geldt de verwachte
 * plooidiepte 'expected' (mm onder de kam, uit de rest van de kaak of uit de literatuur). */
function borderPoint(side, short, crestH = null, expected = null) {
  if (!side?.pts?.length) return null;
  let s = side.sulcus ?? side.pts.at(-1);
  if (side.edge && expected != null && crestH != null) {
    const target = crestH - expected, hit = side.pts.find(q => q.h <= target);
    s = hit ?? side.pts.at(-1);
  }
  const iS = side.pts.indexOf(s);
  if (short <= 0) return s.p;
  for (let k = iS; k >= 0; k--) if (side.pts[k].h >= s.h + short) return side.pts[k].p;
  return side.pts[0].p;
}

/** Verwachte plooidiepte (mm onder de kam): mediaan van de profielen waar de plooi wél gescand is, anders literatuur/labwaarde. */
export const DEFAULT_SULCUS = { upper: 8, lower: 7 };
export function expectedSulcus(analysis, side = 'buccal') {
  const d = analysis.profiles.filter(p => !p.missing && p[side]?.sulcus && !p[side].edge).map(p => p.h - p[side].sulcus.h);
  if (d.length >= Math.max(5, analysis.profiles.length * 0.2)) return { depth: median(d), source: 'gemeten' };
  return { depth: DEFAULT_SULCUS[analysis.frame.jaw] - (side === 'lingual' ? 1 : 0), source: 'standaard' };
}

/**
 * Omtreklijn voor een werkstuk ('lepel' | 'beetplaat' | 'basis'): gesloten lijst van 3D-punten op de scan.
 * Frenula krijgen een V-uitsparing; BK achter door de hamulus-insnoeringen (A-lijn), OK over ⅔ van de pad.
 */
export function proposeOutline(cast, analysis, kind = 'beetplaat', { frenumRelief = 1.0, padCover = 2 / 3, padLength = 10, smooth = 2, maxPoints = 140 } = {}) {
  const { frame, profiles, frena, ends } = analysis, upper = frame.jaw === 'upper', rule = RULES[kind] ?? RULES.beetplaat;
  const H = p => dot(sub(p, frame.O), frame.N);
  // frenum-uitsparing: labiaal smal, buccaal breder (het buccale frenum beweegt mee naar voren en achteren)
  const extra = (side, i) => {
    const f = frena.find(q => q.side === side && Math.abs(q.i - i) <= (side === 'buccal' && Math.abs(q.t) > 0.2 ? 2 : 1)); if (!f) return 0;
    const k = Math.abs(f.i - i); return f.deficit * (k === 0 ? 1 : k === 1 ? 0.6 : 0.3) + frenumRelief;
  };
  const exp = { buccal: expectedSulcus(analysis, 'buccal'), lingual: upper ? null : expectedSulcus(analysis, 'lingual') };
  const sideLine = side => profiles.map((p, i) => p.missing ? null : borderPoint(p[side], rule.short + extra(side, i), p.h, exp[side]?.depth)).filter(Boolean);
  let buccal = sideLine('buccal');
  if (buccal.length < 5) throw Error('Te weinig vestibulum gevonden. Controleer de referentiepunten (stap Analyse) of teken de omtrek met de hand.');
  buccal = smoothLine(buccal, smooth);
  let loop;
  if (upper) {
    // achterrand: van hamulus R via het verhemelte naar hamulus L, midden 2 mm naar achteren (fovea palatinae)
    const [eR, eL] = ends, back = frame.Y.map(v => -v);
    const hR = add(eR.hamular, back, rule.posterior), hL = add(eL.hamular, back, rule.posterior), post = [];
    for (let k = 1; k < 12; k++) {
      const u = k / 12, q = add(add(hL, sub(hR, hL), u), back, 2 * Math.sin(Math.PI * u));
      const s = surfaceAt(cast, frame, q); if (s) post.push(s);
    }
    loop = [...buccal, surfaceAt(cast, frame, hL) ?? hL, ...post, surfaceAt(cast, frame, hR) ?? hR];
  } else {
    let lingual = sideLine('lingual');
    if (lingual.length < 5) throw Error('Linguale plooi niet gevonden. Teken de omtrek met de hand.');
    lingual = smoothLine(lingual, smooth).reverse();
    const pad = e => {
      if (!e) return [];
      const back = frame.Y.map(v => -v), reach = padLength * padCover + rule.posterior, pts = [];
      for (const [b, f] of [[0.45, 0.5], [0, 1], [-0.45, 0.5]]) { // buccaal → top → linguaal rond de pad
        const side = e.t < 0 ? -1 : 1, lateral = frame.X.map(v => v * side * b * 6);
        const s = surfaceAt(cast, frame, add(add(e.crest, back, reach * (f === 1 ? 1 : 0.8)), lateral)); if (s) pts.push(s);
      }
      return pts;
    };
    loop = [...buccal, ...pad(ends[1]), ...lingual, ...pad(ends[0]).reverse()];
  }
  loop = loop.filter(Boolean);
  // uitdunnen tot maxPoints, gelijkmatig langs de lijn
  if (loop.length > maxPoints) { const step = loop.length / maxPoints; loop = Array.from({ length: maxPoints }, (_, i) => loop[Math.floor(i * step)]); }
  return { points: loop, rule: rule.label, frena: frena.length, minHeight: Math.min(...loop.map(H)), sulcus: exp };
}
function smoothLine(pts, it) {
  let a = pts.map(p => p.slice());
  for (let k = 0; k < it; k++) a = a.map((p, i) => i === 0 || i === a.length - 1 ? p : p.map((v, j) => (a[i - 1][j] + 2 * v + a[i + 1][j]) / 4));
  return a;
}

/**
 * Weefselzones per facet van de scan (Uint8Array met ZONE-codes) + uitleg.
 * Gebaseerd op ligging t.o.v. kam, plooi en middellijn, plus kromming voor scherpe richels en een torus-test.
 */
export function tissueZones(soup, analysis, { papillaOffset = 7, papillaRadius = 5, rapheHalf = 3, sealWidth = 4 } = {}) {
  const { frame, profiles, ends } = analysis, upper = frame.jaw === 'upper', n = soup.length / 9;
  const zones = new Uint8Array(n), F = p => { const d = sub(p, frame.O); return [dot(d, frame.X), dot(d, frame.Y), dot(d, frame.N)]; };
  const good = profiles.filter(p => !p.missing);
  const crestF = good.map(p => F(p.crest)), sulcusF = good.map(p => p.buccal?.sulcus ? F(p.buccal.sulcus.p) : null), lingF = good.map(p => p.lingual?.sulcus ? F(p.lingual.sulcus.p) : null);
  const M = F(good.reduce((a, p) => Math.abs(p.t) < Math.abs(a.t) ? p : a).crest);
  const papilla = [0, M[1] - papillaOffset];
  const hamY = upper && ends[0] && ends[1] ? (F(ends[0].hamular)[1] + F(ends[1].hamular)[1]) / 2 : null;
  // torus: middellijn duidelijk hoger dan het verhemelte ernaast
  let torus = null;
  if (upper) {
    // per dwarsdoorsnede (2 mm) een gladde verhemelteboog h = a + b·x² fitten op 5–12 mm naast het midden;
    // ligt het midden duidelijk hoger dan die boog voorspelt, dan is er een torus palatinus.
    const bins = new Map();
    for (let i = 0; i < n; i += 2) {
      const q = F([soup[i * 9], soup[i * 9 + 1], soup[i * 9 + 2]]);
      if (q[1] > papilla[1] - 4 || q[1] < (hamY ?? -1e9) + 4) continue;
      const k = Math.floor(q[1] / 2); if (!bins.has(k)) bins.set(k, []); bins.get(k).push(q);
    }
    const res = [];
    for (const list of bins.values()) {
      const sideP = list.filter(q => Math.abs(q[0]) > 5 && Math.abs(q[0]) < 12), midP = list.filter(q => Math.abs(q[0]) < 2.5);
      if (sideP.length < 6 || midP.length < 2) continue;
      let sx = 0, sy = 0, sxx = 0, sxy = 0; for (const q of sideP) { const u = q[0] * q[0]; sx += u; sy += q[2]; sxx += u * u; sxy += u * q[2]; }
      const m = sideP.length, bq = (m * sxy - sx * sy) / (m * sxx - sx * sx || 1), aq = (sy - bq * sx) / m;
      res.push(midP.reduce((t, q) => t + q[2], 0) / midP.length - aq);
    }
    res.sort((x, y) => x - y);
    const top = res.slice(Math.floor(res.length * 0.6));
    const h = top.length ? top.reduce((t, v) => t + v, 0) / top.length : 0;
    if (h > 1.5) torus = { height: h };
  }
  const nearestCrest = q => { let b = Infinity, k = 0; for (let i = 0; i < crestF.length; i++) { const d = Math.hypot(q[0] - crestF[i][0], q[1] - crestF[i][1]); if (d < b) { b = d; k = i; } } return { d: b, k }; };
  const curv = convexity(soup);
  for (let f = 0; f < n; f++) {
    const o = f * 9, c = [(soup[o] + soup[o + 3] + soup[o + 6]) / 3, (soup[o + 1] + soup[o + 4] + soup[o + 7]) / 3, (soup[o + 2] + soup[o + 5] + soup[o + 8]) / 3];
    const q = F(c), { d: dc, k } = nearestCrest(q), cr = crestF[k], sul = sulcusF[k], lin = lingF[k];
    // binnen/buiten de boog: vergelijk met de kam in de richting van het boogmidden
    const toCenter = Math.hypot(q[0], q[1] - frame.depth * 0.35) < Math.hypot(cr[0], cr[1] - frame.depth * 0.35);
    let z = ZONE.none;
    if (upper) {
      if (!toCenter) {
        const sd = sul ? Math.hypot(sul[0] - cr[0], sul[1] - cr[1]) : 8;
        z = dc < 2.5 ? ZONE.secondary : dc < sd - 1.5 ? ZONE.primary : ZONE.border; // kamhelling / plooi
      } else {
        z = dc < 2.5 ? ZONE.secondary : ZONE.primary;                              // hard verhemelte naast de raphe
        if (q[1] > papilla[1] - 2 && dc > 2.5) z = ZONE.secondary;                    // rugae (voorste derde)
        if (Math.abs(q[0]) < rapheHalf && q[1] < papilla[1]) z = ZONE.relief;         // raphe mediana
        if (Math.hypot(q[0] - papilla[0], (q[1] - papilla[1]) * 0.8) < papillaRadius) z = ZONE.relief; // papilla incisiva
        if (torus && Math.abs(q[0]) < 7 && q[1] < papilla[1] - 4) z = ZONE.relief;
      }
      if (hamY != null && q[1] < hamY + sealWidth && q[1] > hamY - 1 && (toCenter || dc < 4)) z = ZONE.seal; // post-dam band
    } else {
      if (!toCenter) {
        const sd = sul ? Math.hypot(sul[0] - cr[0], sul[1] - cr[1]) : 8, posterior = Math.abs(q[0]) > frame.width * 0.22;
        z = dc < 1.5 ? ZONE.secondary : dc < sd - 1 ? (posterior ? ZONE.primary : ZONE.secondary) : ZONE.border; // buccal shelf achter
      } else {
        const ld = lin ? Math.hypot(lin[0] - cr[0], lin[1] - cr[1]) : 8;
        z = dc < 1.5 ? ZONE.secondary : dc < ld - 1 ? ZONE.secondary : ZONE.border;
      }
      const yEnd = Math.min(crestF[0][1], crestF.at(-1)[1]);
      if (q[1] < yEnd - 1 && dc < 9) z = ZONE.seal;                                     // retromolaire pad
    }
    if (curv[f] > 0.55 && z !== ZONE.border && z !== ZONE.seal) z = ZONE.relief;       // scherpe richel (mylohyoidea, kam)
    zones[f] = z;
  }
  return { zones, torus, papilla: framePoint(frame, papilla[0], papilla[1], 0), hamY };
}

// Kromming per facet: hoeveel de normalen van de buren afwijken bij een bolle vorm (0 = vlak, 1 = zeer scherp).
function convexity(soup) {
  const m = weld(soup, 1e-5), vn = vertexNormals(m), p = m.positions, f = m.indices, n = f.length / 3, out = new Float32Array(n);
  // gemiddelde puntnormaal over een ring buren → vergelijk met de puntnormaal zelf, met teken (bol/hol) via de ligging
  const nbSum = new Float32Array(p.length), cnt = new Uint16Array(p.length / 3), cen = new Float32Array(p.length);
  for (let i = 0; i < f.length; i += 3) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) if (a !== b) {
    const u = f[i + a], v = f[i + b]; for (let d = 0; d < 3; d++) { nbSum[u * 3 + d] += vn[v * 3 + d]; cen[u * 3 + d] += p[v * 3 + d]; } cnt[u]++;
  }
  const sharp = new Float32Array(p.length / 3);
  for (let v = 0; v < p.length / 3; v++) {
    if (!cnt[v]) continue;
    const ax = nbSum[v * 3] / cnt[v], ay = nbSum[v * 3 + 1] / cnt[v], az = nbSum[v * 3 + 2] / cnt[v];
    const dev = 1 - (ax * vn[v * 3] + ay * vn[v * 3 + 1] + az * vn[v * 3 + 2]) / (Math.hypot(ax, ay, az) || 1);
    const cx = cen[v * 3] / cnt[v] - p[v * 3], cy = cen[v * 3 + 1] / cnt[v] - p[v * 3 + 1], cz = cen[v * 3 + 2] / cnt[v] - p[v * 3 + 2];
    const convex = (cx * vn[v * 3] + cy * vn[v * 3 + 1] + cz * vn[v * 3 + 2]) < 0; // buren liggen 'onder' het punt → bol
    sharp[v] = convex ? Math.min(1, dev * 40) : 0;
  }
  for (let i = 0; i < n; i++) out[i] = (sharp[f[i * 3]] + sharp[f[i * 3 + 1]] + sharp[f[i * 3 + 2]]) / 3;
  return out;
}

/**
 * Scan aanpassen richting ideaal:
 *  - gladmaken (Taubin, krimpt niet) om scanruis/kleine putjes weg te halen;
 *  - ontlasten: relief-zones (papil, raphe, torus, scherpe richels) naar de plaat toe verschuiven → ruimte in de plaat;
 *  - post-dam (alleen BK): smalle band iets het weefsel in → afsluitrand op de plaat.
 * Normalen van de scan wijzen van het weefsel af (naar de plaat).
 */
export function idealizeScan(soup, zoneInfo, { smoothIt = 2, relief = 0.5, reliefPapilla = 1.0, postDam = 0.8, doSmooth = true, doRelief = true, doPostDam = true, frame = null } = {}) {
  const m = weld(soup, 1e-5), p = m.positions, f = m.indices, nv = p.length / 3, zones = zoneInfo.zones;
  // zone per punt (maximum-prioriteit van de aanliggende facetten)
  const vz = new Uint8Array(nv), prio = [0, 1, 1, 3, 2, 0];
  for (let i = 0; i < f.length; i++) { const z = zones[Math.floor(i / 3)]; if (prio[z] > prio[vz[f[i]]] || !vz[f[i]]) vz[f[i]] = z; }
  const nb = Array.from({ length: nv }, () => []);
  for (let i = 0; i < f.length; i += 3) for (let k = 0; k < 3; k++) { const a = f[i + k], b = f[i + (k + 1) % 3]; nb[a].push(b); nb[b].push(a); }
  const boundary = new Uint8Array(nv); { const e = new Map(); for (let i = 0; i < f.length; i += 3) for (let k = 0; k < 3; k++) { const a = f[i + k], b = f[i + (k + 1) % 3], key = a < b ? a * 4294967296 + b : b * 4294967296 + a; e.set(key, (e.get(key) || 0) + 1); } for (const [key, c] of e) if (c === 1) { boundary[Math.floor(key / 4294967296)] = 1; boundary[key % 4294967296] = 1; } }
  const report = { smoothed: 0, relieved: 0, postDam: 0 };
  if (doSmooth) for (let it = 0; it < smoothIt * 2; it++) { // Taubin λ/μ
    const lam = it % 2 ? -0.53 : 0.5, next = p.slice();
    for (let v = 0; v < nv; v++) { if (boundary[v] || !nb[v].length) continue; for (let d = 0; d < 3; d++) { let s = 0; for (const w of nb[v]) s += p[w * 3 + d]; next[v * 3 + d] = p[v * 3 + d] + lam * (s / nb[v].length - p[v * 3 + d]); } }
    p.set(next); report.smoothed = smoothIt;
  }
  const vn = vertexNormals(m);
  // normalen moeten van het weefsel af wijzen (occlusaal); anders omdraaien
  if (frame) { let sdot = 0; for (let v = 0; v < nv; v += 7) sdot += vn[v * 3] * frame.N[0] + vn[v * 3 + 1] * frame.N[1] + vn[v * 3 + 2] * frame.N[2]; if (sdot < 0) for (let i = 0; i < vn.length; i++) vn[i] = -vn[i]; }
  // gewicht per punt, zacht uitlopend over 2 ringen
  const amount = new Float32Array(nv);
  const papilla = zoneInfo.papilla;
  for (let v = 0; v < nv; v++) {
    if (vz[v] === ZONE.relief && doRelief) {
      const nearPap = papilla && Math.hypot(p[v * 3] - papilla[0], p[v * 3 + 1] - papilla[1], p[v * 3 + 2] - papilla[2]) < 7;
      amount[v] = nearPap ? reliefPapilla : relief;
    } else if (vz[v] === ZONE.seal && doPostDam && postDam > 0 && frame?.jaw === 'upper') amount[v] = -postDam;
  }
  for (let it = 0; it < 2; it++) { const a = amount.slice(); for (let v = 0; v < nv; v++) { if (a[v]) continue; let s = 0, c = 0; for (const w of nb[v]) if (a[w]) { s += a[w]; c++; } if (c) amount[v] = s / nb[v].length * 0.6; } }
  for (let v = 0; v < nv; v++) if (amount[v] && !boundary[v]) { for (let d = 0; d < 3; d++) p[v * 3 + d] += vn[v * 3 + d] * amount[v]; if (amount[v] > 0) report.relieved++; else report.postDam++; }
  return { soup: toSoup(m), report };
}

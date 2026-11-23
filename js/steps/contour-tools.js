// Stappen Lepel / Beetplaat / Basis — de plaatomtrek bewerken met vinger of muis (interface).
// Rekenkern: ../contour-edit.js. Twee standen:
//  - Gewoon (draaien): pak de lijn op élke plek en trek hem weg. Buren binnen de meeneemzone gaan zacht mee; de zone
//    licht geel op als je met de muis boven de lijn komt of sleept.
//  - ✏️ Tekenen: trek de lijn in één beweging. Begin je óp de bestaande lijn en eindig je er weer op, dan wordt dat
//    stuk vervangen (overtekenen). Een hele rondgang vervangt de omtrek; tikken zet losse punten. Twee vingers of de
//    rechtermuisknop draaien het beeld, knijpen of scrollen zoomt (naar de vingers/muis toe).
// Op een aanraakscherm verschijnt boven de vinger een vergrootglas, zodat je ziet wat je onder je vinger doet.
import * as THREE from 'three';
import { makeFatLine, makeRoundDots } from '../viewer.js';
import { cleanStroke, spliceClosed, extendOpen, nearestOnPath, dragPoints, arcWeights, densify, smooth, isLoop, pointAt, pathLength } from '../contour-edit.js';

const C = { line: 0xffffff, halo: 0x0a2230, zone: 0xffd43b, pen: 0xff5fd2, attach: 0xffd43b };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ---------- vergrootglas ----------
function createLoupe(viewer) {
  const host = viewer.canvas.parentElement, el = document.createElement('canvas');
  el.className = 'loupe hide'; el.setAttribute('aria-hidden', 'true'); host.appendChild(el);
  const g = el.getContext('2d'), SIZE = 136, ZOOM = 2.2, LIFT = 112;
  let at = null;
  function place() {
    const r = viewer.canvas.getBoundingClientRect(), half = SIZE / 2;
    let x = at[0], y = at[1] - LIFT;
    if (y - half < 4) y = at[1] + LIFT;                     // te dicht bij de bovenrand: onder de vinger
    x = Math.max(half + 4, Math.min(r.width - half - 4, x));
    el.style.left = `${x - half}px`; el.style.top = `${y - half}px`;
  }
  function paint() {
    const src = viewer.canvas, dpr = src.width / Math.max(1, src.getBoundingClientRect().width), W = Math.round(SIZE * dpr);
    if (el.width !== W) { el.width = el.height = W; }
    const sw = W / ZOOM, cx = at[0] * dpr, cy = at[1] * dpr;
    let sx = cx - sw / 2, sy = cy - sw / 2, dx = 0, dy = 0, w = sw, h = sw;
    if (sx < 0) { dx = -sx * ZOOM; w += sx; sx = 0; } if (sy < 0) { dy = -sy * ZOOM; h += sy; sy = 0; }
    w = Math.min(w, src.width - sx); h = Math.min(h, src.height - sy);
    g.save(); g.clearRect(0, 0, W, W); g.beginPath(); g.arc(W / 2, W / 2, W / 2, 0, Math.PI * 2); g.clip();
    g.fillStyle = '#0d1a26'; g.fillRect(0, 0, W, W);
    if (w > 0 && h > 0) g.drawImage(src, sx, sy, w, h, dx, dy, w * ZOOM, h * ZOOM);
    const m = W / 2, a = 7 * dpr, b = 18 * dpr; g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineWidth = 1.5 * dpr; g.beginPath();
    g.moveTo(m - b, m); g.lineTo(m - a, m); g.moveTo(m + a, m); g.lineTo(m + b, m); g.moveTo(m, m - b); g.lineTo(m, m - a); g.moveTo(m, m + a); g.lineTo(m, m + b); g.stroke();
    g.restore();
  }
  viewer.addEventListener('rendered', () => { if (at) paint(); }); // direct na het tekenen: de beeldbuffer is dan nog geldig
  return {
    show(x, y) { at = [x, y]; place(); el.classList.remove('hide'); viewer.render(); },
    hide() { if (!at) return; at = null; el.classList.add('hide'); },
  };
}

export function initContourTools(ctx) {
  const { S, viewer, $, num, status, CONTOUR_KINDS } = ctx;
  const canvas = viewer.canvas, loupe = createLoupe(viewer), down = new Set();
  let act = null, hover = null, queued = false;
  const kindNow = () => (S.scan && CONTOUR_KINDS.includes(S.step) && ['orbit', 'contour'].includes(S.mode)) ? S.step : null;
  const local = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const touchy = e => e.pointerType === 'touch' || e.pointerType === 'pen';
  const tol = e => touchy(e) ? 24 : 12;
  const redraw = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; ctx.refreshOverlay(); }); };
  const project = p => ctx.snapToScan(p);
  const soft = () => Math.max(0, Math.min(15, num('contourSoft') || 0));

  // de lijn op het scherm (alleen segmenten vóór de camera tellen mee)
  function nearLine(s, e, factor = 1) {
    if (!s?.points.length) return null;
    const pr = viewer.projector(), P = s.points.map(p => pr(p[0], p[1], p[2])), q = local(e);
    const hit = nearestOnPath(P, q, { closed: s.closed, dims: 2, valid: i => P[i][2] > 0 && P[(i + 1) % P.length][2] > 0 });
    return hit && hit.d <= tol(e) * factor ? hit : null;
  }

  // ---------- slepen (gewone stand) ----------
  function startPull(e, kind, s, hit) {
    S.contours.snap(kind);
    const n = s.points.length, i = Math.floor(hit.u) % n, t = hit.u - Math.floor(hit.u);
    let u = t < 1e-6 ? i : t > 1 - 1e-6 ? (i + 1) % n : -1;
    if (u < 0) { // tussen twee punten gepakt: bestaand punt als het dichtbij ligt, anders hier een punt invoegen
      const g = project(pointAt(s.points, hit.u)), a = s.points[i], b = s.points[(i + 1) % n];
      if (dist(g, a) < 0.5) u = i; else if (dist(g, b) < 0.5) u = (i + 1) % n; else { s.points.splice(i + 1, 0, g); u = i + 1; }
    }
    act = { type: 'pull', id: e.pointerId, kind, orig: s.points.map(p => p.slice()), u, start: s.points[u].slice(), x0: e.clientX, y0: e.clientY, moved: false, touch: touchy(e), weights: arcWeights(s.points, u, soft()) };
    viewer.controls.enabled = false;
    canvas.setPointerCapture?.(e.pointerId);
    canvas.style.cursor = 'grabbing';
    redraw();
  }
  function movePull(e) {
    if (act.touch) loupe.show(...local(e));
    if (!act.moved && Math.hypot(e.clientX - act.x0, e.clientY - act.y0) < 4) return;
    act.moved = true;
    const hit = viewer.pick(e.clientX, e.clientY);
    if (!hit) return;
    const p = hit.point.toArray(), d = [p[0] - act.start[0], p[1] - act.start[1], p[2] - act.start[2]];
    const r = dragPoints(act.orig, act.u, d, soft(), { closed: true, project });
    const s = S.contours.get(act.kind); s.points = r.points; act.weights = r.weights;
    S.contours.invalidate(act.kind);
    redraw();
  }
  function endPull(cancel = false) {
    const a = act; act = null; viewer.controls.enabled = true; loupe.hide(); canvas.style.cursor = '';
    if (!a.moved || cancel) {
      S.contours.undo(a.kind); S.contours.redo.set(a.kind, []); ctx.refreshOverlay();
      if (!cancel) status('Sleep de lijn met je vinger of de muis om hem te verplaatsen (meeneemzone ' + String(soft()).replace('.', ',') + ' mm).');
      return;
    }
    const s = S.contours.get(a.kind);
    s.points = densify(s.points, 2.5, { closed: true, project }); // uitgerekte stukken weer fijn genoeg
    ctx.finishContourEdit(a.kind, 'Omtrek aangepast. ↶ Terug zet het terug.');
  }

  // ---------- tekenen ----------
  function startPen(e, kind) {
    const s = S.contours.get(kind), hit = viewer.pick(e.clientX, e.clientY);
    act = { type: 'pen', id: e.pointerId, kind, raw: hit ? [hit.point.toArray()] : [], scr: [local(e)], t0: performance.now(), path: 0, touch: touchy(e), startNear: s?.closed ? nearLine(s, e) : null };
    if (act.touch) loupe.show(...local(e));
  }
  function movePen(e) {
    const q = local(e), last = act.scr[act.scr.length - 1], dd = Math.hypot(q[0] - last[0], q[1] - last[1]);
    if (act.touch) loupe.show(...q);
    if (dd < 2.5) return;
    act.path += dd; act.scr.push(q);
    const hit = viewer.pick(e.clientX, e.clientY);
    if (hit) act.raw.push(hit.point.toArray());
    redraw();
  }
  function endPen(e, cancel = false) {
    const a = act; act = null; loupe.hide();
    if (cancel) { redraw(); return; }
    if (a.path < 8 && performance.now() - a.t0 < 650) { penTap(e, a.kind); return; }
    try { finishStroke(a, e); } catch (err) { ctx.contourError(err.message); redraw(); }
  }
  function penTap(e, kind) {
    const s = S.contours.get(kind);
    if (s?.closed) { status('De omtrek is gesloten. Teken óver de lijn om een stuk te vervangen, of tik ✓ Klaar en sleep de lijn.'); return; }
    if (s?.points.length >= 3) {
      const pr = viewer.projector(), [px, py] = pr(...s.points[0]), q = local(e);
      if (Math.hypot(px - q[0], py - q[1]) <= tol(e) + 4) return closeOpen(kind);
    }
    const hit = viewer.pick(e.clientX, e.clientY);
    if (!hit) return ctx.contourError('Tik op het zichtbare scanoppervlak.');
    try { S.contours.addPoint(kind, hit.point.toArray()); } catch (err) { return ctx.contourError(err.message); }
    ctx.updateContourUI(); ctx.refreshOverlay();
  }
  function closeOpen(kind, msg = 'Omtrek gesloten.') {
    try { ctx.closeContourFromAbove(kind); } catch (err) { ctx.contourError(err.message); return false; }
    ctx.dropPlate(kind); ctx.setMode('orbit');
    ctx.updateContourUI(); ctx.refreshScanColors(); ctx.refreshOverlay();
    status(msg + ' Sleep de lijn om hem bij te stellen, of kies ✏️ Teken om een stuk over te tekenen.');
    return true;
  }
  function finishStroke(a, e) {
    const kind = a.kind, stroke = cleanStroke(a.raw, { spacing: 1.25, project });
    if (stroke.length < 3 || pathLength(stroke) < 2) { status('Teken op het scanoppervlak (de lijn moet over de scan lopen).', true); redraw(); return; }
    const s = S.contours.get(kind), axis = s?.axis ?? ctx.contourAxis();
    const scrGap = Math.hypot(a.scr[0][0] - a.scr.at(-1)[0], a.scr[0][1] - a.scr.at(-1)[1]);
    const loop = isLoop(stroke, { gap: 5 }) || (scrGap <= tol(e) * 1.4 && pathLength(stroke) >= 20);
    // 1. nog geen omtrek (of een hele nieuwe rondgang over een bestaande): de streek wordt de omtrek
    if (!s?.points.length || (s.closed && !a.startNear && loop)) {
      if (loop) {
        const pts = stroke.slice(0, stroke.length - (dist(stroke[0], stroke.at(-1)) < 1 ? 1 : 0));
        try { S.contours.setPoints(kind, pts, axis); }
        catch (err) { S.contours.undo(kind); S.contours.redo.set(kind, []); ctx.contourError(err.message + ' Probeer het opnieuw.'); ctx.refreshOverlay(); return; }
        ctx.setMode('orbit');
        ctx.finishContourEdit(kind, `Nieuwe omtrek getekend (${stroke.length} punten). Sleep de lijn om hem bij te stellen.`);
        return;
      }
      if (s?.closed) { ctx.contourError('Begin op de lijn om een stuk over te tekenen, of teken een hele rondgang (eindig bij je beginpunt) voor een nieuwe omtrek.'); redraw(); return; }
      S.contours.setOpen(kind, stroke);
      ctx.updateContourUI(); ctx.refreshOverlay();
      status('Lijn getekend. Teken verder, en eindig bij het begin (of tik op het witte beginpunt) om de omtrek te sluiten.');
      return;
    }
    // 2. open omtrek: verder tekenen; eindigt de streek bij het begin, dan sluiten
    if (!s.closed) {
      const pts = extendOpen(s.points, stroke), first = pts[0], pr = viewer.projector(), f = pr(...first), q = a.scr.at(-1);
      S.contours.setOpen(kind, pts);
      if (pts.length >= 3 && (dist(pts.at(-1), first) <= 4 || Math.hypot(f[0] - q[0], f[1] - q[1]) <= tol(e) * 1.4)) {
        if (dist(pts.at(-1), first) < 1) s.points.pop();
        if (!closeOpen(kind, 'Omtrek getekend en gesloten.')) { S.contours.undo(kind); S.contours.redo.set(kind, []); ctx.refreshOverlay(); }
        return;
      }
      ctx.updateContourUI(); ctx.refreshOverlay();
      return;
    }
    // 3. gesloten omtrek: overtekenen (begin op de lijn, eindig weer op de lijn)
    if (!a.startNear) { ctx.contourError('Begin op de lijn om een stuk over te tekenen, of teken een hele rondgang voor een nieuwe omtrek.'); redraw(); return; }
    let endHit = nearLine(s, e, 2.5);
    const u1 = endHit ? endHit.u : (() => { const h = nearestOnPath(s.points, stroke.at(-1), { closed: true }); return h && h.d <= 5 ? h.u : null; })();
    if (u1 == null) { ctx.contourError('Eindig weer óp de lijn: het stuk tussen begin en eind wordt dan vervangen door wat je tekende.'); redraw(); return; }
    const r = spliceClosed(s.points, stroke, a.startNear.u, u1);
    try { S.contours.setPoints(kind, r.points, axis); }
    catch (err) { S.contours.undo(kind); S.contours.redo.set(kind, []); ctx.contourError(err.message + ' Er is niets veranderd.'); ctx.refreshOverlay(); return; }
    ctx.finishContourEdit(kind, `Stuk van ${Math.round(r.replacedLength)} mm overgetekend. ↶ Terug zet het terug.`);
  }

  // ---------- aanwijzer ----------
  canvas.addEventListener('pointerdown', e => {
    if (e.isPrimary && !act) down.clear(); // eerste vinger/muisklik: er is verder niets ingedrukt (geen achtergebleven aanwijzers)
    down.add(e.pointerId);
    if (act) { // tweede vinger: handeling afbreken, het beeld mag draaien/zoomen
      if (down.size > 1) { if (act.type === 'pull') endPull(true); else endPen(e, true); }
      return;
    }
    const kind = kindNow(); if (!kind || down.size > 1 || e.button > 0) return;
    const s = S.contours.get(kind);
    if (S.mode === 'contour') { startPen(e, kind); return; } // OrbitControls volgt de aanwijzer (voor twee vingers), maar doet niets met één
    if (s?.closed) {
      const hit = nearLine(s, e);
      if (hit) { e.stopImmediatePropagation(); e.preventDefault(); startPull(e, kind, s, hit); }
    }
  }, { capture: true });
  canvas.addEventListener('pointermove', e => {
    if (act && e.pointerId === act.id) {
      if (act.type === 'pull') { e.stopImmediatePropagation(); movePull(e); } else movePen(e);
      return;
    }
    if (e.pointerType !== 'mouse' || e.buttons) { if (hover) { hover = null; redraw(); } return; }
    // muis zweeft: in de gewone stand de meeneemzone tonen, bij tekenen het aanhechtpunt
    const kind = kindNow(), s = kind && S.contours.get(kind);
    const h = s?.closed ? nearLine(s, e) : null;
    const next = h ? { kind, u: h.u, pen: S.mode === 'contour' } : null;
    if (!S.mode || S.mode === 'orbit') canvas.style.cursor = next ? 'grab' : '';
    if (JSON.stringify(next) !== JSON.stringify(hover)) { hover = next; redraw(); }
  }, { capture: true });
  const up = e => {
    down.delete(e.pointerId);
    if (!act || e.pointerId !== act.id) return;
    if (act.type === 'pull') { e.stopImmediatePropagation(); endPull(e.type === 'pointercancel'); }
    else endPen(e, e.type === 'pointercancel');
  };
  canvas.addEventListener('pointerup', up, { capture: true });
  canvas.addEventListener('pointercancel', up, { capture: true });
  addEventListener('pointerup', e => down.delete(e.pointerId), true);
  addEventListener('pointercancel', e => down.delete(e.pointerId), true);
  canvas.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && hover && !act) { hover = null; redraw(); } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && act) { if (act.type === 'pull') endPull(true); else endPen(e, true); e.stopImmediatePropagation(); } }, { capture: true });

  // ---------- weergave ----------
  // gladde lijn door de punten (centripetale Catmull-Rom), op de scan gelegd: zo ziet de lijn eruit zoals hij snijdt
  function curve(pts, closed, k = 3) {
    const n = pts.length, out = [];
    if (n < 3) return pts.map(p => p.slice());
    const segs = closed ? n : n - 1, P = i => pts[closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i))];
    for (let i = 0; i < segs; i++) {
      const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
      const d = (a, b) => Math.sqrt(dist(a, b)) || 1e-4, t1 = d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
      for (let j = 0; j < k; j++) {
        const t = t1 + (t2 - t1) * j / k, L = (a, b, ta, tb) => [0, 1, 2].map(c => ((tb - t) * a[c] + (t - ta) * b[c]) / (tb - ta || 1));
        const A1 = L(p0, p1, 0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3), B1 = L(A1, A2, 0, t2), B2 = L(A2, A3, t1, t3);
        out.push(j === 0 ? p1.slice() : project(L(B1, B2, t1, t2)));
      }
    }
    if (!closed) out.push(pts[n - 1].slice());
    return out;
  }
  // lijn met donkere rand; 'top' = altijd zichtbaar (actieve dingen), anders verborgen achter de scan met een vage schim
  function addLine(g, pts, color, width, closed, { top = false } = {}) {
    const halo = makeFatLine(pts, C.halo, { width: width + 3, closed, opacity: 0.85, bias: 2, depthTest: !top, renderOrder: top ? 13 : 10 });
    const core = makeFatLine(pts, color, { width, closed, bias: 3, depthTest: !top, renderOrder: top ? 14 : 11 });
    if (halo) g.add(halo); if (core) g.add(core);
    if (!top) { const gh = makeFatLine(pts, color, { width: Math.max(1.5, width - 1), closed, opacity: 0.3, depthTest: false, renderOrder: 9 }); if (gh) g.add(gh); }
  }
  function draw(g) {
    const kind = kindNow(); if (!kind) return;
    const s = S.contours.get(kind), coarse = S.coarsePointer, W = coarse ? 4 : 3;
    if (s?.points.length) {
      const pts = s.points;
      if (pts.length > 1) addLine(g, curve(pts, s.closed), C.line, W, s.closed);
      // stippen: niet dichter dan ~16 px op het scherm (alleen ter oriëntatie; de lijn is overal te pakken)
      const pr = viewer.projector(), shown = [];
      let last = null;
      for (const p of pts) { const q = pr(p[0], p[1], p[2]); if (q[2] <= 0) continue; if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) >= (coarse ? 22 : 16)) { shown.push(p); last = q; } }
      const dots = makeRoundDots(shown, 0xffffff, coarse ? 8 : 6, { opacity: 0.95, depthTest: true }); if (dots) g.add(dots);
      if (!s.closed) { const f = makeRoundDots([pts[0]], 0xffffff, coarse ? 20 : 15); if (f) g.add(f); }
      // meeneemzone: tijdens slepen of als de muis boven de lijn zweeft
      let w = null, grab = null;
      if (act?.type === 'pull' && act.kind === kind) { w = act.weights; grab = s.points[act.u]; }
      else if (hover && !hover.pen && hover.kind === kind && s.closed) { w = arcWeights(pts, hover.u, soft()); grab = pointAt(pts, hover.u); }
      if (w) {
        const zone = [], n = pts.length, i0 = act?.type === 'pull' ? act.u : Math.round(hover.u) % n;
        let a = i0, b = i0;
        while (w[(a - 1 + n) % n] > 0.01 && (i0 - a) < n - 1) a--;
        while (w[(b + 1) % n] > 0.01 && (b - i0) < n - 1) b++;
        for (let k = a; k <= b; k++) zone.push(pts[((k % n) + n) % n]);
        if (zone.length > 1) addLine(g, zone, C.zone, W + 2, false, { top: true });
        const gd = makeRoundDots([grab], C.zone, coarse ? 18 : 13); if (gd) g.add(gd);
      }
      if (hover?.pen && hover.kind === kind && s.closed) { const ad = makeRoundDots([pointAt(pts, hover.u)], C.attach, 14); if (ad) g.add(ad); }
      if (act?.type === 'pen' && act.startNear && act.kind === kind && s.closed) { const ad = makeRoundDots([pointAt(pts, act.startNear.u)], C.attach, coarse ? 18 : 14); if (ad) g.add(ad); }
    }
    if (act?.type === 'pen' && act.kind === kind && act.raw.length > 1) addLine(g, act.raw, C.pen, W, false, { top: true });
  }

  // ---------- stand wisselen: bij tekenen tekent één vinger/linkerknop, draaien met twee vingers/rechterknop ----------
  function onMode(mode) {
    const c = viewer.controls, pen = mode === 'contour';
    c.mouseButtons = pen ? { LEFT: -1, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE } : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    c.touches = pen ? { ONE: -1, TWO: THREE.TOUCH.DOLLY_ROTATE } : { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    if (!pen && act?.type === 'pen') { act = null; loupe.hide(); }
    hover = null; canvas.style.cursor = '';
  }

  // ---------- gladstrijken ----------
  function smoothAll() {
    const kind = kindNow(), s = kind && S.contours.get(kind);
    if (!s?.closed) return ctx.contourError('Sluit eerst de omtrek (of kies 🧭 Automatisch).');
    S.contours.snap(kind);
    s.points = smooth(s.points, { closed: true, iterations: 3, weight: 0.5, project });
    ctx.finishContourEdit(kind, 'Omtrek gladgestreken. Nog eens tikken = gladder; ↶ Terug zet het terug.');
  }

  return { draw, onMode, smoothAll, busy: () => !!act };
}

// v71: taalkeuze Nederlands / English / Deutsch.
// De programmatekst is Nederlands (bron). Deze module vertaalt alles wat op het scherm komt: tekst in de pagina,
// title/placeholder/aria-label, het venstertitel en alert/confirm/prompt, met het woordenboek in i18n-data.js.
// Een MutationObserver vertaalt nieuwe en gewijzigde tekst meteen (vóór het tekenen, dus zonder flits). Per tekstknoop
// wordt de Nederlandse bron bewaard, zodat wisselen van taal zonder herladen kan (het project blijft staan).
// Dynamische meldingen met getallen of namen worden herkend via sjablonen ({0}, {1}); samengestelde meldingen per deel
// (gescheiden door ' · ', '; ', zinnen). Getallen staan in de bron in Nederlandse notatie (12,5); in het Engels wordt
// dat 12.5. Zonder vertaling blijft de Nederlandse tekst staan (en komt die in window.ddcadI18nMissing, om aan te vullen).
import DATA from './i18n-data.js';

export const LANGS = [['nl', 'Nederlands', 'NL'], ['en', 'English', 'EN'], ['de', 'Deutsch', 'DE']];
const KEY = 'ddcad.lang', CODES = LANGS.map(l => l[0]);
const IDX = { en: 0, de: 1 };

function initial() {
  try { const s = localStorage.getItem(KEY); if (CODES.includes(s)) return s; } catch { /* privémodus */ }
  if (typeof window !== 'undefined' && CODES.includes(window.ddcadBootLang)) return window.ddcadBootLang;
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  for (const l of nav.languages ?? [nav.language ?? 'nl']) { const c = String(l).slice(0, 2).toLowerCase(); if (CODES.includes(c)) return c; }
  return 'en';
}
let lang = initial();
export const getLang = () => lang;
export const locale = () => ({ nl: 'nl-NL', en: 'en-GB', de: 'de-DE' })[lang];

// ---- woordenboek ----
const exact = new Map(), templates = [];
const norm = s => s.replace(/\s+/g, ' ').trim();
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const addKey = (key, v) => {
  if (!/\{\d+\}/.test(key)) { if (!exact.has(key)) exact.set(key, v); return; }
  const lits = key.split(/\{\d+\}/), order = [...key.matchAll(/\{(\d+)\}/g)].map(m => +m[1]);
  const re = new RegExp('^' + lits.map(esc).join('(.*?)') + '$');
  const lit = lits.reduce((a, b) => (b.length > a.length ? b : a), '');
  templates.push({ re, lits, order, lit, len: lits.join('').length, out: v });
};
for (const [k, v] of Object.entries(DATA)) {
  const key = norm(k);
  addKey(key, v);
  // ook zonder slotpunt/dubbele punt (een melding staat soms midden in een langere zin of vóór een <span>)
  const m = /^(.*[^.:])[.:]$/s.exec(key);
  if (m && /[A-Za-zÀ-ÿ]{3}/.test(m[1].replace(/\{\d+\}/g, ''))) addKey(m[1], v.map(x => x.replace(/[.:]$/, '')));
}
templates.sort((a, b) => b.len - a.len);
// Een sjabloon met meer invulplekken kan op meer manieren passen ('{0}de {1} loopt'): eerst kort (lui), en als een
// ingevuld deel dan niet te vertalen is, de andere verdelingen (lang/kort per plek) proberen.
function alts(t) {
  if (t.alts) return t.alts;
  const k = t.order.length, out = [];
  if (k >= 2 && k <= 4) for (let mask = 1; mask < (1 << k); mask++) out.push(new RegExp('^' + t.lits.map(esc).reduce((a, b, i) => a + (mask & (1 << (i - 1)) ? '(.*)' : '(.*?)') + b) + '$'));
  return (t.alts = out);
}

const upperFirst = s => s ? s[0].toUpperCase() + s.slice(1) : s;
// Nederlandse getalnotatie → Engelse (1.234,5 → 1,234.5); alleen in het Engels
const NUM = /\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+,\d+/g;
const convNum = (s, l) => l === 'en' ? s.replace(NUM, m => m.replace(/\./g, '\u0001').replace(/,/g, '.').replace(/\u0001/g, ',')) : s;
const LETTERS = /[A-Za-zÀ-ÿ]{2}/;

const cache = { en: new Map(), de: new Map() };
const missing = new Set();
if (typeof window !== 'undefined') window.ddcadI18nMissing = missing;

function inner(v, l, depth) { // vertaling van een ingevuld deel van een sjabloon
  if (!LETTERS.test(v)) return convNum(v, l);
  const r = core(norm(v), l, depth);
  if (r == null) { if (missing.size < 3000 && /[a-zà-ÿ]{3}/.test(v)) missing.add('⟨' + norm(v) + '⟩'); return convNum(v, l); }
  const m = /^(\s*)[\s\S]*?(\s*)$/.exec(v); return m[1] + r + m[2];
}
function fillTemplate(t, s, l, depth) {
  const m = t.re.exec(s); if (!m) return null;
  // meervoudsuitgang direct na een woord ('rand{1}' → 'en') niet vertalen maar weglaten: de vertaling schrijft '(s)'
  const fill = mm => { const vals = []; t.order.forEach((n, k) => { const v = mm[k + 1]; vals[n] = /[a-zà-ÿ]$/i.test(t.lits[k]) && /^[a-z]{0,4}$/.test(v) ? '' : inner(v, l, depth + 1); }); return t.out[IDX[l]].replace(/\{(\d+)\}/g, (_, n) => vals[+n] ?? ''); };
  if (t.order.length < 2) return fill(m);
  const good = mm => mm.slice(1).every(v => !LETTERS.test(v) || core(norm(v), l, depth + 1) != null);
  if (good(m)) return fill(m);
  for (const re of alts(t)) { const mm = re.exec(s); if (mm && good(mm)) return fill(mm); }
  return fill(m);
}
// strict: alleen een volledige vertaling telt (een deel na ': ' of ', ' mag niet half vertaald terugkomen)
function core(s, l, depth, noSplit = false, strict = false) {
  if (!s) return s;
  const i = IDX[l];
  let e = exact.get(s); if (e) return e[i];
  if (depth > 4) return null;
  // eerste letter in de bron soms hoofdletter gemaakt (zin begint met een losse notitie)
  const lc = s[0].toLowerCase() + s.slice(1);
  if (lc !== s && (e = exact.get(lc))) return upperFirst(e[i]);
  for (const t of templates) {
    if (t.lit && !s.includes(t.lit)) continue;
    const r = fillTemplate(t, s, l, depth); if (r != null) return r;
  }
  if (lc !== s) for (const t of templates) {
    if (t.lit && !lc.includes(t.lit)) continue;
    const r = fillTemplate(t, lc, l, depth); if (r != null) return upperFirst(r);
  }
  // samengesteld: per deel (bij komma's alleen als elk deel bekend is: anders liever de zin heel laten)
  for (const sep of [' · ', ' — ', ' – ', '; ', ' → ', ', ', ': ']) {
    if (!s.includes(sep)) continue;
    let any = false, all = true;
    const st = strict || sep === ', ' || sep === ': ';
    const parts = s.split(sep).map(p => { const r = LETTERS.test(p) ? core(norm(p), l, depth + 1, false, st) : null; if (r != null) { any = true; return r; } if (LETTERS.test(p)) all = false; return convNum(p, l); });
    if (st ? any && all : any) return parts.join(sep);
  }
  // tussen haakjes: de inhoud vertalen
  if (s.length > 2 && s[0] === '(' && s[s.length - 1] === ')') { const r = core(s.slice(1, -1), l, depth + 1); if (r != null) return '(' + r + ')'; }
  // zinnen (zonder lookbehind: oudere Safari kent dat niet). Steeds de langste reeks opeenvolgende zinnen die als
  // geheel bekend is: een melding van twee zinnen + een aangeplakte zin ('De wijziging is teruggedraaid.') blijft zo
  // helemaal vertaald.
  if (!noSplit) {
    const bits = s.split(/([.!?:)])\s+(?=[A-Z0-9(“"'‘↶✓⚠✏🧭〰])/u), sent = [];
    for (let k = 0; k < bits.length; k += 2) sent.push(bits[k] + (bits[k + 1] ?? ''));
    if (sent.length > 1) {
      let any = false; const out = [];
      for (let i = 0; i < sent.length;) {
        let hit = null, jj = i + 1;
        for (let j = sent.length - (i === 0 ? 1 : 0); j > i; j--) { const r = core(sent.slice(i, j).join(' '), l, depth + 1, true, strict); if (r != null) { hit = r; jj = j; break; } }
        if (hit != null) { out.push(hit); any = true; } else { if (strict) return null; out.push(convNum(sent[i], l)); }
        i = jj;
      }
      if (any) return out.join(' ');
    }
  }
  // tekens ervoor (emoji, pijlen, ·, ⚠, ✓) en leestekens erna los laten: eerst alleen voor, dan alleen na, dan beide
  const lead = /^[^A-Za-zÀ-ÿ0-9{(“"'‘]+/u.exec(s)?.[0] ?? '', trail = /[\s.,:;!?…·→✓⚠↓↑]+$/u.exec(s)?.[0] ?? '';
  const tries = [];
  if (lead) tries.push([lead, s.slice(lead.length), '']);
  if (trail && trail.length < s.length) tries.push(['', s.slice(0, s.length - trail.length), trail]);
  if (lead && trail && lead.length + trail.length < s.length) tries.push([lead, s.slice(lead.length, s.length - trail.length), trail]);
  for (const [a, mid, b] of tries) { if (!LETTERS.test(mid)) continue; const r = core(mid, l, depth + 1, false, strict); if (r != null) return a + r + convNum(b, l); }
  return null;
}

/** Vertaal een (Nederlandse) tekst naar de gekozen taal; onbekend → ongewijzigd. */
export function tr(text, l = lang) {
  if (l === 'nl' || text == null) return text;
  const s = String(text);
  if (s.includes('\n')) return s.split('\n').map(x => tr(x, l)).join('\n'); // regels apart (pre-line)
  if (!LETTERS.test(s)) return convNum(s, l);
  const c = cache[l]; let r = c.get(s);
  if (r !== undefined) return r;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s), body = norm(m[2]);
  let out = core(body, l, 0);
  if (out == null) {
    // alleen getallen en eenheden (bijv. '12,5 mm'): getalnotatie aanpassen
    if (!/[A-Za-zÀ-ÿ]{3,}/.test(body.replace(/mm[²³]?|°/g, ''))) out = convNum(body, l);
    else { if (missing.size < 3000) missing.add(body); out = body; }
  }
  r = m[1] + out + m[3];
  if (c.size > 5000) c.clear();
  c.set(s, r);
  return r;
}
/** Sjabloon met waarden: t('Element {0} geselecteerd', 36). */
export const t = (s, ...a) => tr(a.length ? s.replace(/\{(\d+)\}/g, (_, n) => a[+n] ?? '') : s);

// ---- pagina ----
const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
const TXT = new WeakMap(), ATT = new WeakMap();
const SKIP = 'script,style,noscript,textarea,code,kbd,[translate="no"],.notranslate,[contenteditable="true"]';
const skipEl = el => !!el?.closest?.(SKIP);
function doText(n) {
  const cur = n.data; let r = TXT.get(n);
  if (!r || cur !== r.out) { r = { src: cur, out: cur }; TXT.set(n, r); }
  if (!LETTERS.test(r.src)) { if (lang === 'en' && /\d,\d/.test(r.src)) { const o = convNum(r.src, lang); if (o !== cur) { r.out = o; n.data = o; } } return; }
  const out = tr(r.src);
  r.out = out; if (out !== cur) n.data = out;
}
function doAttr(el, a) {
  const cur = el.getAttribute(a); if (cur == null) return;
  let m = ATT.get(el); if (!m) ATT.set(el, m = {});
  let r = m[a];
  if (!r || cur !== r.out) r = m[a] = { src: cur, out: cur };
  const out = tr(r.src); r.out = out; if (out !== cur) el.setAttribute(a, out);
}
function walk(node) {
  if (node.nodeType === 3) { if (!skipEl(node.parentElement)) doText(node); return; }
  if (node.nodeType !== 1 || skipEl(node)) return;
  for (const a of ATTRS) if (node.hasAttribute(a)) doAttr(node, a);
  const it = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, { acceptNode: n => n.nodeType === 1 && n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  for (let n = it.nextNode(); n; n = it.nextNode()) {
    if (n.nodeType === 3) doText(n);
    else for (const a of ATTRS) if (n.hasAttribute(a)) doAttr(n, a);
  }
}
let titleSrc = null;
function doTitle() {
  if (titleSrc == null || (document.title !== titleOut)) titleSrc = document.title;
  titleOut = tr(titleSrc); if (document.title !== titleOut) document.title = titleOut;
}
let titleOut = null;

const obs = typeof MutationObserver === 'undefined' ? null : new MutationObserver(list => {
  for (const m of list) {
    if (m.type === 'characterData') { if (!skipEl(m.target.parentElement)) doText(m.target); }
    else if (m.type === 'childList') { for (const n of m.addedNodes) walk(n); }
    else if (m.type === 'attributes' && !skipEl(m.target)) doAttr(m.target, m.attributeName);
  }
});

// dialoogvensters
if (typeof window !== 'undefined') for (const k of ['alert', 'confirm', 'prompt']) {
  const f = window[k]; if (typeof f !== 'function') continue;
  window[k] = function (msg, ...rest) { return f.call(window, tr(msg), ...rest); };
}

// ---- taalkeuze rechtsboven ----
function picker() {
  const host = document.querySelector('header .header-actions');
  if (!host || host.querySelector('.langpick')) return;
  const box = document.createElement('div'); box.className = 'langpick'; box.setAttribute('translate', 'no');
  const btn = document.createElement('button'); btn.type = 'button'; btn.id = 'langBtn'; btn.setAttribute('aria-haspopup', 'menu'); btn.setAttribute('aria-expanded', 'false');
  btn.title = 'Taal · Language · Sprache';
  const menu = document.createElement('div'); menu.className = 'langmenu'; menu.setAttribute('role', 'menu'); menu.hidden = true;
  for (const [code, name, short] of LANGS) {
    const it = document.createElement('button'); it.type = 'button'; it.setAttribute('role', 'menuitemradio'); it.dataset.lang = code;
    it.innerHTML = `<b>${short}</b> ${name}`;
    it.addEventListener('click', () => { setLang(code); close(); });
    menu.append(it);
  }
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', e => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden)); });
  document.addEventListener('click', e => { if (!box.contains(e.target)) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  box.append(btn, menu); host.append(box);
  refreshPicker();
}
function refreshPicker() {
  const btn = document.getElementById('langBtn'); if (!btn) return;
  btn.textContent = '🌐 ' + LANGS.find(l => l[0] === lang)[2];
  for (const it of document.querySelectorAll('.langmenu [data-lang]')) it.setAttribute('aria-checked', String(it.dataset.lang === lang));
}

/** Taal wisselen: alles op de pagina opnieuw vertalen vanuit de Nederlandse bron. */
export function setLang(l) {
  if (!CODES.includes(l)) return;
  lang = l;
  try { localStorage.setItem(KEY, l); } catch { /* privémodus */ }
  document.documentElement.lang = l;
  walk(document.body); doTitle(); refreshPicker();
  window.dispatchEvent(new CustomEvent('ddcad:lang', { detail: l }));
}

// start: meteen vertalen (de pagina is al ingelezen; modules lopen na het inlezen) en daarna alles volgen.
// Zonder pagina (Node-tests) alleen het woordenboek en tr().
if (typeof document !== 'undefined' && document.body) {
  document.documentElement.lang = lang;
  picker();
  walk(document.body); doTitle();
  obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  new MutationObserver(doTitle).observe(document.querySelector('title') ?? document.head, { childList: true, characterData: true, subtree: true });
  document.documentElement.classList.remove('i18n-wait');
}

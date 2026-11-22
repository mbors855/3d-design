// Synthetische tandeloze bovenkaak voor demonstratie en tests.
// Occlusale richting is +Z; de kam is het hoogste deel, het palatum ligt dieper.
export function demoJaw({ step = 0.6 } = {}) {
  const archY = x => 30 - 0.045 * x * x;           // kamlijn (parabool)
  const distToArch = (x, y) => {
    let best = Infinity;
    for (let t = -27; t <= 27; t += 0.5) best = Math.min(best, Math.hypot(x - t, y - archY(t)));
    return best;
  };
  const inside = (x, y) => y < archY(x) && y > -4;
  const height = (x, y) => {
    const d = distToArch(x, y);
    const ridge = 7 * Math.exp(-((d / 4.5) ** 2));
    const palate = inside(x, y) ? -5 * (1 - Math.exp(-((d / 7) ** 2))) : -3 * (1 - Math.exp(-((d / 3.5) ** 2)));
    return ridge + palate;
  };
  const xs = [], ys = [];
  for (let x = -40; x <= 40 + 1e-9; x += step) xs.push(+x.toFixed(4));
  for (let y = -4; y <= 42 + 1e-9; y += step) ys.push(+y.toFixed(4));
  const keep = (x, y) => y >= -4 && (inside(x, y) || distToArch(x, y) < 10) && Math.abs(x) < 38;
  const grid = xs.map(x => ys.map(y => keep(x, y) ? [x, y, height(x, y)] : null));
  const out = [];
  for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ys.length - 1; j++) {
    const a = grid[i][j], b = grid[i + 1][j], c = grid[i + 1][j + 1], d = grid[i][j + 1];
    if (a && b && c && d) { out.push(...a, ...b, ...c, ...a, ...c, ...d); }
  }
  return Float32Array.from(out);
}

// Synthetische antagonist (onderkaak-occlusievlak) als vlakke wasblokvorm boven de bovenkaak.
export function demoAntagonist(z = 19) {
  const archY = x => 30 - 0.045 * x * x, out = [];
  const pts = [];
  for (let x = -28; x <= 28; x += 1) pts.push([x, archY(x)]);
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const w = 6;
    const q = (x, y, dx, dy) => { const l = Math.hypot(dx, dy); return [[x - dy / l * w, y + dx / l * w], [x + dy / l * w, y - dx / l * w]]; };
    const [a0, b0] = q(x0, y0, x1 - x0, y1 - y0), [a1, b1] = q(x1, y1, x1 - x0, y1 - y0);
    out.push(a0[0], a0[1], z, a1[0], a1[1], z, b1[0], b1[1], z, a0[0], a0[1], z, b1[0], b1[1], z, b0[0], b0[1], z);
  }
  return Float32Array.from(out);
}

// Anatomische testkaak (hoogteveld, occlusaal = +Z) met vestibulum + omslag, frenula, verhemelte (raphe, papil,
// optioneel torus) of onderkaak (buccal shelf, linguale plooi, tongriem, retromolaire pads).
// Geeft { soup, truth } met de bekende ligging van de structuren (voor tests en uitleg).
export function anatomicJaw({ jaw = 'upper', step = 0.5, torus = false, frena = true } = {}) {
  const upper = jaw === 'upper';
  const y0 = upper ? 32 : 30, k = upper ? 0.05 : 0.04, xEnd = upper ? 24 : 27;   // kamlijn y = y0 - k x², |x| ≤ xEnd
  const archY = x => y0 - k * x * x;
  const sulcusD = upper ? 9 : 8, sulcusDepth = upper ? 9 : 8;                    // afstand en diepte van de buccale plooi
  const frenaT = frena ? (upper ? [0, -0.45, 0.45] : [0, -0.5, 0.5]) : [];        // labiaal midden + buccaal
  // dichtstbijzijnd punt op de kamlijn → signed afstand (+ = buccaal/labiaal), boogpositie t, achter het einde
  const nearest = (x, y) => {
    let best = Infinity, bx = 0;
    for (let t = -xEnd; t <= xEnd; t += 0.25) { const d = Math.hypot(x - t, y - archY(t)); if (d < best) { best = d; bx = t; } }
    const out = y > archY(Math.max(-xEnd, Math.min(xEnd, x))) || Math.abs(x) > xEnd && y > archY(xEnd) ? 1 : -1;
    const beyond = Math.abs(x) > xEnd ? Math.max(0, archY(xEnd) - y) * 0 + Math.max(0, (archY(xEnd) - y)) : 0;
    return { d: best * out, t: bx / xEnd, beyond };
  };
  const sq = v => v * v;
  const smooth = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
  const height = (x, y) => {
    const { d, t } = nearest(x, y);
    let h;
    if (d >= 0) { // buccaal/labiaal: helling naar de plooi, dan omslag (wang/lip)
      h = d <= sulcusD ? -sulcusDepth * smooth(0, sulcusD, d) : -sulcusDepth + 4 * smooth(sulcusD, sulcusD + 5, d);
      let fr = 0; for (const ft of frenaT) fr = Math.max(fr, (sulcusDepth * 0.6) * Math.exp(-sq((t - ft) * xEnd)) * smooth(1, sulcusD, d));
      h = Math.min(h + fr, Math.max(h, -3)); // een frenulum komt nooit boven de kam uit
    } else if (upper) { // verhemelte
      const vault = 13; h = -vault * (1 - Math.exp(-sq(d / 9)));
      h += 0.6 * Math.exp(-sq(x / 1.2)) * smooth(-4, -12, d);                                   // raphe
      h += 1.4 * Math.exp(-sq(x / 2.6) - sq((y - (y0 - 7)) / 2.6));                          // papilla incisiva
      if (torus) h += 4 * Math.exp(-sq(x / 6) - sq((y - 12) / 8));
    } else { // onderkaak lingual: plooi en tongbodem
      const ld = -d; h = ld <= 8 ? -11 * smooth(0, 8, ld) : -11 + 4 * smooth(8, 13, ld);
      h = Math.min(h + 6 * Math.exp(-sq(x / 1.8)) * smooth(1, 8, ld) * (y > y0 - 20 ? 1 : 0), Math.max(h, -3)); // tongriem
    }
    // achter de kamuiteinden: BK tuber + hamulus-insnoering, OK retromolaire pad
    const dx = Math.abs(x) - xEnd;
    if (dx > -3) {
      const endY = archY(xEnd), behind = Math.max(0, endY - y);
      if (upper) h -= 6 * smooth(4, 9, behind) * Math.exp(-sq(d / 6));
      else h += 1.5 * Math.exp(-sq((behind - 5) / 4)) * Math.exp(-sq(d / 5));
    }
    return h;
  };
  const keep = (x, y) => {
    const { d } = nearest(x, y);
    if (y < archY(xEnd) && Math.abs(x) > xEnd + 7) return false;
    if (upper) return y > archY(xEnd) - 12 && d < sulcusD + 6;
    return y > archY(xEnd) - 14 && d < sulcusD + 6 && d > -14;
  };
  const xs = [], ys = [];
  for (let x = -45; x <= 45 + 1e-9; x += step) xs.push(+x.toFixed(4));
  for (let y = -20; y <= 50 + 1e-9; y += step) ys.push(+y.toFixed(4));
  const grid = xs.map(x => ys.map(y => keep(x, y) ? [x, y, height(x, y)] : null));
  const out = [];
  for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ys.length - 1; j++) {
    const a = grid[i][j], b = grid[i + 1][j], c = grid[i + 1][j + 1], d = grid[i][j + 1];
    if (a && b && c && d) out.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  const truth = { jaw, archY: { y0, k, xEnd }, sulcusD, sulcusDepth, frenaT, R: [-xEnd, archY(xEnd), 0], M: [0, y0, 0], L: [xEnd, archY(xEnd), 0], papilla: upper ? [0, y0 - 7] : null };
  return { soup: Float32Array.from(out), truth };
}

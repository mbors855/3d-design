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

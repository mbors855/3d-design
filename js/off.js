// OFF-meshes lezen: ASCII "OFF" en "OFF BINARY". exocad-bibliotheken (.eoff) gebruiken een binaire variant
// in little-endian met een 16-bits hoekpuntaantal per vlak; de klassieke variant is big-endian met 32 bits.
// Resultaat: { positions: Float32Array, indices: Uint32Array } (vlakken met >3 hoeken als waaier).

export function parseOFF(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 64)));
  if (head.startsWith('OFF BINARY')) return parseBinary(bytes, head.indexOf('\n') + 1);
  if (/^\s*[NC]?OFF/.test(head)) return parseAscii(new TextDecoder('latin1').decode(bytes));
  throw Error('Geen OFF-bestand.');
}

function parseBinary(bytes, start) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const le of [true, false]) {
    const nv = v.getInt32(start, le), nf = v.getInt32(start + 4, le);
    if (!(nv > 0 && nf > 0 && nv < 5e7 && nf < 1e8 && start + 12 + nv * 12 <= bytes.length)) continue;
    let p = start + 12;
    const positions = new Float32Array(nv * 3);
    for (let i = 0; i < nv * 3; i++, p += 4) positions[i] = v.getFloat32(p, le);
    for (const wide of le ? [false, true] : [true, false]) {
      const tris = tryFaces(v, p, nf, nv, le, wide);
      if (tris) return { positions, indices: tris };
    }
  }
  throw Error('OFF BINARY: onbekende indeling.');
}

function tryFaces(v, p, nf, nv, le, wide) {
  const out = [];
  for (let f = 0; f < nf; f++) {
    if (p + (wide ? 4 : 2) > v.byteLength) return null;
    const c = wide ? v.getInt32(p, le) : v.getUint16(p, le); p += wide ? 4 : 2;
    if (c < 3 || c > 64 || p + c * 4 > v.byteLength) return null;
    const a = v.getInt32(p, le);
    let prev = v.getInt32(p + 4, le);
    if (a < 0 || a >= nv || prev < 0 || prev >= nv) return null;
    for (let k = 2; k < c; k++) { const cur = v.getInt32(p + 4 * k, le); if (cur < 0 || cur >= nv) return null; out.push(a, prev, cur); prev = cur; }
    p += c * 4;
    if (!wide) continue;
    // klassiek formaat: aantal kleurwaarden + kleuren
    if (p + 4 > v.byteLength) return null;
    const nc = v.getInt32(p, le); p += 4;
    if (nc < 0 || nc > 4) return null;
    p += nc * 4;
  }
  return Uint32Array.from(out);
}

function parseAscii(text) {
  const tok = text.replace(/#[^\n]*/g, ' ').trim().split(/\s+/);
  let i = 1;
  const nv = +tok[i++], nf = +tok[i++]; i++;
  const positions = new Float32Array(nv * 3);
  for (let k = 0; k < nv * 3; k++) positions[k] = +tok[i++];
  const out = [];
  for (let f = 0; f < nf; f++) {
    const c = +tok[i++], a = +tok[i++]; let prev = +tok[i++];
    for (let k = 2; k < c; k++) { const cur = +tok[i++]; out.push(a, prev, cur); prev = cur; }
  }
  return { positions, indices: Uint32Array.from(out) };
}

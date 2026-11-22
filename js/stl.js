// STL lezen en schrijven. Eén implementatie voor het hele programma.
// Een "soup" is een Float32Array met 9 getallen per driehoek (3 hoekpunten × xyz).

export const MAX_TRIANGLES = 3_000_000;

export function isBinarySTL(buffer) {
  if (buffer.byteLength < 84) return false;
  const count = new DataView(buffer).getUint32(80, true);
  return count > 0 && 84 + count * 50 === buffer.byteLength;
}

export function parseSTL(buffer) {
  if (!(buffer instanceof ArrayBuffer)) throw Error('Geen geldig bestand.');
  if (buffer.byteLength < 15) throw Error('Bestand is te klein voor een STL.');
  let soup;
  if (isBinarySTL(buffer)) {
    const view = new DataView(buffer);
    const count = view.getUint32(80, true);
    if (count > MAX_TRIANGLES) throw Error('Deze STL heeft meer dan ' + MAX_TRIANGLES.toLocaleString('nl-NL') + ' driehoeken.');
    soup = new Float32Array(count * 9);
    for (let i = 0; i < count; i++) {
      const o = 84 + i * 50 + 12;
      for (let j = 0; j < 9; j++) soup[i * 9 + j] = view.getFloat32(o + j * 4, true);
    }
  } else {
    const text = new TextDecoder().decode(buffer);
    if (!/^\s*solid/i.test(text) && !/facet/i.test(text)) throw Error('Bestand is geen herkenbare STL.');
    const re = /vertex\s+([+\-\d.eE]+)\s+([+\-\d.eE]+)\s+([+\-\d.eE]+)/g;
    const values = [];
    let m;
    while ((m = re.exec(text))) {
      values.push(+m[1], +m[2], +m[3]);
      if (values.length > MAX_TRIANGLES * 9) throw Error('Te veel driehoeken in deze ASCII-STL.');
    }
    if (!values.length || values.length % 9) throw Error('Ongeldige ASCII-STL.');
    soup = Float32Array.from(values);
  }
  for (let i = 0; i < soup.length; i++) if (!Number.isFinite(soup[i])) throw Error('STL bevat ongeldige coördinaten.');
  if (!soup.length) throw Error('STL bevat geen driehoeken.');
  return soup;
}

export function writeSTL(soup, header = 'Digital Denture CAD') {
  const count = soup.length / 9;
  const buffer = new ArrayBuffer(84 + count * 50);
  const view = new DataView(buffer);
  new TextEncoder().encodeInto(header.slice(0, 79), new Uint8Array(buffer, 0, 80));
  view.setUint32(80, count, true);
  for (let i = 0; i < count; i++) {
    const t = i * 9, o = 84 + i * 50;
    const ax = soup[t + 3] - soup[t], ay = soup[t + 4] - soup[t + 1], az = soup[t + 5] - soup[t + 2];
    const bx = soup[t + 6] - soup[t], by = soup[t + 7] - soup[t + 1], bz = soup[t + 8] - soup[t + 2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    view.setFloat32(o, nx / l, true); view.setFloat32(o + 4, ny / l, true); view.setFloat32(o + 8, nz / l, true);
    for (let j = 0; j < 9; j++) view.setFloat32(o + 12 + j * 4, soup[t + j], true);
  }
  return buffer;
}

export function concatSoups(list) {
  const total = list.reduce((s, a) => s + a.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const a of list) { out.set(a, o); o += a.length; }
  return out;
}

export function soupBounds(soup) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < soup.length; i += 3) for (let j = 0; j < 3; j++) {
    const v = soup[i + j];
    if (v < min[j]) min[j] = v;
    if (v > max[j]) max[j] = v;
  }
  return { min, max, size: max.map((v, i) => v - min[i]), center: max.map((v, i) => (v + min[i]) / 2) };
}

export function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text) {
  const s = atob(text), bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}

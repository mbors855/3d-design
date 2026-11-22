// Minimale ZIP-lezer (stored + deflate) via de ingebouwde DecompressionStream, met ZIP64.
// Leest stukje voor stukje uit een bron, zodat ook een zip van honderden MB op een telefoon werkt.
// bron: File/Blob, ArrayBuffer of { size, read(offset, length) → Promise<ArrayBuffer> }.
export function zipSource(src) {
  if (src instanceof ArrayBuffer) return { size: src.byteLength, read: async (o, n) => src.slice(o, o + n) };
  if (typeof Blob !== 'undefined' && src instanceof Blob) return { size: src.size, read: (o, n) => src.slice(o, o + n).arrayBuffer() };
  return src;
}

export async function listZip(input) {
  const src = zipSource(input), n = src.size;
  const tailLen = Math.min(n, 65557 + 20), tailStart = n - tailLen;
  const tail = new DataView(await src.read(tailStart, tailLen));
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw Error('Geen geldig ZIP-bestand.');
  let count = tail.getUint16(eocd + 10, true), size = tail.getUint32(eocd + 12, true), offset = tail.getUint32(eocd + 16, true);
  if ((offset === 0xffffffff || count === 0xffff || size === 0xffffffff) && eocd >= 20 && tail.getUint32(eocd - 20, true) === 0x07064b50) {
    const z = Number(tail.getBigUint64(eocd - 20 + 8, true));
    const z64 = new DataView(await src.read(z, 56));
    count = Number(z64.getBigUint64(32, true)); size = Number(z64.getBigUint64(40, true)); offset = Number(z64.getBigUint64(48, true));
  }
  const v = new DataView(await src.read(offset, size)), entries = [], utf8 = new TextDecoder(), latin = new TextDecoder('latin1');
  for (let i = 0, p = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw Error('ZIP-inhoudsopgave beschadigd.');
    const flags = v.getUint16(p + 8, true), method = v.getUint16(p + 10, true);
    let csize = v.getUint32(p + 20, true), usize = v.getUint32(p + 24, true), local = v.getUint32(p + 42, true);
    const nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true);
    const raw = new Uint8Array(v.buffer, v.byteOffset + p + 46, nl);
    const name = (flags & 0x800 ? utf8 : latin).decode(raw);
    for (let x = p + 46 + nl; x < p + 46 + nl + xl;) {
      const id = v.getUint16(x, true), sz = v.getUint16(x + 2, true);
      if (id === 1) { let q = x + 4; if (usize === 0xffffffff) { usize = Number(v.getBigUint64(q, true)); q += 8; } if (csize === 0xffffffff) { csize = Number(v.getBigUint64(q, true)); q += 8; } if (local === 0xffffffff) local = Number(v.getBigUint64(q, true)); }
      x += 4 + sz;
    }
    if (!name.endsWith('/') && !/(^|\/)(__MACOSX|\.DS_Store)/.test(name)) entries.push({ name, method, csize, usize, local });
    p += 46 + nl + xl + cl;
  }
  return entries;
}

export async function readZipEntry(input, e) {
  const src = zipSource(input);
  const head = new DataView(await src.read(e.local, 30));
  if (head.getUint32(0, true) !== 0x04034b50) throw Error(`${e.name}: lokale kop beschadigd.`);
  const start = e.local + 30 + head.getUint16(26, true) + head.getUint16(28, true);
  const data = await src.read(start, e.csize);
  if (e.method === 0) return data;
  if (e.method !== 8) throw Error(`${e.name}: compressiemethode ${e.method} niet ondersteund.`);
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return await new Response(stream).arrayBuffer();
}

// WinZip-AES (AE-1/AE-2) ontsleuteling voor ZIP-methode 99: PBKDF2-HMAC-SHA1 via WebCrypto,
// AES-CTR met little-endian teller (begint bij 1) in eigen code, want WebCrypto telt big-endian.
// Alleen versleutelen (de CTR-sleutelstroom) is nodig.

const SBOX = new Uint8Array(256), T0 = new Uint32Array(256), T1 = new Uint32Array(256), T2 = new Uint32Array(256), T3 = new Uint32Array(256);
// S-box en T-tabellen uit GF(2^8)-inverses:
(function rebuild() {
  // GF(2^8) inverse via exponent-/logtabellen
  const exp = new Uint8Array(512), log = new Uint8Array(256);
  let v = 1;
  for (let i = 0; i < 255; i++) { exp[i] = v; log[v] = i; v ^= (v << 1) ^ ((v & 0x80) ? 0x11b : 0); v &= 0xff; }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
  const mul = (a, b) => (a && b) ? exp[log[a] + log[b]] : 0;
  for (let i = 0; i < 256; i++) {
    const inv = i ? exp[255 - log[i]] : 0;
    let s = inv, r = inv;
    for (let k = 0; k < 4; k++) { r = ((r << 1) | (r >> 7)) & 0xff; s ^= r; }
    SBOX[i] = s ^ 0x63;
  }
  for (let i = 0; i < 256; i++) {
    const s = SBOX[i], s2 = mul(s, 2), s3 = mul(s, 3);
    T0[i] = ((s2 << 24) | (s << 16) | (s << 8) | s3) >>> 0;
    T1[i] = ((s3 << 24) | (s2 << 16) | (s << 8) | s) >>> 0;
    T2[i] = ((s << 24) | (s3 << 16) | (s2 << 8) | s) >>> 0;
    T3[i] = ((s << 24) | (s << 16) | (s3 << 8) | s2) >>> 0;
  }
})();

export function expandKey(key) {
  const nk = key.length / 4, nr = nk + 6, w = new Uint32Array(4 * (nr + 1));
  for (let i = 0; i < nk; i++) w[i] = (key[4 * i] << 24 | key[4 * i + 1] << 16 | key[4 * i + 2] << 8 | key[4 * i + 3]) >>> 0;
  let rcon = 1;
  for (let i = nk; i < w.length; i++) {
    let t = w[i - 1];
    if (i % nk === 0) {
      t = ((SBOX[(t >>> 16) & 255] << 24) | (SBOX[(t >>> 8) & 255] << 16) | (SBOX[t & 255] << 8) | SBOX[t >>> 24]) ^ (rcon << 24);
      rcon = (rcon << 1) ^ ((rcon & 0x80) ? 0x11b : 0);
    } else if (nk > 6 && i % nk === 4) {
      t = (SBOX[t >>> 24] << 24) | (SBOX[(t >>> 16) & 255] << 16) | (SBOX[(t >>> 8) & 255] << 8) | SBOX[t & 255];
    }
    w[i] = (w[i - nk] ^ t) >>> 0;
  }
  return { w, nr };
}

// Versleutelt één blok (4 woorden big-endian) → out (4 woorden).
export function encryptBlock({ w, nr }, a0, a1, a2, a3, out) {
  let s0 = a0 ^ w[0], s1 = a1 ^ w[1], s2 = a2 ^ w[2], s3 = a3 ^ w[3], k = 4;
  for (let r = 1; r < nr; r++, k += 4) {
    const t0 = T0[s0 >>> 24] ^ T1[(s1 >>> 16) & 255] ^ T2[(s2 >>> 8) & 255] ^ T3[s3 & 255] ^ w[k];
    const t1 = T0[s1 >>> 24] ^ T1[(s2 >>> 16) & 255] ^ T2[(s3 >>> 8) & 255] ^ T3[s0 & 255] ^ w[k + 1];
    const t2 = T0[s2 >>> 24] ^ T1[(s3 >>> 16) & 255] ^ T2[(s0 >>> 8) & 255] ^ T3[s1 & 255] ^ w[k + 2];
    const t3 = T0[s3 >>> 24] ^ T1[(s0 >>> 16) & 255] ^ T2[(s1 >>> 8) & 255] ^ T3[s2 & 255] ^ w[k + 3];
    s0 = t0; s1 = t1; s2 = t2; s3 = t3;
  }
  const f = (a, b, c, d, kk) => ((SBOX[a >>> 24] << 24) | (SBOX[(b >>> 16) & 255] << 16) | (SBOX[(c >>> 8) & 255] << 8) | SBOX[d & 255]) ^ w[kk];
  out[0] = f(s0, s1, s2, s3, k) >>> 0; out[1] = f(s1, s2, s3, s0, k + 1) >>> 0; out[2] = f(s2, s3, s0, s1, k + 2) >>> 0; out[3] = f(s3, s0, s1, s2, k + 3) >>> 0;
}

// AES-CTR met WinZip-teller: 128-bit little-endian, begint bij 1. Werkt in place op data (Uint8Array).
export function ctrWinZip(keyBytes, data) {
  const ks = expandKey(keyBytes), out = new Uint32Array(4), ctr = new Uint8Array(16);
  ctr[0] = 1;
  for (let p = 0; p < data.length; p += 16) {
    const a0 = (ctr[0] << 24 | ctr[1] << 16 | ctr[2] << 8 | ctr[3]) >>> 0, a1 = (ctr[4] << 24 | ctr[5] << 16 | ctr[6] << 8 | ctr[7]) >>> 0;
    const a2 = (ctr[8] << 24 | ctr[9] << 16 | ctr[10] << 8 | ctr[11]) >>> 0, a3 = (ctr[12] << 24 | ctr[13] << 16 | ctr[14] << 8 | ctr[15]) >>> 0;
    encryptBlock(ks, a0, a1, a2, a3, out);
    const n = Math.min(16, data.length - p);
    for (let i = 0; i < n; i++) data[p + i] ^= (out[i >> 2] >>> (24 - 8 * (i & 3))) & 255;
    for (let i = 0; i < 16; i++) { ctr[i] = (ctr[i] + 1) & 255; if (ctr[i]) break; }
  }
  return data;
}

const keyCache = new Map();
// data: Uint8Array van de versleutelde inhoud (salt + verifier + data + 10 bytes auth). strength 1/2/3 = 128/192/256.
export async function decryptWinZip(data, password, strength) {
  const keyLen = [0, 16, 24, 32][strength], saltLen = keyLen / 2;
  if (!keyLen) throw Error('Onbekende AES-sterkte.');
  const salt = data.subarray(0, saltLen), verifier = data.subarray(saltLen, saltLen + 2);
  const ck = password + '|' + strength + '|' + Array.from(salt).join(',');
  let bits = keyCache.get(ck);
  if (!bits) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) throw Error('Versleutelde ZIP vraagt WebCrypto (https of localhost).');
    const base = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    bits = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 1000, hash: 'SHA-1' }, base, (2 * keyLen + 2) * 8));
    if (keyCache.size > 4000) keyCache.clear();
    keyCache.set(ck, bits);
  }
  if (bits[2 * keyLen] !== verifier[0] || bits[2 * keyLen + 1] !== verifier[1]) { const e = Error('Onjuist wachtwoord voor de versleutelde ZIP.'); e.code = 'PASSWORD'; throw e; }
  const body = data.slice(saltLen + 2, data.length - 10);
  return ctrWinZip(bits.subarray(0, keyLen), body);
}

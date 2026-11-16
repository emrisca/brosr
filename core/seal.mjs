// The seal for the transport: one room key, one random nonce per frame,
// XChaCha20-Poly1305 over the frame bytes. Section 10, rule 4 of ../docs/plan.md.
//
// The cipher is plain JavaScript, not `node:crypto`, so the same module runs in
// a content script and in a Node test. HKDF is plain JavaScript too, because a
// page served from a LAN or tailnet address is not a secure context and has no
// `crypto.subtle`. Every step has the draft's test vectors in
// test/seal.test.mjs.
//
// The relay sees a room id, a peer id and a frame size. It never sees a URL, a
// name or a cursor, because those bytes are ciphertext by the time they leave
// this module.

const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];
const P1305 = (1n << 130n) - 5n;
const MASK128 = (1n << 128n) - 1n;

const VERSION = 'brosr/v1';
const KEY_BYTES = 16;
const SUBKEY_BYTES = 32;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;

const EMPTY = new Uint8Array(0);

function fail(message) {
  throw new Error(message);
}

function rotl(value, bits) {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function quarterRound(state, a, b, c, d) {
  state[a] = (state[a] + state[b]) >>> 0;
  state[d] = rotl((state[d] ^ state[a]) >>> 0, 16);
  state[c] = (state[c] + state[d]) >>> 0;
  state[b] = rotl((state[b] ^ state[c]) >>> 0, 12);
  state[a] = (state[a] + state[b]) >>> 0;
  state[d] = rotl((state[d] ^ state[a]) >>> 0, 8);
  state[c] = (state[c] + state[d]) >>> 0;
  state[b] = rotl((state[b] ^ state[c]) >>> 0, 7);
}

function rounds(state) {
  for (let round = 0; round < 10; round += 1) {
    quarterRound(state, 0, 4, 8, 12);
    quarterRound(state, 1, 5, 9, 13);
    quarterRound(state, 2, 6, 10, 14);
    quarterRound(state, 3, 7, 11, 15);
    quarterRound(state, 0, 5, 10, 15);
    quarterRound(state, 1, 6, 11, 12);
    quarterRound(state, 2, 7, 8, 13);
    quarterRound(state, 3, 4, 9, 14);
  }
}

function words(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Uint32Array(bytes.byteLength / 4);
  for (let index = 0; index < out.length; index += 1) out[index] = view.getUint32(index * 4, true);
  return out;
}

function littleEndian(word, out, offset) {
  out[offset] = word & 0xff;
  out[offset + 1] = (word >>> 8) & 0xff;
  out[offset + 2] = (word >>> 16) & 0xff;
  out[offset + 3] = (word >>> 24) & 0xff;
}

// HChaCha20 turns a 32-byte key and a 16-byte nonce into a 32-byte subkey. The
// output keeps the first and last row of the ChaCha state, which is why the
// subkey depends on the key and the first half of the nonce.
export function hchacha20(key, nonce) {
  if (key.length !== SUBKEY_BYTES) fail('hchacha20 needs a 32 byte key');
  if (nonce.length !== 16) fail('hchacha20 needs a 16 byte nonce');
  const state = new Uint32Array(16);
  state.set(SIGMA, 0);
  state.set(words(key), 4);
  state.set(words(nonce), 12);
  rounds(state);
  const out = new Uint8Array(SUBKEY_BYTES);
  for (let index = 0; index < 4; index += 1) littleEndian(state[index], out, index * 4);
  for (let index = 0; index < 4; index += 1) littleEndian(state[12 + index], out, 16 + index * 4);
  return out;
}

function block(key, nonce, counter) {
  const state = new Uint32Array(16);
  state.set(SIGMA, 0);
  state.set(words(key), 4);
  state[12] = counter >>> 0;
  state.set(words(nonce), 13);
  const working = state.slice();
  rounds(working);
  const out = new Uint8Array(64);
  for (let index = 0; index < 16; index += 1) {
    littleEndian((working[index] + state[index]) >>> 0, out, index * 4);
  }
  return out;
}

function xorStream(key, nonce, input, counter) {
  const out = new Uint8Array(input.length);
  let offset = 0;
  let count = counter;
  while (offset < input.length) {
    const stream = block(key, nonce, count);
    const take = Math.min(64, input.length - offset);
    for (let index = 0; index < take; index += 1) {
      out[offset + index] = input[offset + index] ^ stream[index];
    }
    offset += take;
    count += 1;
  }
  return out;
}

function clamp(bytes) {
  const r = Uint8Array.prototype.slice.call(bytes, 0, 16);
  r[3] &= 15;
  r[7] &= 15;
  r[11] &= 15;
  r[15] &= 15;
  r[4] &= 252;
  r[8] &= 252;
  r[12] &= 252;
  return r;
}

function leToBigInt(bytes) {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[index]);
  }
  return value;
}

function bigIntToLe(value, length) {
  const out = new Uint8Array(length);
  let rest = value;
  for (let index = 0; index < length; index += 1) {
    out[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

// Poly1305 over bytes with a 32-byte one-time key. Each block is read little
// endian and gets the appended 1 byte the 2^128(n) term calls for.
export function poly1305(message, key) {
  if (key.length !== SUBKEY_BYTES) fail('poly1305 needs a 32 byte key');
  const r = leToBigInt(clamp(key));
  const s = leToBigInt(key.slice(16));
  let accumulator = 0n;
  for (let offset = 0; offset < message.length; offset += 16) {
    const chunk = message.slice(offset, Math.min(offset + 16, message.length));
    const number = leToBigInt(chunk) + (1n << BigInt(8 * chunk.length));
    accumulator = ((accumulator + number) * r) % P1305;
  }
  return bigIntToLe((accumulator + s) & MASK128, TAG_BYTES);
}

function pad16(length) {
  const rest = length % 16;
  return rest === 0 ? EMPTY : new Uint8Array(16 - rest);
}

function le64(value) {
  return bigIntToLe(BigInt(value), 8);
}

function join(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// HKDF needs a hash, and the room key is derived on a page that may have no
// WebCrypto. SHA-256 is the one hash here, written with the same integer math
// as the cipher. The block below is FIPS 180-4.
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value, bits) {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

export function sha256(bytes) {
  const length = bytes.length;
  const padded = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded.length - 4, bits >>> 0);
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const low = schedule[index - 15];
      const high = schedule[index - 2];
      const s0 = (rotr(low, 7) ^ rotr(low, 18) ^ (low >>> 3)) >>> 0;
      const s1 = (rotr(high, 17) ^ rotr(high, 19) ^ (high >>> 10)) >>> 0;
      schedule[index] =
        (schedule[index - 16] + s0 + schedule[index - 7] + s1) >>> 0;
    }
    let a = state[0];
    let b = state[1];
    let c = state[2];
    let d = state[3];
    let e = state[4];
    let f = state[5];
    let g = state[6];
    let h = state[7];
    for (let index = 0; index < 64; index += 1) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const choice = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + s1 + choice + K256[index] + schedule[index]) >>> 0;
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const write = new DataView(out.buffer);
  for (let index = 0; index < 8; index += 1) write.setUint32(index * 4, state[index]);
  return out;
}

function hmacSha256(key, message) {
  const base = key.length > 64 ? sha256(key) : key;
  const pad = new Uint8Array(64);
  pad.set(base);
  const inner = new Uint8Array(64 + message.length);
  const outer = new Uint8Array(64 + 32);
  for (let index = 0; index < 64; index += 1) {
    inner[index] = pad[index] ^ 0x36;
    outer[index] = pad[index] ^ 0x5c;
  }
  inner.set(message, 64);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}

// The extract and expand steps of RFC 5869, with SHA-256 as the hash.
export function hkdfSha256(ikm, salt, info, length = SUBKEY_BYTES) {
  const prk = hmacSha256(salt, ikm);
  const out = new Uint8Array(length);
  let previous = EMPTY;
  let offset = 0;
  for (let counter = 1; offset < length; counter += 1) {
    const blockOut = hmacSha256(prk, join([previous, info, new Uint8Array([counter])]));
    const take = Math.min(blockOut.length, length - offset);
    out.set(blockOut.subarray(0, take), offset);
    offset += take;
    previous = blockOut;
  }
  return out;
}

function checkKey(key, who) {
  if (!(key instanceof Uint8Array) || key.length !== SUBKEY_BYTES) {
    fail(`${who} needs a 32 byte room key`);
  }
}

function checkNonce(nonce) {
  if (!(nonce instanceof Uint8Array) || nonce.length !== NONCE_BYTES) {
    fail(`a frame nonce is ${NONCE_BYTES} bytes, not ${nonce?.length}`);
  }
}

function macData(aad, ciphertext) {
  return join([
    aad,
    pad16(aad.length),
    ciphertext,
    pad16(ciphertext.length),
    le64(aad.length),
    le64(ciphertext.length),
  ]);
}

// XChaCha20-Poly1305 over plaintext with an explicit nonce and associated
// data. Returns the ciphertext with its 16-byte tag appended. This is the
// layer the draft's test vector exercises.
export function sealBytes(key, nonce, plaintext, aad = EMPTY) {
  checkKey(key, 'sealBytes');
  checkNonce(nonce);
  const body = plaintext instanceof Uint8Array ? plaintext : new Uint8Array(plaintext);
  const subkey = hchacha20(key, nonce.slice(0, 16));
  const ietfNonce = join([new Uint8Array(4), nonce.slice(16)]);
  const ciphertext = xorStream(subkey, ietfNonce, body, 1);
  const tag = poly1305(macData(aad, ciphertext), block(subkey, ietfNonce, 0).slice(0, SUBKEY_BYTES));
  return join([ciphertext, tag]);
}

export function openBytes(key, nonce, sealed, aad = EMPTY) {
  checkKey(key, 'openBytes');
  checkNonce(nonce);
  const body = sealed instanceof Uint8Array ? sealed : new Uint8Array(sealed);
  if (body.length < TAG_BYTES) fail('the frame is too short to hold a tag');
  const ciphertext = body.slice(0, body.length - TAG_BYTES);
  const tag = body.slice(body.length - TAG_BYTES);
  const subkey = hchacha20(key, nonce.slice(0, 16));
  const ietfNonce = join([new Uint8Array(4), nonce.slice(16)]);
  const expected = poly1305(macData(aad, ciphertext), block(subkey, ietfNonce, 0).slice(0, SUBKEY_BYTES));
  let difference = 0;
  for (let index = 0; index < TAG_BYTES; index += 1) difference |= expected[index] ^ tag[index];
  if (difference !== 0) fail('the frame did not open for this room key');
  return xorStream(subkey, ietfNonce, ciphertext, 1);
}

function roomAad(room) {
  return new TextEncoder().encode(`${VERSION}/${room}`);
}

// A whole frame: the 24-byte nonce, then the ciphertext, then the tag. The
// room is the associated data, so a frame sealed for one room cannot open in
// another even if a key were shared by mistake.
export function sealFrame(key, plaintext, { room = '', nonce = null } = {}) {
  checkKey(key, 'sealFrame');
  const iv = nonce || new Uint8Array(NONCE_BYTES);
  checkNonce(iv);
  if (!nonce) {
    if (!globalThis.crypto?.getRandomValues) fail('no random source for the frame nonce');
    globalThis.crypto.getRandomValues(iv);
  }
  return join([iv, sealBytes(key, iv, plaintext, roomAad(room))]);
}

export function openFrame(key, sealed, { room = '' } = {}) {
  checkKey(key, 'openFrame');
  const bytes = sealed instanceof Uint8Array ? sealed : new Uint8Array(sealed);
  if (bytes.length < NONCE_BYTES + TAG_BYTES) {
    fail('the frame is too short to hold a nonce and a tag');
  }
  return openBytes(key, bytes.slice(0, NONCE_BYTES), bytes.slice(NONCE_BYTES), roomAad(room));
}

// The invite carries 128 random bits in the fragment. HKDF expands them to the
// 32-byte key the cipher needs, so the link is short and the key never sits in
// a query string that a relay or a proxy can log.
export function newRoomKey() {
  if (!globalThis.crypto?.getRandomValues) fail('no random source for the room key');
  const bytes = new Uint8Array(KEY_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return encodeKey(bytes);
}

export async function roomKey(inviteKey) {
  const base = decodeKey(inviteKey);
  if (base.length !== KEY_BYTES) fail(`a room key is ${KEY_BYTES} bytes, not ${base.length}`);
  return hkdfSha256(base, new TextEncoder().encode(VERSION), new TextEncoder().encode('room frame key'));
}

// base64url without padding. btoa and atob exist in Node and in Firefox, so an
// invite decodes the same way in a test and in a content script.
export function encodeKey(bytes) {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeKey(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) fail('the room key is not base64url');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) out[index] = raw.charCodeAt(index);
  return out;
}

export function inviteLink(base, { room = '', key, name = '' } = {}) {
  const url = new URL(base);
  if (room) url.searchParams.set('room', room);
  if (name) url.searchParams.set('name', name);
  url.hash = `k=${key}`;
  return url.toString();
}

export function readInvite(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    fail('the invite is not a URL');
  }
  const params = new URLSearchParams(url.hash.replace(/^#/, ''));
  const key = params.get('k');
  if (!key) fail('the invite has no room key in its fragment');
  url.hash = '';
  return { url: url.toString(), room: url.searchParams.get('room') || '', key, keyBytes: decodeKey(key) };
}

export const SEAL = {
  version: VERSION,
  keyBytes: KEY_BYTES,
  subkeyBytes: SUBKEY_BYTES,
  nonceBytes: NONCE_BYTES,
  tagBytes: TAG_BYTES,
};

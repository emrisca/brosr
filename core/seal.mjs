// The seal for the transport: one room key, one random nonce per frame,
// XChaCha20-Poly1305 over the frame bytes. Section 10, rule 4 of ../plan.md.
//
// The cipher is plain JavaScript, not `node:crypto`, so the same module runs in
// a content script and in a Node test. The only platform call is WebCrypto,
// used for HKDF alone. Every other step is integer math with the draft's test
// vectors in test/seal.test.mjs.
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
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) fail('HKDF needs WebCrypto, which this context does not expose');
  const material = await subtle.importKey('raw', base, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(VERSION),
      info: new TextEncoder().encode('room frame key'),
    },
    material,
    SUBKEY_BYTES * 8
  );
  return new Uint8Array(bits);
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

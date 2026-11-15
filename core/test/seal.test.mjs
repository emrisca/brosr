import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hchacha20,
  poly1305,
  sealBytes,
  openBytes,
  sealFrame,
  openFrame,
  newRoomKey,
  roomKey,
  encodeKey,
  decodeKey,
  inviteLink,
  readInvite,
  SEAL,
} from '../seal.mjs';

const hex = (text) => new Uint8Array(Buffer.from(text, 'hex'));
const asHex = (bytes) => Buffer.from(bytes).toString('hex');
const text = (value) => new TextEncoder().encode(value);

// draft-irtf-cfrg-xchacha-03, section 2.2.1.
const HCHACHA_KEY = hex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
const HCHACHA_NONCE = hex('000000090000004a0000000031415927');
const HCHACHA_SUBKEY = '82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc';

// The same draft, section A.3.1: the full AEAD vector, not a stream cipher one.
const AEAD_KEY = hex('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f');
const AEAD_NONCE = hex('404142434445464748494a4b4c4d4e4f5051525354555657');
const AEAD_AAD = hex('50515253c0c1c2c3c4c5c6c7');
const AEAD_PLAINTEXT = hex(
  '4c616469657320616e642047656e746c656d656e206f662074686520636c617373206f6620' +
    '2739393a204966204920636f756c64206f6666657220796f75206f6e6c79206f6e65207469' +
    '7020666f7220746865206675747572652c2073756e73637265656e20776f756c6420626520' +
    '69742e'
);
const AEAD_CIPHERTEXT =
  'bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb' +
  '731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b452' +
  '2f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff9' +
  '21f9664c97637da9768812f615c68b13b52e';
const AEAD_TAG = 'c0875924c1c7987947deafd8780acf49';

test('HChaCha20 matches the draft subkey', () => {
  assert.equal(asHex(hchacha20(HCHACHA_KEY, HCHACHA_NONCE)), HCHACHA_SUBKEY);
});

test('HChaCha20 refuses a key or nonce of the wrong length', () => {
  assert.throws(() => hchacha20(hex('00'), HCHACHA_NONCE), /32 byte key/);
  assert.throws(() => hchacha20(HCHACHA_KEY, hex('00')), /16 byte nonce/);
});

test('XChaCha20-Poly1305 matches the draft ciphertext and tag', () => {
  const sealed = sealBytes(AEAD_KEY, AEAD_NONCE, AEAD_PLAINTEXT, AEAD_AAD);
  assert.equal(asHex(sealed.slice(0, sealed.length - SEAL.tagBytes)), AEAD_CIPHERTEXT);
  assert.equal(asHex(sealed.slice(sealed.length - SEAL.tagBytes)), AEAD_TAG);
});

test('the draft plaintext opens again with the right key, nonce and aad', () => {
  const sealed = sealBytes(AEAD_KEY, AEAD_NONCE, AEAD_PLAINTEXT, AEAD_AAD);
  assert.equal(asHex(openBytes(AEAD_KEY, AEAD_NONCE, sealed, AEAD_AAD)), asHex(AEAD_PLAINTEXT));
});

test('an aad change refuses to open, so a frame stays in its room', () => {
  const sealed = sealBytes(AEAD_KEY, AEAD_NONCE, AEAD_PLAINTEXT, AEAD_AAD);
  assert.throws(
    () => openBytes(AEAD_KEY, AEAD_NONCE, sealed, hex('50515253c0c1c2c3c4c5c6c8')),
    /did not open/
  );
});

test('poly1305 matches the RFC 8439 one-time key case', () => {
  // RFC 8439 section 2.5.2, the first poly1305 test vector.
  const key = hex('85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b');
  const message = text('Cryptographic Forum Research Group');
  assert.equal(asHex(poly1305(message, key)), 'a8061dc1305136c6c22b8baf0c0127a9');
});

test('a room frame survives a seal and an open', () => {
  const key = hex(HCHACHA_SUBKEY);
  const frame = text(JSON.stringify({ v: 1, type: 'nav', url: 'http://x/a.html' }));
  const sealed = sealFrame(key, frame, { room: 'demo' });
  assert.equal(sealed.length, SEAL.nonceBytes + frame.length + SEAL.tagBytes);
  assert.equal(new TextDecoder().decode(openFrame(key, sealed, { room: 'demo' })), new TextDecoder().decode(frame));
});

test('sealed bytes carry no URL and no name', () => {
  const key = hex(HCHACHA_SUBKEY);
  const frame = text(JSON.stringify({ type: 'presence', peerId: 'p2', name: 'Peer Two', url: 'http://secret.test/a' }));
  const sealed = Buffer.from(sealFrame(key, frame, { room: 'demo' }));
  assert.equal(sealed.includes(Buffer.from('secret.test')), false, 'the host leaked');
  assert.equal(sealed.includes(Buffer.from('Peer Two')), false, 'the name leaked');
});

test('two frames of the same plaintext differ, because the nonce is random', () => {
  const key = hex(HCHACHA_SUBKEY);
  const frame = text('same bytes');
  assert.notEqual(asHex(sealFrame(key, frame)), asHex(sealFrame(key, frame)));
});

test('one flipped byte stops the frame opening', () => {
  const key = hex(HCHACHA_SUBKEY);
  const sealed = sealFrame(key, text('hello'), { room: 'demo' });
  for (const index of [SEAL.nonceBytes, SEAL.nonceBytes + 1, sealed.length - 1]) {
    const damaged = Uint8Array.from(sealed);
    damaged[index] ^= 1;
    assert.throws(() => openFrame(key, damaged, { room: 'demo' }), /did not open/);
  }
});

test('a frame from another room does not open', () => {
  const key = hex(HCHACHA_SUBKEY);
  const sealed = sealFrame(key, text('hello'), { room: 'one' });
  assert.throws(() => openFrame(key, sealed, { room: 'two' }), /did not open/);
});

test('a frame from another key does not open', () => {
  const sealed = sealFrame(hex(HCHACHA_SUBKEY), text('hello'), { room: 'demo' });
  const other = hchacha20(hex('11'.repeat(32)), HCHACHA_NONCE);
  assert.throws(() => openFrame(other, sealed, { room: 'demo' }), /did not open/);
});

test('a short or wrong sized frame is refused before the cipher runs', () => {
  const key = hex(HCHACHA_SUBKEY);
  assert.throws(() => openFrame(key, new Uint8Array(8)), /too short/);
  assert.throws(() => sealFrame(key, text('x'), { nonce: new Uint8Array(12) }), /24 bytes/);
  assert.throws(() => sealFrame(hex('00'), text('x')), /32 byte room key/);
});

test('a fresh room key is sixteen random bytes in base64url', () => {
  const first = newRoomKey();
  const second = newRoomKey();
  assert.notEqual(first, second);
  assert.match(first, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(decodeKey(first).length, SEAL.keyBytes);
  assert.equal(encodeKey(decodeKey(first)), first);
});

test('HKDF expands the invite key to the 32 byte cipher key', async () => {
  const invite = newRoomKey();
  const first = await roomKey(invite);
  const again = await roomKey(invite);
  assert.equal(first.length, SEAL.subkeyBytes);
  assert.equal(asHex(first), asHex(again), 'the same invite derives the same key');
  const padded = new Uint8Array(SEAL.subkeyBytes);
  padded.set(decodeKey(invite));
  assert.notEqual(asHex(first), asHex(padded), 'HKDF is not zero padding');
  const other = await roomKey(newRoomKey());
  assert.notEqual(asHex(first), asHex(other));
});

test('an invite keeps the key in the fragment and out of the query', () => {
  const key = newRoomKey();
  const link = inviteLink('http://127.0.0.1:8787/room-b.html', { room: 'demo', key, name: 'Guest' });
  assert.equal(link.includes(`#k=${key}`), true);
  assert.equal(link.includes('k='), true);
  assert.equal(new URL(link).searchParams.has('k'), false, 'the key reached the query string');
  const read = readInvite(link);
  assert.equal(read.key, key);
  assert.equal(read.room, 'demo');
  assert.equal(read.url, 'http://127.0.0.1:8787/room-b.html?room=demo&name=Guest');
});

test('an invite without a key is refused', () => {
  assert.throws(() => readInvite('http://127.0.0.1:8787/room-b.html?room=demo'), /no room key/);
  assert.throws(() => readInvite('http://127.0.0.1:8787/room-b.html#k=not base64!'), /not base64url/);
  assert.throws(() => readInvite('not a url'), /not a URL/);
});

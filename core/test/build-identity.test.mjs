import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanBuild, createRoomClient } from '../sync.mjs';
import { decode, encode } from '../protocol.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('a build is a version plus a protocol and nothing guessed', () => {
  assert.deepEqual(cleanBuild({ version: '0.4.3', protocol: 1 }), {
    version: '0.4.3',
    protocol: 1,
  });
  assert.deepEqual(cleanBuild({ version: '  0.4.3  ' }), { version: '0.4.3', protocol: null });
  assert.equal(cleanBuild({}), null);
  assert.equal(cleanBuild('0.4.3'), null);
});

test('the host records a guest build and sends its own in the snapshot', () => {
  let local = 1000;
  const sent = [];
  const host = createRoomClient({
    role: 'host',
    peerId: 'host',
    hostId: 'host',
    now: () => local,
    build: { version: '0.4.3', protocol: 1 },
    send: (frame) => sent.push(decode(frame)),
  });

  host.receive(
    encode({
      type: 'hello',
      peerId: 'guest',
      name: 'Guest',
      build: { version: '0.3.21', protocol: 1 },
      roomTime: local,
    }),
    local
  );

  const guest = host.publish().peerList.find((peer) => peer.id === 'guest');
  assert.equal(guest.build.version, '0.3.21');
  const snapshot = sent.find((message) => message.type === 'snapshot');
  assert.equal(snapshot.build.version, '0.4.3');

  const peer = createRoomClient({
    role: 'peer',
    peerId: 'guest',
    hostId: 'host',
    now: () => local,
    build: { version: '0.3.21', protocol: 1 },
    send: () => {},
  });
  peer.receive(encode(snapshot), local);
  assert.equal(peer.publish().hostBuild.version, '0.4.3');
  assert.equal(peer.publish().build.version, '0.3.21');
});

test('the bridge entry and the browser check both expose the build', () => {
  const entry = fs.readFileSync(path.join(here, '..', 'browser-entry.mjs'), 'utf8');
  assert.match(entry, /build: bridgeBuild/);
  assert.match(entry, /getManifest/);
  const check = fs.readFileSync(path.join(here, '..', '..', 'zen', 'check-chrome.mjs'), 'utf8');
  assert.match(check, /data\.build\.version/);
});

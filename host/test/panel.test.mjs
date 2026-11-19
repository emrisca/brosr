import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decode, encode } from '../../core/protocol.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const state = await mkdtemp(path.join(tmpdir(), 'brosr-guest-panel-'));
process.env.BROSR_STATE = state;

const joinFile = path.join(state, 'join.json');
fs.writeFileSync(
  joinFile,
  JSON.stringify({
    joined: true,
    room: 'room-1',
    host: '127.0.0.1',
    port: 9,
    url: 'http://127.0.0.1:9/?role=peer&room=room-1',
    name: 'Guest',
    peer: 'guest-1',
    panelToken: 'guest-token',
  })
);

const { panelCommand } = await import(pathToFileURL(path.join(here, '..', 'panel.mjs')).href);
const RealWebSocket = globalThis.WebSocket;

class FakeSocket extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }

  send(frame) {
    const message = decode(String(frame));
    assert.equal(message.data.token, 'guest-token');
    assert.equal(message.data.action, 'status');
    assert.match(this.url, /role=panel/);
    const answer = encode({
      type: 'app',
      peerId: 'host',
      name: 'brosr-panel',
      data: {
        requestId: message.data.requestId,
        ok: true,
        state: {
          roomName: 'Movie night',
          hostId: 'host',
          role: 'peer',
          peerId: 'guest-1',
          room: 'room-1',
          peers: [{ id: 'guest-1', name: 'Guest', self: true, granted: false }],
          diagnostics: {
            room: 'room-1',
            roomName: 'Movie night',
            role: 'peer',
            peerId: 'guest-1',
            name: 'Guest',
            socket: 1,
            peers: 1,
            peerList: [{ id: 'guest-1', name: 'Guest', self: true, granted: false }],
            media: null,
            viewers: [],
            reading: null,
            readingReply: { ok: false, reason: 'no-media' },
          },
        },
      },
    });
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: answer })));
  }

  close() {}
}

test.after(async () => {
  globalThis.WebSocket = RealWebSocket;
  await rm(state, { recursive: true, force: true });
});

test('the guest panel reads join.json and sends its own token', async () => {
  globalThis.WebSocket = FakeSocket;
  const state = await panelCommand({ action: 'status' }, { guest: true });
  assert.equal(state.roomName, 'Movie night');
  assert.equal(state.hostId, 'host');
  assert.equal(state.peers.length, 1);
  assert.match(state.log, /^Brosr sync report/);
  assert.match(state.log, /Reading: unavailable \(no-media\)/);
});

test('a machine with no join file cannot read guest controls', async () => {
  fs.rmSync(joinFile, { force: true });
  await assert.rejects(() => panelCommand({ action: 'status' }, { guest: true }), /Join a room/);
});

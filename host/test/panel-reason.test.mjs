import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decode, encode } from '../../core/protocol.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const state = await mkdtemp(path.join(tmpdir(), 'brosr-panel-reason-'));
process.env.BROSR_STATE = state;
fs.writeFileSync(
  path.join(state, 'room.json'),
  JSON.stringify({
    room: 'room-1',
    host: '127.0.0.1',
    port: 9,
    url: 'http://127.0.0.1:9/?role=host&room=room-1',
    name: 'Host',
    peer: 'host',
    panelToken: 'host-token',
  })
);

const { panelCommand } = await import(pathToFileURL(path.join(here, '..', 'panel.mjs')).href);
const RealWebSocket = globalThis.WebSocket;

class RefusingSocket extends EventTarget {
  constructor() {
    super();
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }

  send(frame) {
    const message = decode(String(frame));
    const answer = encode({
      type: 'app',
      peerId: 'host',
      name: 'brosr-panel',
      data: {
        requestId: message.data.requestId,
        ok: false,
        reason: 'not-in-room',
        error: 'That person is no longer in the room.',
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

test('a refused panel command keeps its reason', async () => {
  globalThis.WebSocket = RefusingSocket;
  await assert.rejects(
    () =>
      panelCommand({
        action: 'grant',
        peerId: 'guest-1',
        allowed: true,
      }),
    (error) => {
      assert.match(error.message, /no longer in the room/);
      assert.equal(error.reason, 'not-in-room');
      return true;
    }
  );
});

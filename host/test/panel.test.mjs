import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openPanelPayload, sealPanelPayload } from '../../core/panel.mjs';
import { decode, encode } from '../../core/protocol.mjs';
import { newRoomKey, openFrame, roomKey, sealFrame } from '../../core/seal.mjs';

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
    const raw = String(frame);
    const message = decode(raw);
    assert.deepEqual(Object.keys(message.data), ['sealed']);
    assert.equal(raw.includes('guest-token'), false, 'raw panelToken never travels on the wire');
    assert.equal(raw.includes('status'), false, 'panel action stays sealed on the wire');
    const opened = openPanelPayload('guest-token', message.data, { room: 'room-1' });
    assert.equal(opened.ok, true);
    assert.equal(opened.payload.action, 'status');
    assert.match(this.url, /role=panel/);
    const answer = encode({
      type: 'app',
      peerId: 'host',
      name: 'brosr-panel',
      data: sealPanelPayload(
        'guest-token',
        {
          requestId: opened.payload.requestId,
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
        { room: 'room-1' }
      ),
    });
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: answer })));
  }

  close() {}
}

test.after(async () => {
  globalThis.WebSocket = RealWebSocket;
  await rm(state, { recursive: true, force: true });
});

test('the guest panel reads join.json and seals its request under panelToken', async () => {
  globalThis.WebSocket = FakeSocket;
  const state = await panelCommand({ action: 'status' }, { guest: true });
  assert.equal(state.roomName, 'Movie night');
  assert.equal(state.hostId, 'host');
  assert.equal(state.peers.length, 1);
  assert.match(state.log, /^Brosr sync report/);
  assert.match(state.log, /Reading: unavailable \(no-media\)/);
});

test('a room-key eavesdropper only sees opaque ciphertext and forged panel replies are ignored', async () => {
  const inviteKey = newRoomKey();
  const sharedRoomKey = await roomKey(inviteKey);
  const hostToken = 'host-panel-secret-999';
  const room = 'room-sealed';
  const runFile = path.join(state, 'room.json');
  fs.writeFileSync(
    runFile,
    JSON.stringify({
      room,
      host: '127.0.0.1',
      port: 9,
      url: `http://127.0.0.1:9/?role=host&room=${room}#k=${inviteKey}`,
      name: 'Host',
      peer: 'host',
      panelToken: hostToken,
    })
  );

  const observed = [];
  class EavesdroppedSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }

    send(frame) {
      // A room peer holds the shared room key and unseals the outer room frame.
      const roomPlain = new TextDecoder().decode(
        openFrame(sharedRoomKey, new Uint8Array(frame), { room })
      );
      observed.push({ dir: 'request', roomPlain });
      const req = decode(roomPlain);
      assert.deepEqual(Object.keys(req.data), ['sealed']);

      const opened = openPanelPayload(hostToken, req.data, { room });
      assert.equal(opened.ok, true);
      assert.equal(opened.payload.action, 'grant');
      assert.equal(opened.payload.peerId, 'guest-1');
      assert.equal(opened.payload.allowed, true);

      const sealRoom = (obj) =>
        sealFrame(sharedRoomKey, new TextEncoder().encode(encode(obj)), { room });

      // 1. Plaintext spoofed reply (no sealed envelope) -> must be ignored.
      const spoofedPlain = sealRoom({
        type: 'app',
        peerId: 'attacker',
        name: 'brosr-panel',
        data: {
          requestId: opened.payload.requestId,
          ok: false,
          reason: 'spoofed',
          error: 'spoofed plaintext refusal',
        },
      });
      // 2. Wrong-token sealed reply -> must be ignored.
      const wrongTokenReply = sealRoom({
        type: 'app',
        peerId: 'attacker',
        name: 'brosr-panel',
        data: sealPanelPayload(
          'wrong-panel-token',
          {
            requestId: opened.payload.requestId,
            ok: false,
            reason: 'wrong-token',
            error: 'spoofed wrong-token refusal',
          },
          { room }
        ),
      });
      // 3. Reflected copy of the panel's own sealed request -> must be ignored.
      const reflectedRequest = frame;

      // 4. Authentic host reply containing private unshared host tabs.
      const replyPlain = encode({
        type: 'app',
        peerId: 'host',
        name: 'brosr-panel',
        data: sealPanelPayload(
          hostToken,
          {
            requestId: opened.payload.requestId,
            ok: true,
            state: {
              roomName: 'Private Screening',
              hostId: 'host',
              role: 'host',
              peerId: 'host',
              room,
              peers: [{ id: 'guest-1', name: 'Guest', self: false, granted: true }],
              tabs: [
                {
                  id: 11,
                  url: 'https://private.bank.example/balances',
                  title: 'Private Balances',
                  shared: false,
                },
              ],
            },
          },
          { room }
        ),
      });
      observed.push({ dir: 'reply', roomPlain: replyPlain });
      const authenticReply = sealFrame(
        sharedRoomKey,
        new TextEncoder().encode(replyPlain),
        { room }
      );

      queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent('message', { data: spoofedPlain }));
        this.dispatchEvent(new MessageEvent('message', { data: wrongTokenReply }));
        this.dispatchEvent(new MessageEvent('message', { data: reflectedRequest }));
        this.dispatchEvent(new MessageEvent('message', { data: authenticReply }));
      });
    }

    close() {}
  }

  globalThis.WebSocket = EavesdroppedSocket;
  const result = await panelCommand({ action: 'grant', peerId: 'guest-1', allowed: true });
  assert.equal(result.roomName, 'Private Screening');
  assert.equal(result.tabs[0].url, 'https://private.bank.example/balances');
  assert.equal(observed.length, 2);

  for (const { dir, roomPlain } of observed) {
    const parsed = decode(roomPlain);
    assert.deepEqual(Object.keys(parsed.data), ['sealed'], `${dir} only carries sealed ciphertext`);
    assert.equal(roomPlain.includes(hostToken), false, `${dir} leaks no panelToken`);
    assert.equal(roomPlain.includes('grant'), false, `${dir} leaks no action`);
    assert.equal(roomPlain.includes('guest-1'), false, `${dir} leaks no peerId`);
    assert.equal(roomPlain.includes('private.bank.example'), false, `${dir} leaks no private tab URL`);
    assert.equal(roomPlain.includes('Private Balances'), false, `${dir} leaks no private tab title`);
  }
});

test('a machine with no join file cannot read guest controls', async () => {
  fs.rmSync(joinFile, { force: true });
  await assert.rejects(() => panelCommand({ action: 'status' }, { guest: true }), /Join a room/);
});

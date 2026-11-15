import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomClient } from '../sync.mjs';
import { electHost, PEER_TTL_MS } from '../room.mjs';
import { encode } from '../protocol.mjs';

// Three clients wired to one another with no socket. The fan-out stands in for
// the relay, and presence is what teaches each peer who else is in the room,
// exactly as it does on a real link.
function lanRoom(ids) {
  const clients = new Map();
  const sent = [];
  let clock = 1000;

  for (const id of ids) {
    clients.set(
      id,
      createRoomClient({
        role: id === ids[0] ? 'host' : 'peer',
        hostId: ids[0],
        peerId: id,
        room: 'lan',
        now: () => clock,
        send: (frame) => {
          sent.push({ from: id, message: JSON.parse(frame) });
          for (const [other, client] of clients) {
            if (other !== id) client.receive(frame, clock);
          }
        },
      })
    );
  }

  return {
    clients,
    sent,
    setNow: (value) => {
      clock = value;
    },
    // Every live peer publishes presence, which is how the room learns the
    // member list. A silent peer is left out on purpose.
    announce: (live = ids) => {
      for (const id of live) {
        clients.get(id).presence({ id, name: id, point: { x: 0, y: 0 } });
      }
    },
    tickAll: () => {
      for (const client of clients.values()) client.tick(clock);
    },
  };
}

test('election picks the smallest live id and ignores empty ones', () => {
  assert.equal(electHost(['zoe', 'alice', 'bob']), 'alice');
  assert.equal(electHost(['zoe']), 'zoe');
  assert.equal(electHost(['', null, 'moe', 'moe']), 'moe');
  assert.equal(electHost([]), null);
});

test('every peer names the same successor when the host says goodbye', () => {
  const room = lanRoom(['host', 'bob', 'zoe']);
  room.announce();
  const bye = encode({ type: 'bye', peerId: 'host', reason: 'closing' });
  for (const id of ['bob', 'zoe']) room.clients.get(id).receive(bye, 1000);

  assert.equal(room.clients.get('bob').publish().hostId, 'bob');
  assert.equal(room.clients.get('zoe').publish().hostId, 'bob');
  assert.equal(room.clients.get('bob').publish().role, 'host');
  assert.equal(room.clients.get('zoe').publish().role, 'peer');
  assert.equal(room.clients.get('zoe').publish().hostMigrations, 1);
});

test('the successor answers a hello with a snapshot', () => {
  const room = lanRoom(['host', 'bob', 'zoe']);
  room.announce();
  const bye = encode({ type: 'bye', peerId: 'host' });
  for (const id of ['bob', 'zoe']) room.clients.get(id).receive(bye, 1000);

  const snapshots = () =>
    room.sent.filter((entry) => entry.from === 'bob' && entry.message.type === 'snapshot').length;
  const before = snapshots();
  room.clients.get('bob').receive(encode({ type: 'hello', peerId: 'late', name: 'Late' }), 1000);
  assert.ok(before >= 1, 'the new host did not claim the room with a snapshot');
  assert.ok(snapshots() > before, 'the new host did not answer the hello');
});

test('a silent host is replaced once its presence times out', () => {
  const room = lanRoom(['host', 'bob', 'zoe']);
  room.announce();
  room.tickAll();
  assert.equal(room.clients.get('zoe').publish().hostId, 'host');

  // The host stops answering. The two peers keep announcing themselves, so
  // only the host ages out and only the host is missing from the room.
  room.setNow(1000 + PEER_TTL_MS + 1);
  room.announce(['bob', 'zoe']);
  room.tickAll();

  assert.equal(room.clients.get('bob').publish().hostId, 'bob');
  assert.equal(room.clients.get('bob').publish().role, 'host');
  assert.equal(room.clients.get('zoe').publish().role, 'peer');
  assert.equal(room.clients.get('zoe').publish().hostId, 'bob');
  assert.equal(room.clients.get('bob').publish().hostMigrations, 1);
});

test('a peer that leaves does not move the host', () => {
  const room = lanRoom(['host', 'bob', 'zoe']);
  room.announce();
  room.clients.get('bob').receive(encode({ type: 'bye', peerId: 'bob' }), 1000);
  room.clients.get('zoe').receive(encode({ type: 'bye', peerId: 'bob' }), 1000);
  assert.equal(room.clients.get('zoe').publish().hostId, 'host');
  assert.equal(room.clients.get('zoe').publish().role, 'peer');
  assert.equal(room.clients.get('zoe').publish().hostMigrations, 0);
});

test('a room with no peers left still names the last peer host', () => {
  const room = lanRoom(['host', 'bob']);
  room.clients.get('bob').receive(encode({ type: 'bye', peerId: 'host' }), 1000);
  assert.equal(room.clients.get('bob').publish().hostId, 'bob');
  assert.equal(room.clients.get('bob').publish().role, 'host');
});

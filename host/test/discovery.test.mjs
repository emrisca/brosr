import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverRooms, tailnetFromStatus, tailscaleBinaries } from '../discovery.mjs';

const status = {
  Self: { HostName: 'here' },
  Peer: {
    a: {
      HostName: 'living-room',
      Online: true,
      TailscaleIPs: ['fd7a:115c:a1e0::1', '100.101.2.3'],
    },
    b: {
      HostName: 'offline',
      Online: false,
      TailscaleIPs: ['100.101.2.4'],
    },
    c: {
      HostName: 'laptop',
      Online: true,
      TailscaleIPs: ['100.101.2.5'],
    },
  },
};

test('the tailnet parser prefers IPv4, keeps IPv6 and skips offline nodes', () => {
  const parsed = tailnetFromStatus(status);
  assert.equal(parsed.tailnet, true);
  assert.deepEqual(parsed.peers, [
    {
      host: '100.101.2.3',
      hosts: ['100.101.2.3', 'fd7a:115c:a1e0::1'],
      name: 'living-room',
    },
    { host: '100.101.2.5', hosts: ['100.101.2.5'], name: 'laptop' },
  ]);
});

test('a missing tailscale document is not a tailnet', () => {
  assert.equal(tailnetFromStatus(null), null);
  assert.equal(tailnetFromStatus({ Peer: {} }), null);
});

test('a mac checks the Apple silicon Homebrew tailscale path', () => {
  const binaries = tailscaleBinaries('darwin');
  const homebrew = binaries.indexOf('/opt/homebrew/bin/tailscale');
  assert.ok(homebrew >= 0, 'the Apple silicon Homebrew path is missing');
  assert.ok(homebrew < binaries.indexOf('/usr/local/bin/tailscale'));
});

test('discovery reads live rooms, rejects public links and removes duplicates', async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    const host = '100.101.2.3';
    return {
      ok: true,
      async json() {
        return {
          rooms: [
            {
              room: 'room-1',
              roomName: 'Movie night',
              host,
              port: 8787,
              address: `${host}:8787`,
              url: `http://${host}:8787/?room=room-1#k=key`,
              peers: 3,
            },
            {
              room: 'room-1',
              roomName: 'Movie night',
              host,
              port: 8787,
              address: `${host}:8787`,
              url: `http://${host}:8787/?room=room-1#k=key`,
              peers: 3,
            },
            {
              room: 'public',
              roomName: 'Not allowed',
              host: '8.8.8.8',
              port: 8787,
              address: '8.8.8.8:8787',
              url: 'http://8.8.8.8:8787/?room=public#k=key',
            },
          ],
        };
      },
    };
  };

  const found = await discoverRooms({ status: tailnetFromStatus(status), fetchImpl });
  assert.equal(found.tailnet, true);
  assert.equal(found.peers, 2);
  assert.equal(found.rooms.length, 1);
  assert.deepEqual(
    found.rooms.map((room) => room.roomName),
    ['Movie night']
  );
  assert.equal(requested.length, 3);
  assert.ok(requested.every((url) => url.endsWith(':8790/rooms')));
  assert.ok(requested.some((url) => url.includes('100.101.2.3:8790')));
  assert.ok(requested.some((url) => url.includes('[fd7a:115c:a1e0::1]:8790')));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedHost,
  isLoopbackHost,
  isPrivateHost,
  makeInvite,
  normalizeAddress,
  parseInviteLink,
  splitAddress,
  validateInvite,
} from '../friends.mjs';

test('loopback, private ranges and the tailnet are allowed', () => {
  for (const host of [
    '127.0.0.1',
    '127.8.9.10',
    'localhost',
    '::1',
    '10.0.0.5',
    '172.16.4.2',
    '172.31.255.1',
    '192.168.1.20',
    '100.64.0.1',
    '100.127.255.254',
    'fd7a:115c:a1e0::1',
    'box.tailnet.ts.net',
    'studio.local',
  ]) {
    assert.equal(isAllowedHost(host), true, host);
  }
});

test('a public address, a link local address and a plain name are refused', () => {
  for (const host of [
    '8.8.8.8',
    '203.0.113.9',
    '172.32.0.1',
    '192.169.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '169.254.10.10',
    'example.com',
    'not-tailnet.ts.net.example.com',
    '',
  ]) {
    assert.equal(isAllowedHost(host), false, host);
  }
  assert.equal(isLoopbackHost('10.0.0.1'), false);
  assert.equal(isPrivateHost('127.0.0.1'), false);
});

test('an address accepts a bare host, host:port and a URL with a scheme', () => {
  assert.equal(normalizeAddress('100.64.0.7'), '100.64.0.7:8790');
  assert.equal(normalizeAddress('100.64.0.7:9000'), '100.64.0.7:9000');
  assert.equal(normalizeAddress('http://100.64.0.7:8790/'), '100.64.0.7:8790');
  assert.equal(normalizeAddress('http://localhost'), 'localhost:8790');
  assert.deepEqual(splitAddress('[fd7a:115c:a1e0::1]:8790'), {
    host: 'fd7a:115c:a1e0::1',
    port: 8790,
  });
});

test('an address refuses a public host, a path and credentials', () => {
  assert.throws(() => normalizeAddress('https://example.com:8790'), /uses http/);
  assert.throws(() => normalizeAddress('http://8.8.8.8:8790'), /not a loopback/);
  assert.throws(() => normalizeAddress('http://100.64.0.7:8790/room'), /names no path/);
  assert.throws(() => normalizeAddress('http://user:pass@100.64.0.7:8790'), /credentials/);
  assert.throws(() => normalizeAddress('100.64.0.7:0'), /not a port/);
});

test('an invite link keeps the room key out of the query string', () => {
  const link = parseInviteLink(
    'http://100.64.0.7:8788/room-b.html?role=peer&room=room-abc&peer=guest-1&relay=8788#k=abc123'
  );
  assert.equal(link.host, '100.64.0.7');
  assert.equal(link.room, 'room-abc');
  assert.equal(link.relayPort, 8788);
  assert.equal(link.key, 'abc123');
  assert.equal(link.url.includes('k=abc123&'), false);
});

test('an invite link to a public host or with no key is refused', () => {
  assert.throws(
    () => parseInviteLink('http://example.com:8788/room-b.html?room=room-abc#k=abc123'),
    /not a loopback/
  );
  assert.throws(
    () => parseInviteLink('http://127.0.0.1:8788/room-b.html?room=room-abc'),
    /no room key/
  );
  assert.throws(() => parseInviteLink('http://127.0.0.1:8788/room-b.html#k=abc'), /no room/);
  assert.throws(() => parseInviteLink('https://127.0.0.1:8788/room-b.html?room=r#k=abc'), /uses http/);
});

test('an invite round trips, and a mismatched sender is refused', () => {
  const invite = makeInvite({
    from: '100.64.0.7:8790',
    name: 'Abel',
    url: 'http://100.64.0.7:8788/room-b.html?room=room-abc&relay=8788#k=abc123',
    createdAt: 1700000000000,
  });
  assert.match(invite.id, /^invite-[a-f0-9]{16}$/);
  assert.equal(invite.name, 'Abel');
  assert.equal(invite.room, 'room-abc');
  assert.equal(invite.from, '100.64.0.7:8790');
  assert.equal(invite.createdAt, 1700000000000);

  const reread = validateInvite({ ...invite, id: 'invite-12345678' });
  assert.equal(reread.room, 'room-abc');

  assert.throws(
    () =>
      validateInvite({
        ...invite,
        from: '100.64.0.8:8790',
      }),
    /name different hosts/
  );
  assert.throws(() => validateInvite({ ...invite, id: 'nope' }), /needs an id/);
});

test('a name with only spaces falls back to the sender address', () => {
  const invite = makeInvite({
    from: '127.0.0.1:8790',
    name: '   ',
    url: 'http://127.0.0.1:8788/room-b.html?room=room-abc&relay=8788#k=abc123',
  });
  assert.equal(invite.name, '127.0.0.1');
});

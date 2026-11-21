import test from 'node:test';
import assert from 'node:assert/strict';
import {
  forgetSharedTab,
  groupSharedTabs,
  MAX_SHARED_TABS,
  noteSharedMedia,
  rememberSharedTab,
  sharedTab,
  tabActionDecision,
  tabMedia,
} from '../live-tabs.mjs';

const film = 'https://www.youtube.com/watch?v=1';

test('an offer needs a key, an open action and a web URL', () => {
  assert.equal(sharedTab({ action: 'open', url: film }), null);
  assert.equal(sharedTab({ action: 'open', url: 'chrome://settings', key: 1 }), null);
  assert.equal(sharedTab({ action: 'close', url: film, key: 1 }), null);
  assert.equal(sharedTab(null), null);
});

test('an offer carries its title, owner and host role', () => {
  const offer = sharedTab(
    {
      action: 'open',
      url: film,
      key: 7,
      title: '  A   film\nwith a break  ',
      owner: 'Ana',
    },
    { from: 'host-1', hostId: 'host-1' }
  );
  assert.deepEqual(offer, {
    key: '7',
    url: film,
    title: 'A film with a break',
    owner: 'Ana',
    ownerId: 'host-1',
    role: 'host',
    playing: null,
  });
});

test('an offer carries the playback state its publisher reported', () => {
  const playing = sharedTab({ action: 'open', url: film, key: 1, playing: true });
  const paused = sharedTab({ action: 'open', url: film, key: 2, playing: false });
  assert.equal(playing.playing, true);
  assert.equal(paused.playing, false);
  // A tab without a player reports nothing, and the row keeps no badge.
  assert.equal(sharedTab({ action: 'open', url: film, key: 3 }).playing, null);
  assert.equal(sharedTab({ action: 'open', url: film, key: 3, playing: 'yes' }).playing, null);
});

test('a media frame updates one row and adds none', () => {
  const a = sharedTab({ action: 'open', url: film, key: 1, playing: false });
  const b = sharedTab({ action: 'open', url: 'https://example.com/', key: 2 });
  assert.deepEqual(tabMedia({ action: 'media', key: 1, playing: true }), {
    key: '1',
    playing: true,
  });
  assert.equal(tabMedia({ action: 'media', key: 1 }), null);
  assert.equal(tabMedia({ action: 'media', playing: true }), null);
  assert.equal(tabMedia({ action: 'close', key: 1, playing: true }), null);
  assert.equal(tabMedia(null), null);
  const list = noteSharedMedia([a, b], { key: '1', playing: true });
  assert.deepEqual(list.map((tab) => tab.playing), [true, null]);
  assert.equal(noteSharedMedia([a, b], { key: '9', playing: true }).length, 2);
  assert.equal(noteSharedMedia([a, b], null).length, 2);
});

test('a granted peer counts as control and a stranger cannot claim the host', () => {
  const peer = sharedTab(
    { action: 'open', url: film, key: '3', owner: 'Bo', role: 'host' },
    { from: 'peer-2', hostId: 'host-1' }
  );
  assert.equal(peer.role, 'control');
  assert.equal(peer.ownerId, 'peer-2');
});

test('a repeat share keeps one row and the newest row leads', () => {
  const first = sharedTab({ action: 'open', url: film, key: 7, owner: 'Ana' });
  const next = sharedTab({ action: 'open', url: film + '&t=2', key: 7, owner: 'Ana' });
  const list = rememberSharedTab(rememberSharedTab([], first), next);
  assert.equal(list.length, 1);
  assert.equal(list[0].url, film + '&t=2');
});

test('a close removes only the named key', () => {
  const a = sharedTab({ action: 'open', url: film, key: 1, owner: 'Ana' });
  const b = sharedTab({ action: 'open', url: 'https://example.com/', key: 2, owner: 'Bo' });
  const list = forgetSharedTab([a, b], '1');
  assert.deepEqual(list.map((tab) => tab.key), ['2']);
  assert.deepEqual(forgetSharedTab([a, b], '').map((tab) => tab.key), ['1', '2']);
});

test('groups hold one entry per owner and put the host first', () => {
  const host = sharedTab(
    { action: 'open', url: film, key: 1, owner: 'Ana' },
    { from: 'host-1', hostId: 'host-1' }
  );
  const peer = sharedTab(
    { action: 'open', url: 'https://example.com/', key: 2, owner: 'Bo' },
    { from: 'peer-2', hostId: 'host-1' }
  );
  const again = sharedTab(
    { action: 'open', url: 'https://example.com/next', key: 3, owner: 'Bo' },
    { from: 'peer-2', hostId: 'host-1' }
  );
  const groups = groupSharedTabs([peer, host, again], { hostId: 'host-1' });
  assert.equal(groups.length, 2);
  assert.equal(groups[0].owner, 'Ana');
  assert.equal(groups[0].role, 'host');
  assert.equal(groups[1].owner, 'Bo');
  assert.equal(groups[1].tabs.length, 2);
});

test('the list keeps a readable cap', () => {
  let list = [];
  for (let key = 0; key < MAX_SHARED_TABS + 5; key += 1) {
    list = rememberSharedTab(list, {
      key: String(key),
      url: 'https://example.com/' + key,
      owner: 'Ana',
    });
  }
  assert.equal(list.length, MAX_SHARED_TABS);
  assert.equal(list[0].key, String(MAX_SHARED_TABS + 4));
});

test('tabActionDecision enforces host/grant auth and ownerId with structured reasons (Guardrail #5)', () => {
  const hostOffer = sharedTab(
    { action: 'open', url: film, key: '964436478', owner: 'Host' },
    { from: 'host', hostId: 'host' }
  );
  const peerOffer = sharedTab(
    { action: 'open', url: 'https://example.com/', key: '200', owner: 'Bob' },
    { from: 'peer-1', hostId: 'host' }
  );
  const list = [hostOffer, peerOffer];

  // Ungranted peer cannot open, update media, or close any tab.
  assert.deepEqual(
    tabActionDecision({ action: 'open', key: 'evil', from: 'adv', hostId: 'host', granted: false, list }),
    { allow: false, reason: 'no-control' }
  );
  assert.deepEqual(
    tabActionDecision({ action: 'media', key: '964436478', from: 'adv', hostId: 'host', granted: false, list }),
    { allow: false, reason: 'no-control' }
  );
  assert.deepEqual(
    tabActionDecision({ action: 'close', key: '964436478', from: 'adv', hostId: 'host', granted: false, list }),
    { allow: false, reason: 'no-control' }
  );

  // Even a granted peer cannot overwrite, toggle media on, or close the host row.
  assert.deepEqual(
    tabActionDecision({ action: 'open', key: '964436478', from: 'peer-1', hostId: 'host', granted: true, list }),
    { allow: false, reason: 'not-owner' }
  );
  assert.deepEqual(
    tabActionDecision({ action: 'media', key: '964436478', from: 'peer-1', hostId: 'host', granted: true, list }),
    { allow: false, reason: 'not-owner' }
  );
  assert.deepEqual(
    tabActionDecision({ action: 'close', key: '964436478', from: 'peer-1', hostId: 'host', granted: true, list }),
    { allow: false, reason: 'not-owner' }
  );

  // Host and granted peer can manage their own entries.
  assert.deepEqual(
    tabActionDecision({ action: 'open', key: '964436478', from: 'host', hostId: 'host', granted: false, list }),
    { allow: true, reason: 'ok' }
  );
  assert.deepEqual(
    tabActionDecision({ action: 'close', key: '200', from: 'peer-1', hostId: 'host', granted: true, list }),
    { allow: true, reason: 'ok' }
  );
  assert.deepEqual(
    tabActionDecision({ action: 'open', key: '201', from: 'peer-1', hostId: 'host', granted: true, list }),
    { allow: true, reason: 'ok' }
  );
});

test('rememberSharedTab, forgetSharedTab, and noteSharedMedia enforce ownerId', () => {
  const hostOffer = sharedTab(
    { action: 'open', url: film, key: '10', owner: 'Host', playing: true },
    { from: 'host', hostId: 'host' }
  );
  const spoof = sharedTab(
    { action: 'open', url: 'https://evil.example/', key: '10', owner: 'Adv' },
    { from: 'adv', hostId: 'host' }
  );
  const afterOverwrite = rememberSharedTab([hostOffer], spoof);
  assert.equal(afterOverwrite.length, 1);
  assert.equal(afterOverwrite[0].url, film);
  assert.equal(afterOverwrite[0].ownerId, 'host');

  const afterClose = forgetSharedTab([hostOffer], '10', { ownerId: 'adv' });
  assert.equal(afterClose.length, 1);
  assert.equal(forgetSharedTab([hostOffer], '10', { ownerId: 'host' }).length, 0);

  const afterMedia = noteSharedMedia([hostOffer], { key: '10', playing: false }, { ownerId: 'adv' });
  assert.equal(afterMedia[0].playing, true);
  assert.equal(
    noteSharedMedia([hostOffer], { key: '10', playing: false }, { ownerId: 'host' })[0].playing,
    false
  );
});

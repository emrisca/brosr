import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  inputCaptureDecision,
  isLocalControl,
  isTabOpeningClick,
  isTabOpeningKey,
} from '../input.mjs';
import { encode } from '../protocol.mjs';
import { createRoomClient } from '../sync.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '..', '..');

function loadBackground() {
  let listener = null;
  const created = [];
  const updated = [];
  let nextId = 100;
  const tabsById = new Map();
  const api = {
    runtime: {
      onMessage: {
        addListener: (fn) => {
          listener = fn;
        },
      },
      getManifest: () => ({ version: '0.3.57' }),
    },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      session: { get: async () => ({}), set: async () => {} },
    },
    tabs: {
      onActivated: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
      query: async () => [...tabsById.values()],
      get: async (id) => tabsById.get(id) || null,
      create: async (opts) => {
        const tab = { id: nextId++, url: opts.url, active: Boolean(opts.active) };
        tabsById.set(tab.id, tab);
        created.push(tab);
        return tab;
      },
      update: async (id, opts) => {
        const existing = tabsById.get(id);
        if (!existing) throw new Error('missing');
        if (opts.url) existing.url = opts.url;
        updated.push({ id, ...opts });
        return existing;
      },
      remove: async (id) => {
        tabsById.delete(id);
      },
      sendMessage: async () => ({ ok: true }),
    },
  };
  const code = fs.readFileSync(path.join(rootDir, 'bridge', 'background.js'), 'utf8');
  vm.runInNewContext(code, {
    browser: api,
    chrome: api,
    URL,
    URLSearchParams,
    Set,
    Map,
    Promise,
    console,
    setTimeout,
    clearTimeout,
  });
  return {
    created,
    updated,
    tabsById,
    ask: (msg, sender = {}) => new Promise((resolve) => listener(msg, sender, resolve)),
  };
}

test('local controls and tab-opening clicks are refused before capture', () => {
  const live = { id: 'live-open-7' };
  live.closest = (selector) => (selector === '#live-tabs' ? live : null);
  const takeover = { id: 'host-takeover', getAttribute: (name) => (name === 'id' ? 'host-takeover' : ''), closest: () => null };
  const panel = { id: 'brosr-panel-button', getAttribute: (name) => (name === 'id' ? 'brosr-panel-button' : ''), closest: () => null };
  const same = {
    tagName: 'A',
    href: 'https://example.test/notes/',
    target: '_self',
    getAttribute: (name) => (name === 'href' ? 'https://example.test/notes/' : ''),
    closest: (selector) => (selector === 'a[href]' ? same : null),
  };
  const blank = {
    tagName: 'A',
    href: 'https://example.test/canvas/',
    target: '_blank',
    getAttribute: (name) =>
      name === 'target' ? '_blank' : name === 'href' ? 'https://example.test/canvas/' : '',
    closest: (selector) => (selector === 'a[href]' ? blank : null),
  };

  assert.equal(isLocalControl(live), true);
  assert.equal(isLocalControl(takeover), true);
  assert.equal(isLocalControl(panel), true);
  assert.equal(isTabOpeningClick(blank, { button: 0 }), true);
  assert.equal(isTabOpeningClick(same, { button: 1 }), true);
  assert.equal(isTabOpeningClick(same, { metaKey: true }), true);
  assert.equal(isTabOpeningKey(blank, { key: 'Enter' }), true);
  assert.equal(isTabOpeningKey(null, { key: 't', ctrl: true }), true);
  assert.equal(
    inputCaptureDecision({ event: { isTrusted: true, target: blank, button: 0 } }).reason,
    'new-tab'
  );
  assert.equal(
    inputCaptureDecision({ event: { isTrusted: true, target: live, button: 0 } }).reason,
    'local-control'
  );
});

test('background brosr:tab-open-local with updateOnly never creates a tab when copy is missing', async () => {
  const bg = loadBackground();

  // Remote follow update arrives for a key that has no local copy -> must NOT create a tab.
  const missing = await bg.ask({
    type: 'brosr:tab-open-local',
    url: 'https://example.test/episode-2',
    key: '99',
    updateOnly: true,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'no-copy');
  assert.equal(bg.created.length, 0);

  // Explicit local click ("Open" in Live tabs) creates the joined copy once.
  const opened = await bg.ask({
    type: 'brosr:tab-open-local',
    url: 'https://example.test/episode-1',
    key: '7',
    foreground: true,
  });
  assert.equal(opened.ok, true);
  assert.equal(bg.created.length, 1);

  // Remote navigation update with updateOnly: true updates the existing joined copy in place.
  const followed = await bg.ask({
    type: 'brosr:tab-open-local',
    url: 'https://example.test/episode-2',
    key: '7',
    updateOnly: true,
  });
  assert.equal(followed.ok, true);
  assert.equal(followed.updated, true);
  assert.equal(bg.created.length, 1, 'still only 1 tab created');
  assert.equal(bg.updated.at(-1).url, 'https://example.test/episode-2');

  // If the user closes their copy locally, a subsequent remote updateOnly follow does NOT reopen it.
  bg.tabsById.delete(opened.tabId);
  const afterClose = await bg.ask({
    type: 'brosr:tab-open-local',
    url: 'https://example.test/episode-3',
    key: '7',
    updateOnly: true,
  });
  assert.equal(afterClose.ok, false);
  assert.equal(afterClose.reason, 'no-copy');
  assert.equal(bg.created.length, 1, 'closed copy is never recreated by a remote update');
});

test('browser-entry never navigates remotely, and only the host navigates a guest', () => {
  const entry = fs.readFileSync(path.join(rootDir, 'core', 'browser-entry.mjs'), 'utf8');
  assert.doesNotMatch(entry, /location\.assign\(/, 'browser-entry never calls location.assign');
  assert.doesNotMatch(entry, /\bnavigate\b/, 'browser-entry passes no navigate callback');

  const hostNavs = [];
  const host = createRoomClient({
    role: 'host',
    peerId: 'host-1',
    hostId: 'host-1',
    navigate: (url) => hostNavs.push(url),
    send: () => {},
  });
  const onHost = host.receive(
    encode({ type: 'nav', from: 'peer-1', url: 'https://evil.test', roomTime: 1 })
  );
  assert.equal(onHost.ignored, 'host');
  assert.deepEqual(hostNavs, []);

  const peerNavs = [];
  const peer = createRoomClient({
    role: 'peer',
    peerId: 'peer-1',
    hostId: 'host-1',
    navigate: (url) => peerNavs.push(url),
    send: () => {},
  });
  assert.equal(
    peer.receive(encode({ type: 'nav', from: 'peer-2', url: 'https://evil.test', roomTime: 1 }))
      .ignored,
    'not-host'
  );
  assert.equal(
    peer.receive(encode({ type: 'nav', url: 'https://evil.test', roomTime: 1 })).ignored,
    'not-host'
  );
  assert.deepEqual(peerNavs, []);
});

test('a room client refuses DOM input frames and keeps no remote actuator', () => {
  const doc = {
    location: { href: 'http://127.0.0.1:8787/', origin: 'http://127.0.0.1:8787' },
    defaultView: { innerWidth: 1000, innerHeight: 700, addEventListener() {} },
    addEventListener() {},
    querySelectorAll: () => [],
    elementFromPoint: () => null,
  };
  const client = createRoomClient({
    role: 'host',
    peerId: 'host-1',
    hostId: 'host-1',
    document: doc,
    overlay: false,
    send: () => {},
  });

  const reply = client.receive(
    encode({
      type: 'input',
      peerId: 'peer-1',
      seq: 1,
      records: [{ kind: 'click', path: '#normal-btn', button: 0 }],
    }),
    1000
  );
  assert.deepEqual(reply, { ok: false, reason: 'input-disabled' });
  assert.equal(client.publish().input, null);
});

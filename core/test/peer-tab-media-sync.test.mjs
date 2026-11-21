import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRoomClient, HOST_PEER_APPLY_MS, HOST_PEER_JOIN_APPLY_MS } from '../sync.mjs';
import { decode, encode } from '../protocol.mjs';
import { tabSyncRequest } from '../live-tabs.mjs';
import {
  RemoteMediaSync,
  framePageHref,
  mediaKeyFor,
  pageKey,
} from '../media-relay.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bgSource = fs.readFileSync(path.join(here, '..', '..', 'bridge', 'background.js'), 'utf8');
const entrySource = fs.readFileSync(path.join(here, '..', 'browser-entry.mjs'), 'utf8');

const ANIDAP_WATCH = 'https://anidap.lol/watch?id=195516&ep=8&type=sub&provider=adp';
const ANIDAP_EMBED = 'https://aniembed.se/e/195516/8?lang=sub&autoplay=1&t=&hasPrev=1&hasNext=0';
const ANIDAP_KEY = pageKey(ANIDAP_WATCH);

function fakeVideo({
  src = 'blob:https://aniembed.se/232af866-bf09-4aef-a2f7-7c5b4b079b9e',
  currentTime = 0,
  duration = 1442,
  paused = true,
  readyState = 4,
} = {}) {
  return {
    src,
    currentSrc: src,
    duration,
    currentTime,
    paused,
    ended: false,
    seeking: false,
    readyState,
    playbackRate: 1,
    volume: 1,
    muted: false,
    buffered: { length: 1, start: () => 0, end: () => duration },
    play() {
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
    getAttribute(name) {
      return name === 'src' ? this.src : null;
    },
  };
}

function loadBackground({ tabs = [], tabReplies = new Map() } = {}) {
  const sent = [];
  let messageListener = null;
  let nextTabId = 500;
  const openTabs = new Map(tabs.map((tab) => [tab.id, { ...tab }]));

  const api = {
    storage: {
      session: { get: async () => ({}), set: async () => {} },
      local: { get: async () => ({}), set: async () => {} },
    },
    tabs: {
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
      onActivated: { addListener: () => {} },
      query: async () => [...openTabs.values()],
      get: async (id) => openTabs.get(id) || null,
      create: async ({ url, active }) => {
        const id = nextTabId++;
        const tab = { id, url, active: Boolean(active), title: url };
        openTabs.set(id, tab);
        return tab;
      },
      update: async (id, patch) => {
        const tab = openTabs.get(id);
        if (tab) Object.assign(tab, patch);
        return tab;
      },
      remove: async (id) => {
        openTabs.delete(id);
      },
      sendMessage: async (tabId, message) => {
        sent.push({ tabId, message });
        const handler = tabReplies.get(tabId);
        if (typeof handler === 'function') return handler(message);
        return { ok: true };
      },
    },
    runtime: {
      onMessage: {
        addListener: (fn) => {
          messageListener = fn;
        },
      },
      sendMessage: async () => ({ ok: true }),
    },
    commands: { onCommand: { addListener: () => {} } },
  };

  const ctx = { browser: api, URL, setTimeout, clearTimeout, console };
  vm.createContext(ctx);
  vm.runInContext(bgSource, ctx);
  return { sent, messageListener, openTabs };
}

function ask(listener, message, sender = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('background did not answer')), 1000);
    listener(message, sender, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
  });
}

test('tabSyncRequest validates peer-tab sync requests', () => {
  assert.deepEqual(tabSyncRequest({ action: 'sync', key: 42 }), { key: '42' });
  assert.equal(tabSyncRequest({ action: 'open', key: '42' }), null);
  assert.equal(tabSyncRequest({ action: 'sync' }), null);
  assert.equal(tabSyncRequest(null), null);
});

test('host joining a granted peer Anidap tab syncs to peer playhead even after slow HLS load and old YouTube greet', () => {
  let now = 10000;
  const hostSent = [];
  const peerSent = [];
  const hostMediaCalls = [];

  const host = createRoomClient({
    role: 'host',
    peerId: 'host-1',
    hostId: 'host-1',
    now: () => now,
    send: (frame) => hostSent.push(decode(frame)),
    onMedia: (message) => {
      hostMediaCalls.push(message);
      return true;
    },
  });
  host.setGrant('peer-1', true);

  const peer = createRoomClient({
    role: 'peer',
    peerId: 'peer-1',
    hostId: 'host-1',
    now: () => now,
    send: (frame) => peerSent.push(decode(frame)),
    onMedia: () => true,
  });
  peer.receive(encode({ type: 'control', from: 'host-1', peerId: 'peer-1', allowed: true }));

  // Peer is watching Anidap at 90s inside the aniembed.se cross-origin iframe.
  const peerVideo = fakeVideo({ currentTime: 90, paused: false });
  const peerHref = framePageHref({
    href: ANIDAP_EMBED,
    referrer: 'https://anidap.lol/',
    topUrl: ANIDAP_WATCH,
    embedded: true,
  });
  const peerKey = mediaKeyFor(peerVideo, { pageUrl: peerHref });
  assert.equal(peerKey, ANIDAP_KEY);
  assert.equal(peerKey, 'page:https://anidap.lol/watch?ep=8&id=195516');

  // Host clicks Join on Peer's Anidap tab -> Peer replies to the sync request with action: 'seek'.
  assert.equal(
    peer.sendMedia({
      key: peerKey,
      action: 'seek',
      position: 90,
      playing: true,
      rate: 1,
      volume: 1,
      buffering: false,
      ad: false,
    }),
    true
  );
  const syncFrame = peerSent.find((frame) => frame.type === 'media');
  assert.ok(syncFrame);
  host.receive(encode(syncFrame));

  // Host's earlier YouTube room greet fires 500 ms later while Anidap is still loading.
  // It must NOT wipe out the pending peer anchor for Anidap.
  now += 500;
  host.sendHostMedia(
    { key: 'youtube:old', position: 15, playing: false, rate: 1, action: false, at: now },
    now
  );
  assert.ok(host.pendingPeerMedia(ANIDAP_KEY, now), 'unrelated greet must keep pending peer sync');

  // 4 seconds later (> HOST_PEER_APPLY_MS, < HOST_PEER_JOIN_APPLY_MS), Host's joined Anidap tab
  // finishes loading at 0:00 paused.
  now += HOST_PEER_APPLY_MS + 1500;
  assert.ok(now - 10000 < HOST_PEER_JOIN_APPLY_MS);

  const clobbered = host.sendHostMedia(
    {
      key: ANIDAP_KEY,
      position: 0,
      playing: false,
      rate: 1,
      volume: 1,
      buffering: false,
      action: false,
      at: now,
    },
    now
  );
  assert.equal(clobbered, false, 'host must not broadcast unplayed 0:00 over peer');

  // Host room tab reads pendingPeerMedia and re-applies it onto the newly loaded Anidap iframe.
  const pending = host.pendingPeerMedia(ANIDAP_KEY, now);
  assert.ok(pending);
  assert.ok(Math.abs(pending.position - 94.5) < 0.2, `expected ~94.5s, got ${pending.position}`);
  assert.equal(pending.playing, true);

  const hostVideo = fakeVideo({ currentTime: 0, paused: true });
  const hostSync = new RemoteMediaSync({
    document: { querySelector: () => hostVideo },
    href: ANIDAP_WATCH,
    hostname: 'aniembed.se',
    pageHref: () => ANIDAP_WATCH,
    now: () => now,
  });
  const applied = hostSync.handle({
    key: pending.key,
    action: 'seek',
    position: pending.position,
    playing: pending.playing,
    rate: pending.rate,
    rev: pending.rev,
    at: now,
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.action, 'seek');
  assert.ok(Math.abs(hostVideo.currentTime - 94.5) < 0.2);
  assert.equal(hostVideo.paused, false);

  // Next 250 ms tick: Host's Anidap tab is caught up, pendingPeerMedia clears, and host ticks live.
  now += 250;
  hostVideo.currentTime += 0.25;
  const resumed = host.sendHostMedia(
    {
      key: ANIDAP_KEY,
      position: hostVideo.currentTime,
      playing: true,
      rate: 1,
      volume: 1,
      buffering: false,
      action: false,
      at: now,
    },
    now
  );
  assert.equal(resumed, true);
  assert.equal(host.pendingPeerMedia(ANIDAP_KEY, now), null);
});

test('background queries published tab media state and lets active joined paused tabs reach host room tab', async () => {
  const peerAnidapState = {
    key: ANIDAP_KEY,
    position: 90,
    duration: 1442,
    playing: true,
    rate: 1,
    volume: 1,
    buffering: false,
    ad: false,
    at: Date.now(),
  };

  // Peer browser: tab 1 is room tab, tab 42 is published Anidap tab.
  const peerBg = loadBackground({
    tabs: [
      { id: 1, url: 'http://127.0.0.1:8787/?room=r1&peer=peer-1&role=peer', active: false },
      { id: 42, url: ANIDAP_WATCH, active: true, title: 'Anidap Ep 8' },
    ],
    tabReplies: new Map([
      [
        42,
        (msg) => {
          if (msg.type === 'brosr:media-read') return { ok: true, state: peerAnidapState };
          return { ok: true };
        },
      ],
    ]),
  });

  await ask(
    peerBg.messageListener,
    { type: 'brosr:room-hello', role: 'peer', granted: true },
    { tab: { id: 1, url: 'http://127.0.0.1:8787/?room=r1&peer=peer-1&role=peer' } }
  );
  await ask(peerBg.messageListener, { type: 'brosr:tab-share', tabId: 42, shared: true });

  const snapshot = await ask(peerBg.messageListener, {
    type: 'brosr:tab-media-state',
    key: '42',
  });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.state.key, ANIDAP_KEY);
  assert.equal(snapshot.state.position, 90);

  // Unknown tab key is refused cleanly.
  const missing = await ask(peerBg.messageListener, {
    type: 'brosr:tab-media-state',
    key: '999',
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'no-tab');

  // Host browser: previously focused on youtube:old, then joins peer tab key '42' in foreground.
  const hostBg = loadBackground({
    tabs: [
      { id: 10, url: 'http://127.0.0.1:8787/?room=r1&peer=host-1&role=host', active: false },
      { id: 20, url: 'https://www.youtube.com/watch?v=old', active: false },
    ],
  });
  await ask(
    hostBg.messageListener,
    { type: 'brosr:room-hello', role: 'host' },
    { tab: { id: 10, url: 'http://127.0.0.1:8787/?room=r1&peer=host-1&role=host' } }
  );
  // Seed mediaFocus with YouTube playing.
  await ask(
    hostBg.messageListener,
    { type: 'brosr:media-out', state: { key: 'youtube:old', position: 10, playing: true } },
    { tab: { id: 20, active: false } }
  );

  // Host joins Peer's Anidap tab in foreground -> creates tab 500 mapped to remote key '42'.
  const joined = await ask(hostBg.messageListener, {
    type: 'brosr:tab-open-local',
    url: ANIDAP_WATCH,
    key: '42',
    foreground: true,
  });
  assert.equal(joined.ok, true);
  const joinedTabId = joined.tabId;

  // Joined Anidap tab loads paused at 0:00 while active -> must reach room tab with joinedKey: '42'.
  const out = await ask(
    hostBg.messageListener,
    {
      type: 'brosr:media-out',
      state: { key: ANIDAP_KEY, position: 0, playing: false, action: false },
    },
    { tab: { id: joinedTabId, active: true } }
  );
  assert.equal(out.ok, true);
  assert.equal(out.skipped, undefined);
  const forwarded = hostBg.sent.find(
    (entry) =>
      entry.tabId === 10 &&
      entry.message &&
      entry.message.type === 'brosr:media-state' &&
      entry.message.state &&
      entry.message.state.key === ANIDAP_KEY
  );
  assert.ok(forwarded, 'active joined paused tab must forward media-state to host room tab');
  assert.equal(forwarded.message.joinedKey, '42');

  // An inactive background paused tab with no action is still skipped.
  const bgPaused = await ask(
    hostBg.messageListener,
    {
      type: 'brosr:media-out',
      state: { key: 'youtube:old', position: 10, playing: false, action: false },
    },
    { tab: { id: 20, active: false } }
  );
  assert.equal(bgPaused.skipped, 'background');

  // An explicit paused seek on a tab is never dropped as background.
  const explicitSeek = await ask(
    hostBg.messageListener,
    {
      type: 'brosr:media-out',
      state: { key: 'youtube:old', position: 55, playing: false, action: 'seek' },
    },
    { tab: { id: 20, active: false } }
  );
  assert.equal(explicitSeek.ok, true);
  assert.equal(explicitSeek.skipped, undefined);
});

test('browser-entry refreshes embedded topUrl after listener registration and ignores wrapper media events', () => {
  assert.match(entrySource, /if \(embedded\) refreshTopUrl\(1000\)\.catch\(\(\) => \{\}\);/);
  assert.match(entrySource, /if \(message\.type === 'brosr:media-read'\)/);
  assert.match(entrySource, /if \(event && event\.target && video && event\.target !== video\) return;/);
  assert.match(entrySource, /client\.sendApp\(TAB_APP, \{ action: 'sync', key: offer\.key \}\)/);
});

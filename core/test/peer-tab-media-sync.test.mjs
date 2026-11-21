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

test('host joining a peer Anidap tab syncs to peer playhead even after slow HLS load and old YouTube greet', () => {
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

  const peer = createRoomClient({
    role: 'peer',
    peerId: 'peer-1',
    hostId: 'host-1',
    now: () => now,
    send: (frame) => peerSent.push(decode(frame)),
    onMedia: () => true,
  });

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
    { type: 'brosr:room-hello', role: 'peer' },
    { tab: { id: 1, url: 'http://127.0.0.1:8787/?room=r1&peer=peer-1&role=peer' } }
  );
  await ask(peerBg.messageListener, { type: 'brosr:tab-share', tabId: 42, shared: true });
  // The hello sweep and the explicit share can name the same tab, so wait for
  // the announcement to land before reading its media state.
  await new Promise((resolve) => setTimeout(resolve, 20));

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

test('host joining a paused peer tab after recent host act on another film still syncs paused position', () => {
  let now = 20000;
  const hostSent = [];
  const peerSent = [];
  const hostRelayed = [];

  const host = createRoomClient({
    role: 'host',
    peerId: 'host-1',
    hostId: 'host-1',
    now: () => now,
    send: (frame) => hostSent.push(JSON.parse(frame)),
    overlay: false,
    onMedia: (frame) => {
      hostRelayed.push(frame);
      return true;
    },
  });
  const peer = createRoomClient({
    role: 'peer',
    peerId: 'peer-1',
    name: 'Alice',
    hostId: 'host-1',
    now: () => now,
    send: (frame) => peerSent.push(JSON.parse(frame)),
    overlay: false,
  });

  host.receive(encode({ type: 'hello', peerId: 'peer-1', name: 'Alice', roomTime: now }), now);

  // Host was actively watching YouTube and just paused it 100ms ago (mediaRev = 1, lastHostActAt = now).
  host.sendHostMedia(
    { key: 'youtube:old', position: 60, playing: false, action: 'pause', rate: 1, at: now },
    now
  );

  // 100ms later (inside HOST_MEDIA_PRIORITY_MS for youtube:old!), Host joins Peer's paused Anidap tab.
  // Peer has NOT seen Host's youtube:old pause yet (so Peer sends rev: 1 for ANIDAP_KEY!).
  now += 100;
  peer.sendMedia({
    key: ANIDAP_KEY,
    action: 'seek',
    position: 255,
    playing: false,
    rate: 1,
    volume: 1,
    buffering: false,
    ad: false,
  });
  const syncFrame = peerSent.find((f) => f.type === 'media');
  const accepted = host.receive(encode(syncFrame), now);
  assert.equal(accepted.relayed, true, 'different-film join sync must not be dropped by youtube host-priority or stale-rev');

  // 5 seconds later, Host's Anidap iframe loads auto-playing at 0:00 -> must NOT clobber Peer's paused 255s!
  now += 5000;
  const clobbered = host.sendHostMedia(
    { key: ANIDAP_KEY, position: 0, playing: true, rate: 1, volume: 1, buffering: false, action: false, at: now },
    now
  );
  assert.equal(clobbered, false, 'host must hold paused peer anchor until joined tab pauses & seeks to 255s');

  const pending = host.pendingPeerMedia(ANIDAP_KEY, now);
  assert.ok(pending);
  assert.equal(pending.playing, false);
  assert.equal(pending.position, 255);
});

test('peer B joining peer A offered tab syncs even when host has not joined that tab', () => {
  let now = 30000;
  const hostSent = [];
  const peerASent = [];
  const peerBRelayed = [];

  const host = createRoomClient({
    role: 'host',
    peerId: 'host-1',
    hostId: 'host-1',
    now: () => now,
    send: (frame) => hostSent.push(frame),
    overlay: false,
    onMedia: () => true,
  });
  const peerA = createRoomClient({
    role: 'peer',
    peerId: 'peer-a',
    name: 'Alice',
    hostId: 'host-1',
    now: () => now,
    send: (frame) => peerASent.push(frame),
    overlay: false,
  });
  const peerB = createRoomClient({
    role: 'peer',
    peerId: 'peer-b',
    name: 'Bob',
    hostId: 'host-1',
    now: () => now,
    send: () => {},
    overlay: false,
    onMedia: (frame) => {
      peerBRelayed.push(frame);
      return true;
    },
  });

  host.receive(encode({ type: 'hello', peerId: 'peer-a', name: 'Alice', roomTime: now }), now);
  host.receive(encode({ type: 'hello', peerId: 'peer-b', name: 'Bob', roomTime: now }), now);
  while (hostSent.length) {
    const f = hostSent.shift();
    peerA.receive(f, now);
    peerB.receive(f, now);
  }

  // Host is watching YouTube (never joins Anidap) and bumped mediaRev to 3.
  for (let i = 1; i <= 3; i += 1) {
    now += 600;
    host.sendHostMedia({ key: 'youtube:hostOnly', position: i * 20, playing: true, action: 'seek', rate: 1, at: now }, now);
    while (hostSent.length) {
      const f = hostSent.shift();
      peerB.receive(f, now);
      // Peer A missed the last tick so Peer A rev is behind Host!
      if (i < 3) peerA.receive(f, now);
    }
  }

  // Peer B clicks Join on Peer A's Anidap tab -> Peer A replies with live Anidap state (playing at 330s).
  now += 200;
  peerA.sendMedia({
    key: ANIDAP_KEY,
    action: 'seek',
    position: 330,
    playing: true,
    rate: 1,
    volume: 1,
    buffering: false,
    ad: false,
  });
  while (peerASent.length) {
    const f = peerASent.shift();
    host.receive(f, now);
    peerB.receive(f, now);
  }
  // Host relays the Anidap state even though Host has NOT opened Anidap.
  while (hostSent.length) {
    peerB.receive(hostSent.shift(), now);
  }

  const anidapFrame = peerBRelayed.filter((f) => f.key === ANIDAP_KEY).at(-1);
  assert.ok(anidapFrame, 'peer B must receive Anidap playback state even when host has not joined Anidap');
  assert.ok(Math.abs(anidapFrame.expected - 330) < 0.5, `expected ~330s, got ${anidapFrame.expected}`);
  assert.equal(anidapFrame.playing, true);
});

test('background falls back to cached tab media state when brosr:media-read races/times out and emits brosr:media-mounted for joined tabs', async () => {
  const peerBg = loadBackground({
    tabs: [
      { id: 1, url: 'http://127.0.0.1:8787/?room=r1&peer=peer-1&role=peer', active: false },
      { id: 42, url: ANIDAP_WATCH, active: true, title: 'Anidap Ep 8' },
    ],
    tabReplies: new Map([
      // Simulate cross-origin iframe race: brosr:media-read returns null (no-media / timeout).
      [42, () => null],
    ]),
  });

  await ask(
    peerBg.messageListener,
    { type: 'brosr:room-hello', role: 'peer' },
    { tab: { id: 1, url: 'http://127.0.0.1:8787/?room=r1&peer=peer-1&role=peer' } }
  );
  await ask(peerBg.messageListener, { type: 'brosr:tab-share', tabId: 42, shared: true });

  // Tab 42 previously reported live media state via brosr:media-out (paused at 255s).
  await ask(
    peerBg.messageListener,
    {
      type: 'brosr:media-out',
      state: {
        key: ANIDAP_KEY,
        position: 255,
        duration: 1442,
        playing: false,
        rate: 1,
        volume: 1,
        buffering: false,
        ad: false,
        at: Date.now() - 500,
      },
    },
    { tab: { id: 42, active: true } }
  );

  // Even though brosr:media-read returned null, brosr:tab-media-state falls back to cached state!
  const cachedPaused = await ask(peerBg.messageListener, {
    type: 'brosr:tab-media-state',
    key: '42',
  });
  assert.equal(cachedPaused.ok, true);
  assert.equal(cachedPaused.cached, true);
  assert.equal(cachedPaused.state.key, ANIDAP_KEY);
  assert.equal(cachedPaused.state.position, 255);
  assert.equal(cachedPaused.state.playing, false);

  // Playing cached state projects position forward when brosr:media-read returns null.
  await ask(
    peerBg.messageListener,
    {
      type: 'brosr:media-out',
      state: {
        key: ANIDAP_KEY,
        position: 300,
        duration: 1442,
        playing: true,
        rate: 1,
        volume: 1,
        buffering: false,
        ad: false,
        at: Date.now() - 1000,
      },
    },
    { tab: { id: 42, active: true } }
  );
  const cachedPlaying = await ask(peerBg.messageListener, {
    type: 'brosr:tab-media-state',
    key: '42',
  });
  assert.equal(cachedPlaying.ok, true);
  assert.equal(cachedPlaying.cached, true);
  assert.ok(cachedPlaying.state.position >= 300.8 && cachedPlaying.state.position <= 303, `expected ~301s, got ${cachedPlaying.state.position}`);

  // Peer B browser joins tab key '42'; even if the joined tab is not active when its iframe mounts,
  // brosr:media-hello notifies the room tab with brosr:media-mounted.
  const joinerBg = loadBackground({
    tabs: [
      { id: 10, url: 'http://127.0.0.1:8787/?room=r1&peer=peer-2&role=peer', active: true },
    ],
  });
  await ask(
    joinerBg.messageListener,
    { type: 'brosr:room-hello', role: 'peer' },
    { tab: { id: 10, url: 'http://127.0.0.1:8787/?room=r1&peer=peer-2&role=peer' } }
  );
  const joined = await ask(joinerBg.messageListener, {
    type: 'brosr:tab-open-local',
    url: ANIDAP_WATCH,
    key: '42',
    foreground: false,
  });
  assert.equal(joined.ok, true);
  await ask(
    joinerBg.messageListener,
    { type: 'brosr:media-hello', key: ANIDAP_KEY },
    { tab: { id: joined.tabId, active: false } }
  );
  const mounted = joinerBg.sent.find(
    (entry) =>
      entry.tabId === 10 &&
      entry.message &&
      entry.message.type === 'brosr:media-mounted' &&
      entry.message.key === ANIDAP_KEY &&
      entry.message.joinedKey === '42'
  );
  assert.ok(mounted, 'joined tab media-hello must notify room tab with brosr:media-mounted');
});

test('browser-entry guards seeking drags, caches roomMediaByKey, and re-applies on brosr:media-mounted for peer joiners', () => {
  assert.match(entrySource, /document\.addEventListener\(\s*'seeking'/);
  assert.match(entrySource, /remote\.noteLocalSeeking\(\)/);
  assert.match(entrySource, /roomMediaByKey/);
  assert.match(entrySource, /message\.type === 'brosr:media-mounted'/);
});

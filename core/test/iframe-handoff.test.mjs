// A streaming site often puts its player inside a generic cross-origin iframe
// (like Miruro's strm.cx/?embed=1) whose own URL and stripped referrer never
// name the episode. These tests cover the full boundary: pageKey preserving
// canonical title/episode query parameters, framePageHref preferring the
// browser tab URL from the bridge background while preserving YouTube embeds,
// quality switches across HLS/DASH/blob sources, deliberate 600 ms delay
// recovery without a seek loop, and the real background script's brosr:tab-url
// query and navigation push.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  PAGE_KEY_PREFIX,
  RemoteMediaSync,
  filmUrl,
  framePageHref,
  mediaKeyFor,
  mediaStateFromDocument,
  pageKey,
} from '../media-relay.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bgSource = fs.readFileSync(
  path.join(here, '..', '..', 'bridge', 'background.js'),
  'utf8'
);

const MIRURO_EP3 = 'https://www.miruro.cx/watch?id=16498&ep=3&server=kiwi';
const MIRURO_EP3_REORDERED = 'https://www.miruro.cx/watch?ep=3&id=16498&t=120';
const MIRURO_EP4 = 'https://www.miruro.cx/watch?id=16498&ep=4';
const GENERIC_EMBED = 'https://strm.cx/?embed=1';
const YT_EMBED = 'https://www.youtube.com/embed/aqz-KE-bpKQ';

function fakeVideo({
  src = 'https://cdn.example/hls/720p.m3u8?token=abc',
  currentTime = 0,
  duration = 1440,
  paused = true,
  readyState = 4,
  playbackRate = 1,
  volume = 1,
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
    playbackRate,
    volume,
    buffered: { length: 1, start: () => 0, end: () => duration },
    plays: 0,
    pauses: 0,
    play() {
      this.paused = false;
      this.plays += 1;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
      this.pauses += 1;
    },
    getAttribute(name) {
      return name === 'src' ? this.src : null;
    },
  };
}

function fakeDoc(video) {
  return {
    querySelector(selector) {
      return selector === 'video.html5-main-video, video' ? video : null;
    },
  };
}

function loadBackground() {
  const sent = [];
  const updatedListeners = [];
  let messageListener = null;

  const api = {
    storage: {
      session: {
        get: async () => ({}),
        set: async () => {},
      },
      local: {
        get: async () => ({}),
        set: async () => {},
      },
    },
    tabs: {
      onUpdated: { addListener: (fn) => updatedListeners.push(fn) },
      onRemoved: { addListener: () => {} },
      onActivated: { addListener: () => {} },
      query: async () => [],
      get: async () => null,
      create: async ({ url }) => ({ id: 99, url, active: false }),
      update: async () => {},
      remove: async () => {},
      sendMessage: async (tabId, message) => {
        sent.push({ tabId, message });
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

  const ctx = {
    browser: api,
    URL,
    setTimeout,
    clearTimeout,
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(bgSource, ctx);

  return { sent, updatedListeners, messageListener };
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

test('pageKey keeps canonical episode identity params and drops noise params', () => {
  const k3a = pageKey(MIRURO_EP3);
  const k3b = pageKey(MIRURO_EP3_REORDERED);
  const k4 = pageKey(MIRURO_EP4);

  assert.equal(k3a, `${PAGE_KEY_PREFIX}https://www.miruro.cx/watch?ep=3&id=16498`);
  assert.equal(k3b, k3a, 'reordered params and timestamp/server noise collapse to one key');
  assert.notEqual(k4, k3a, 'two episodes never collide on one key');
  assert.equal(filmUrl(k3a), 'https://www.miruro.cx/watch?ep=3&id=16498');
});

test('framePageHref uses topUrl for generic embeds and preserves YouTube embeds', () => {
  assert.equal(
    framePageHref({
      href: GENERIC_EMBED,
      referrer: 'https://www.miruro.cx/',
      topUrl: MIRURO_EP3,
      embedded: true,
    }),
    MIRURO_EP3
  );
  assert.equal(
    framePageHref({
      href: GENERIC_EMBED,
      referrer: '',
      topUrl: MIRURO_EP3,
      embedded: true,
    }),
    MIRURO_EP3
  );
  assert.equal(
    framePageHref({
      href: YT_EMBED,
      referrer: 'https://blog.example/post',
      topUrl: 'https://blog.example/post',
      embedded: true,
    }),
    YT_EMBED,
    'a YouTube embed keeps its own video url'
  );
});

test('a generic embed iframe follows episode changes and survives an HLS/DASH quality switch', () => {
  let currentTop = MIRURO_EP3;
  const video = fakeVideo({
    src: 'https://cdn.example/hls/720p.m3u8?token=one',
    currentTime: 0,
    paused: true,
  });
  const doc = fakeDoc(video);
  let now = 10000;

  const pageHref = () =>
    framePageHref({
      href: GENERIC_EMBED,
      referrer: '',
      topUrl: currentTop,
      embedded: true,
    });

  const sync = new RemoteMediaSync({
    document: doc,
    href: pageHref(),
    hostname: 'strm.cx',
    pageHref,
    now: () => now,
  });

  const ep3Key = pageKey(MIRURO_EP3);
  const first = sync.handle({ key: ep3Key, position: 120, playing: true, rate: 1, at: now });
  assert.equal(first.action, 'seek');
  assert.equal(video.currentTime, 120);
  assert.equal(video.paused, false);

  // Quality switch mid-playback from 720p HLS -> 1080p DASH -> MediaSource blob.
  video.src = 'https://cdn.example/dash/1080p.mpd?token=two';
  video.currentSrc = video.src;
  assert.equal(mediaKeyFor(video, { pageUrl: pageHref() }), ep3Key);

  video.src = 'blob:https://strm.cx/99aa';
  video.currentSrc = video.src;
  now += 2000;
  video.currentTime = 122.05;
  const afterSwitch = sync.handle({
    key: ep3Key,
    position: 122,
    playing: true,
    rate: 1,
    at: now,
  });
  assert.equal(afterSwitch.ok, true);
  assert.equal(afterSwitch.action, 'tick', 'quality switch keeps the same key with no spurious seek');
  assert.equal(sync.stats.seeks, 1);

  // Episode 4 frame is ignored while the tab is still on episode 3.
  const ep4Key = pageKey(MIRURO_EP4);
  const wrongEp = sync.handle({ key: ep4Key, position: 10, playing: true, rate: 1, at: now });
  assert.equal(wrongEp.ok, false);
  assert.equal(wrongEp.reason, 'key');

  // Top tab SPA-navigates to episode 4; the same iframe now follows episode 4.
  currentTop = MIRURO_EP4;
  now += 1000;
  const state4 = mediaStateFromDocument(doc, pageHref(), 'strm.cx');
  assert.equal(state4.key, ep4Key);
  const follow4 = sync.handle({ key: ep4Key, position: 10, playing: true, rate: 1, at: now });
  assert.equal(follow4.action, 'seek');
  assert.equal(video.currentTime, 10);
});

test('a deliberate 600 ms frame delay settles without a seek loop', () => {
  const video = fakeVideo({ currentTime: 50, paused: false });
  const doc = fakeDoc(video);
  let now = 20000;
  const ep3Key = pageKey(MIRURO_EP3);
  const sync = new RemoteMediaSync({
    document: doc,
    href: GENERIC_EMBED,
    hostname: 'strm.cx',
    pageHref: () => MIRURO_EP3,
    now: () => now,
  });

  // Prime in sync.
  sync.handle({ key: ep3Key, position: 50, playing: true, rate: 1, at: now });
  const baselineSeeks = sync.stats.seeks;

  // Frame emitted 600 ms earlier at position 52 arrives at now = 22600 (expected 52.6).
  // The local player only reached 51.0 (a 1.6 s gap): one seek lands at 52.6,
  // and subsequent delayed ticks stay within tolerance with zero additional seeks.
  now = 22600;
  video.currentTime = 51.0;
  const caught = sync.handle({ key: ep3Key, position: 52.0, playing: true, rate: 1, at: now - 600 });
  assert.equal(caught.action, 'seek');
  assert.ok(Math.abs(video.currentTime - 52.6) < 0.01);

  for (let i = 1; i <= 12; i += 1) {
    now += 250;
    video.currentTime += 0.25 * video.playbackRate;
    const hostPos = 52.6 + i * 0.25 - 0.6;
    const step = sync.handle({ key: ep3Key, position: hostPos, playing: true, rate: 1, at: now - 600 });
    assert.notEqual(step.action, 'seek', `tick ${i} must not re-seek`);
  }
  assert.equal(sync.stats.seeks, baselineSeeks + 1, 'a 600 ms delay causes at most one seek');
});

test('background answers brosr:tab-url for subframes and pushes URL updates on navigation', async () => {
  const { sent, updatedListeners, messageListener } = loadBackground();

  const reply = await ask(
    messageListener,
    { type: 'brosr:tab-url' },
    { tab: { id: 42, url: MIRURO_EP3 } }
  );
  assert.equal(reply.ok, true);
  assert.equal(reply.url, MIRURO_EP3);

  const missing = await ask(messageListener, { type: 'brosr:tab-url' }, {});
  assert.equal(missing.ok, false);

  for (const fn of updatedListeners) {
    fn(42, { url: MIRURO_EP4 }, { id: 42, url: MIRURO_EP4, active: true });
  }
  const pushed = sent.find(
    (entry) => entry.tabId === 42 && entry.message && entry.message.type === 'brosr:tab-url'
  );
  assert.ok(pushed, 'background pushes the new tab URL to its frames on SPA navigation');
  assert.equal(pushed.message.url, MIRURO_EP4);
});

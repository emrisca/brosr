// Sync client behaviour that needs no browser: a media message against a fake
// element, with a clock the test controls.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bufferedAround,
  createRoomClient,
  SEEK_BUFFER_WAIT_MS,
  SEEK_SETTLE_MS,
  SEEK_TIMEOUT_MS,
} from '../sync.mjs';
import { RemoteMediaSync } from '../media-relay.mjs';
import { SEEK_COOLDOWN_MS } from '../drift.mjs';
import { decode, encode } from '../protocol.mjs';

const KEY = 'http://127.0.0.1:8787/media/clip.webm';

function fakeVideo() {
  return {
    src: KEY,
    currentSrc: KEY,
    duration: 120,
    currentTime: 0,
    paused: true,
    seeking: false,
    readyState: 4,
    playbackRate: 1,
    volume: 1,
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

function makeClient(video) {
  let local = 0;
  const sent = [];
  const client = createRoomClient({
    role: 'peer',
    peerId: 'peer',
    now: () => local,
    mediaRoot: { querySelectorAll: () => [video] },
    send: (frame) => sent.push(frame),
  });
  return {
    client,
    sent,
    at(ms) {
      local = ms;
    },
    frame(position, roomTime, playing = true) {
      return encode({ type: 'media', key: KEY, action: 'tick', position, roomTime, playing });
    },
  };
}

test('a paused room seeks a small gap instead of leaving a slow rate behind', () => {
  const video = fakeVideo();
  video.currentTime = 0.9;
  video.paused = true;
  const doc = {
    querySelector: () => video,
    location: { href: KEY, hostname: '127.0.0.1' },
  };
  const relay = new RemoteMediaSync({
    document: doc,
    href: KEY,
    hostname: '127.0.0.1',
    now: () => 1000,
  });

  const result = relay.handle({ key: KEY, position: 0, playing: false, rate: 1, at: 1000 });
  assert.equal(result.action, 'seek');
  assert.equal(video.currentTime, 0);
  assert.equal(video.playbackRate, 1);
});

test('a granted peer drives the host film, and a revoked peer cannot', () => {
  let local = 1000;
  const relayed = [];
  const host = createRoomClient({
    role: 'host',
    peerId: 'host',
    hostId: 'host',
    now: () => local,
    send: () => {},
    overlay: false,
    onMedia: (frame) => {
      relayed.push(frame);
      return true;
    },
  });
  const peer = createRoomClient({
    role: 'peer',
    peerId: 'brave',
    name: 'Bob',
    hostId: 'host',
    now: () => local,
    send: (text) => host.receive(text, local),
    overlay: false,
  });

  // The notice names a person, so the host needs the name the peer chose.
  host.receive(encode({ type: 'hello', peerId: 'brave', name: 'Bob', roomTime: local }), local);

  // The host sees the same film, so only the sender can tell the two apart.
  host.setGrant('brave', true);
  peer.receive(
    encode({ type: 'control', peerId: 'brave', allowed: true, roomTime: local }),
    local
  );
  assert.equal(peer.isGranted(), true);
  assert.equal(peer.sendMedia({ key: KEY, position: 12, playing: true, rate: 1 }), true);
  assert.equal(relayed.length, 1);
  assert.equal(relayed[0].key, KEY);
  assert.equal(relayed[0].playing, true);
  assert.equal(relayed[0].expected, 12);
  assert.equal(relayed[0].name, 'Bob');

  // A host frame for its own film is an echo and never reaches the handler.
  const echo = host.receive(
    encode({ type: 'media', peerId: 'host', key: KEY, action: 'tick', position: 12, playing: true, roomTime: local }),
    local
  );
  assert.equal(echo.ignored, 'self');
  assert.equal(host.stats.mediaEcho, 1);
  assert.equal(relayed.length, 1);

  // A revoked peer keeps its own playhead.
  host.setGrant('brave', false);
  peer.receive(
    encode({ type: 'control', peerId: 'brave', allowed: false, roomTime: local }),
    local
  );
  assert.equal(peer.isGranted(), false);
  assert.equal(peer.sendMedia({ key: KEY, position: 40, playing: false }), false);
  assert.equal(relayed.length, 1);

  // A late frame from that peer is ignored even if it reaches the host.
  const stale = host.receive(
    encode({ type: 'media', peerId: 'brave', key: KEY, action: 'tick', position: 40, playing: false, roomTime: local }),
    local
  );
  assert.equal(stale.ignored, 'no-grant');
  assert.equal(relayed.length, 1);
});

test('one large drift causes one seek, and the next message does not stack another', () => {
  const video = fakeVideo();
  const { client, at, frame } = makeClient(video);

  at(5000);
  const first = client.receive(frame(2, 5000), 5000);
  assert.equal(first.step.action, 'seek');
  assert.equal(video.currentTime, 2);
  assert.equal(client.stats.corrections, 1);

  // The pipeline has not landed yet and currentTime is still old.
  at(5100);
  video.currentTime = 0;
  const second = client.receive(frame(2.1, 5100), 5100);
  assert.equal(second.pending, 'seek');
  assert.equal(client.stats.corrections, 1, 'a seek in flight is not repeated');
});

test('after the settle window the next correction is allowed again', () => {
  const video = fakeVideo();
  const { client, at, frame } = makeClient(video);

  at(5000);
  client.receive(frame(2, 5000), 5000);
  // The controller holds a second seek for its cooldown, which is longer than
  // the settle window. So the next correction waits for the larger of the two.
  const later = 5000 + Math.max(SEEK_SETTLE_MS, SEEK_COOLDOWN_MS) + 1;
  at(later);
  video.currentTime = 1.9;
  const settled = client.receive(frame(4, later), later);
  assert.equal(settled.step.action, 'seek');
  assert.equal(client.stats.corrections, 2);
});

test('a seek that never lands expires, so a peer is not stranded', () => {
  const video = fakeVideo();
  const { client, at, frame } = makeClient(video);

  at(5000);
  client.receive(frame(2, 5000), 5000);
  assert.equal(client.stats.corrections, 1);

  // The element reports a seek that never finishes, which the long clip does
  // here. Without a limit the peer waits on it for the rest of the run.
  video.seeking = true;
  video.currentTime = 1;
  at(5300);
  assert.equal(client.receive(frame(2.1, 5300), 5300).pending, 'seek');

  const lateAt = 5000 + SEEK_TIMEOUT_MS + 1;
  at(lateAt);
  const late = client.receive(frame(4, lateAt), lateAt);
  assert.equal(late.pending, 'seek-retry');
  assert.equal(client.stats.stuckSeeks, 1);
  assert.ok(video.currentTime > 3, 'the retry writes the expected point again');

  video.seeking = false;
  video.currentTime = 4;
  // The retry starts a settle window of its own, so the next decision waits
  // for it before the test judges that decision.
  const afterAt = lateAt + Math.max(SEEK_SETTLE_MS, SEEK_COOLDOWN_MS) + 1;
  at(afterAt);
  const after = client.receive(frame(6, afterAt), afterAt);
  assert.equal(after.step.action, 'seek', 'the next decision is not blocked');
  assert.equal(client.stats.corrections, 2);
});

test('a range check names the buffered window, and a missing list never blocks', () => {
  const ranges = {
    length: 2,
    start: (i) => [0, 100][i],
    end: (i) => [50, 140][i],
  };
  assert.equal(bufferedAround({ buffered: ranges }, 20), true);
  assert.equal(bufferedAround({ buffered: ranges }, 60), false, 'a gap is not buffered');
  assert.equal(bufferedAround({ buffered: ranges }, 139.8), false, 'the margin keeps it off the edge');
  assert.equal(bufferedAround({ buffered: ranges }, 120), true);
  assert.equal(bufferedAround({}, 900), true, 'an element without ranges never blocks a seek');
});

test('a seek into unbuffered data waits, then lands anyway', () => {
  const video = fakeVideo();
  video.buffered = { length: 1, start: () => 0, end: () => 120 };
  const { client, at, frame } = makeClient(video);

  at(5000);
  const first = client.receive(frame(300, 5000), 5000);
  assert.equal(first.pending, 'buffer');
  assert.equal(video.currentTime, 0, 'nothing is written while the wait holds');

  at(5000 + SEEK_BUFFER_WAIT_MS + 1);
  const late = client.receive(frame(300, 5000 + SEEK_BUFFER_WAIT_MS + 1), 5000 + SEEK_BUFFER_WAIT_MS + 1);
  assert.equal(late.step.action, 'seek');
  assert.equal(video.currentTime, 120, 'a seek past the clip clamps to its duration');
});

test('a small drift nudges the rate instead of seeking', () => {
  const video = fakeVideo();
  const { client, at, frame } = makeClient(video);

  at(5000);
  video.currentTime = 7.1;
  client.receive(frame(7, 5000), 5000);
  assert.equal(client.stats.corrections, 0);
  assert.equal(video.playbackRate, 0.95);
  assert.equal(client.stats.nudges, 1);
});

test('a buffering element pauses instead of chasing', () => {
  const video = fakeVideo();
  const { client, at, frame } = makeClient(video);
  video.paused = false;
  video.readyState = 1;

  at(5000);
  video.currentTime = 7;
  client.receive(frame(7, 5000), 5000);
  assert.equal(video.paused, true);
  assert.equal(client.stats.corrections, 0);
});

test('the host never corrects its own playhead', () => {
  const video = fakeVideo();
  let local = 5000;
  const client = createRoomClient({
    role: 'host',
    peerId: 'host',
    now: () => local,
    mediaRoot: { querySelectorAll: () => [video] },
    send: () => {},
  });
  video.currentTime = 1;
  const result = client.receive(
    encode({ type: 'media', key: KEY, action: 'tick', position: 90, roomTime: 5000, playing: true }),
    local
  );
  assert.equal(result.ok, true);
  assert.equal(video.currentTime, 1);
});

test('samples only start after the window, and only when settled', () => {
  const video = fakeVideo();
  const { client, at, frame } = makeClient(video);
  video.paused = false;

  at(5000);
  video.currentTime = 7.01;
  client.receive(frame(7, 5000), 5000);
  assert.equal(client.publish().sampleCount, 0);

  at(10_000);
  video.currentTime = 12.01;
  client.receive(frame(12, 10_000), 10_000);
  const published = client.publish();
  assert.equal(published.sampleCount, 1);
  assert.equal(published.samples[0], 10);
  assert.equal(published.convergedAt, 5000);
});

const fingerprint = { innerWidth: 1000, innerHeight: 800, scrollWidth: 1200 };

function hostWithView(getView) {
  let now = 1000;
  const sent = [];
  const client = createRoomClient({
    role: 'host',
    peerId: 'host',
    hostId: 'host',
    now: () => now,
    viewport: () => getView(),
    send: (frame) => sent.push(decode(frame)),
  });
  return {
    client,
    sent,
    at(ms) {
      now = ms;
      client.tick(ms);
    },
  };
}

test('the host announces its page once, then only when the url changes', () => {
  let view = { url: 'http://x/a.html', scroll: 0, fingerprint };
  const { sent, at } = hostWithView(() => view);
  at(1000);
  assert.deepEqual(
    sent.filter((message) => message.type === 'nav').map((message) => message.url),
    ['http://x/a.html']
  );
  at(1500);
  assert.equal(sent.filter((message) => message.type === 'nav').length, 1);
  view = { ...view, url: 'http://x/b.html' };
  at(2000);
  const navs = sent.filter((message) => message.type === 'nav');
  assert.equal(navs.length, 2);
  assert.equal(navs[1].url, 'http://x/b.html');
});

test('the host publishes a scroll ratio when it moves', () => {
  let view = { url: 'http://x/a.html', scroll: 0, fingerprint };
  const { sent, at } = hostWithView(() => view);
  at(1000);
  view = { ...view, scroll: 0.5 };
  at(1100);
  const views = sent.filter((message) => message.type === 'view');
  assert.equal(views.length, 1);
  assert.equal(views[0].scroll, 0.5);
  assert.deepEqual(views[0].fingerprint, fingerprint);
});

test('a peer follows the host url and scroll, and reports a layout mismatch', () => {
  const navigated = [];
  const scrolled = [];
  const client = createRoomClient({
    role: 'peer',
    peerId: 'p2',
    hostId: 'host',
    now: () => 0,
    send: () => {},
    viewport: () => ({ url: 'http://x/a.html', scroll: 0, fingerprint }),
    navigate: (url) => navigated.push(url),
    scrollTo: (ratio) => scrolled.push(ratio),
  });

  client.receive(encode({ type: 'nav', url: 'http://x/b.html', roomTime: 1 }), 0);
  client.receive(encode({ type: 'view', scroll: 0.75, fingerprint, roomTime: 1 }), 0);
  assert.deepEqual(navigated, ['http://x/b.html']);
  assert.deepEqual(scrolled, [0.75]);
  assert.equal(client.publish().layoutMismatch, false);

  client.receive(
    encode({
      type: 'view',
      scroll: 0.2,
      fingerprint: { ...fingerprint, innerWidth: 2000 },
      roomTime: 1,
    }),
    0
  );
  assert.equal(client.publish().layoutMismatch, true);
});

test('the published layout notice clears once the layouts agree again', () => {
  const doc = { location: { href: 'http://x/a.html', origin: 'http://x' } };
  let local = 1000;
  const client = createRoomClient({
    role: 'host',
    peerId: 'host',
    hostId: 'host',
    now: () => local,
    send: () => {},
    document: doc,
    overlay: false,
  });
  client.setGrant('p2', true);

  // The peer starts on the same layout, so the room has a fingerprint to compare.
  client.receive(encode({ type: 'view', peerId: 'p2', scroll: 0.2, fingerprint }), 900);
  assert.equal(client.publish().layoutMismatch, false);

  // Then the peer widens its window and lays the page out differently.
  client.receive(
    encode({
      type: 'view',
      peerId: 'p2',
      scroll: 0,
      fingerprint: { ...fingerprint, innerWidth: 2000 },
      roomTime: 1000,
    }),
    1000
  );
  assert.equal(client.publish().layoutMismatch, true);

  const click = client.receive(
    encode({
      type: 'input',
      peerId: 'p2',
      seq: 1,
      records: [{ kind: 'click', path: '#go' }],
      roomTime: 1000,
    }),
    1000
  );
  assert.equal(click.reasons.layout, 1, 'the click was dropped for the layout');
  const noticed = client.publish().layoutNotice;
  assert.equal(noticed.peerId, 'p2');
  assert.equal(noticed.dropped, 1);
  assert.equal(noticed.at, 1000, 'the notice carries the time of the drop');

  // The peer comes back to the host's layout, so the notice goes.
  client.receive(encode({ type: 'view', peerId: 'p2', scroll: 0, fingerprint }), 1200);
  assert.equal(client.publish().layoutMismatch, false);
  assert.equal(client.publish().layoutNotice, null);

  // A later mismatch names its own time, not the first drop.
  local = 1400;
  client.receive(
    encode({
      type: 'view',
      peerId: 'p2',
      scroll: 0,
      fingerprint: { ...fingerprint, innerWidth: 2000 },
      roomTime: 1400,
    }),
    1400
  );
  client.receive(
    encode({
      type: 'input',
      peerId: 'p2',
      seq: 2,
      records: [{ kind: 'click', path: '#go' }],
      roomTime: 1400,
    }),
    1400
  );
  assert.equal(client.publish().layoutNotice.at, 1400);
});

test('two peers in a room report their ids, so a count is never a guess', () => {
  const client = createRoomClient({
    role: 'host',
    peerId: 'host',
    hostId: 'host',
    now: () => 1000,
    send: () => {},
  });
  client.receive(encode({ type: 'hello', peerId: 'p2', name: 'P', colour: '#fff' }), 1000);
  client.receive(encode({ type: 'hello', peerId: 'p3', name: 'Q', colour: '#eee' }), 1000);

  // The journal reads peerIds off this roster, so the ids have to be here.
  const listed = client.publish().peerList;
  assert.deepEqual(listed.map((peer) => peer.id).sort(), ['p2', 'p3']);
  assert.equal(listed.find((peer) => peer.id === 'p2').name, 'P');
  assert.equal(listed.find((peer) => peer.id === 'p2').self, false);
});

test('a late joiner gets the page and the scroll from the host', () => {
  const view = { url: 'http://x/a.html', scroll: 0.4, fingerprint };
  const { client, sent, at } = hostWithView(() => view);
  at(1000);
  client.receive(encode({ type: 'hello', peerId: 'p2', name: 'P', roomTime: 1000 }), 1000);
  const snapshot = sent.filter((message) => message.type === 'snapshot').pop();
  assert.equal(snapshot.url, 'http://x/a.html');
  assert.equal(snapshot.scroll, 0.4);
});

test('presence latency lands in the published sample list', () => {
  let now = 1000;
  const client = createRoomClient({
    role: 'host',
    peerId: 'host',
    hostId: 'host',
    now: () => now,
    send: () => {},
  });
  client.receive(
    encode({
      type: 'presence',
      peerId: 'p2',
      name: 'P',
      colour: '#fff',
      point: { x: 1, y: 2 },
      roomTime: 940,
    }),
    now
  );
  const published = client.publish();
  assert.equal(published.latencies.at(-1), 60);
  assert.equal(published.latency.n, 1);
  assert.equal(published.latency.p95, 60);

  // A second sender keeps its own window, so one slow peer cannot hide behind
  // a merged p50.
  client.receive(
    encode({
      type: 'presence',
      peerId: 'p3',
      name: 'Q',
      colour: '#000',
      point: { x: 0, y: 0 },
      roomTime: 990,
    }),
    now
  );
  const split = client.publish();
  assert.equal(split.presenceByPeer.p2.p50, 60);
  assert.equal(split.presenceByPeer.p3.p50, 10);
  assert.equal(split.latency.n, 2);
});

test('a peer pings the host, and a ping addressed elsewhere is not answered', () => {
  let now = 0;
  const sent = [];
  const client = createRoomClient({
    role: 'peer',
    peerId: 'p2',
    hostId: 'host',
    now: () => now,
    send: (frame) => sent.push(decode(frame)),
  });
  now = 1000;
  client.tick(1000);
  const ping = sent.find((message) => message.type === 'ping');
  assert.equal(ping.to, 'host');

  sent.length = 0;
  now = 1100;
  client.receive(encode({ type: 'ping', t0: 40, to: 'p3' }), now);
  assert.equal(sent.length, 0, 'a ping for someone else gets no pong');
});

test('a remote cursor reaches the browser, and a relayed pointer drives presence', () => {
  const shared = [];
  const sent = [];
  const client = createRoomClient({
    role: 'peer',
    peerId: 'peer',
    now: () => 0,
    send: (frame) => sent.push(decode(frame)),
    onPresence: (peer) => shared.push(peer),
  });

  client.receive(
    encode({
      type: 'presence',
      peerId: 'p2',
      name: 'P',
      colour: '#fff',
      point: { x: 5, y: 6 },
      url: 'https://example.com/',
      roomTime: 0,
    }),
    0
  );
  // The room tab hands this to its browser so every other tab can draw it.
  assert.deepEqual(shared.at(-1), {
    id: 'p2',
    name: 'P',
    colour: '#fff',
    point: { x: 5, y: 6 },
    url: 'https://example.com/',
  });

  // A pointer that lives on another tab arrives as a point, not an event.
  assert.equal(client.setPointer({ point: 'no' }), false);
  assert.equal(client.setPointer({ x: 40.4, y: 12.6 }, 'https://example.com/'), true);
  client.presence();
  assert.deepEqual(sent.at(-1).point, { x: 40, y: 13 });
  assert.equal(sent.at(-1).url, 'https://example.com/');
});

// The overlay only needs its own elements to place a cursor.
function cursorDocument() {
  const make = () => ({
    style: {},
    children: [],
    parentNode: null,
    textContent: '',
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((entry) => entry !== child);
      child.parentNode = null;
      return child;
    },
    attachShadow() {
      this.shadowRoot = make();
      return this.shadowRoot;
    },
  });
  return { documentElement: make(), createElement: make, createElementNS: make };
}

test('a cursor draws only on the page it belongs to', () => {
  const client = createRoomClient({
    role: 'peer',
    peerId: 'peer',
    now: () => 0,
    document: cursorDocument(),
    pageUrl: () => 'https://example.com/',
    send: () => {},
  });

  const presence = (url, x) =>
    encode({
      type: 'presence',
      peerId: 'p2',
      name: 'P',
      colour: '#fff',
      point: { x, y: x },
      url,
      roomTime: 0,
    });

  // A peer on another page draws nothing here, so the pointer never lands on
  // an unrelated tab.
  client.receive(presence('https://www.youtube.com/watch?v=1', 9), 0);
  assert.equal(client.publish().cursors, 0);

  client.receive(presence('https://example.com/', 10), 0);
  assert.equal(client.publish().cursors, 1);

  // The peer moves to another page, so the cursor leaves this one.
  client.receive(presence('https://www.youtube.com/watch?v=2', 11), 0);
  assert.equal(client.publish().cursors, 0);
});

test('presence carries the last trusted pointer position', () => {
  const listeners = new Map();
  const doc = {
    addEventListener(type, fn) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    },
    dispatch(type, event) {
      for (const fn of listeners.get(type) || []) fn(event);
    },
  };
  const sent = [];
  const client = createRoomClient({
    role: 'peer',
    peerId: 'peer',
    now: () => 0,
    document: doc,
    overlay: false,
    send: (frame) => sent.push(decode(frame)),
  });

  doc.dispatch('pointermove', { isTrusted: true, clientX: 321.4, clientY: 222.6 });
  client.presence();
  assert.deepEqual(sent.at(-1).point, { x: 321, y: 223 });

  // Replayed remote input is synthetic, so it is not this page's pointer.
  doc.dispatch('pointermove', { isTrusted: false, clientX: 10, clientY: 10 });
  client.presence();
  assert.deepEqual(sent.at(-1).point, { x: 321, y: 223 });
});

test('the peer path reads and writes only through the adapter', () => {
  // No currentTime, paused or seeking fields. A player object looks like this,
  // and the peer path must not need any of them.
  const seen = {
    key: 'youtube:abc',
    position: 12,
    duration: 600,
    playing: true,
    rate: 1,
    volume: 1,
    seeking: false,
    readyState: 4,
  };
  const writes = [];
  const bare = {
    pick: (key) => (key === seen.key ? seen : null),
    state: (handle) => (handle === seen ? { ...seen } : null),
    flags: () => ({ buffering: false, adPlaying: false }),
    apply: (handle, command) => {
      writes.push(command);
      if (command.action === 'seek') seen.position = command.position;
      if (command.action === 'play') seen.playing = true;
      if (command.action === 'tick' && command.rate) seen.rate = command.rate;
      return 'applied';
    },
    bufferedAround: () => true,
  };
  const client = createRoomClient({
    role: 'peer',
    peerId: 'peer',
    now: () => 5000,
    mediaAdapter: bare,
    send: () => {},
  });
  const frame = (position, roomTime) =>
    encode({ type: 'media', key: seen.key, action: 'tick', position, roomTime, playing: true });

  const step = client.receive(frame(2, 5000), 5000);
  assert.equal(step.step.action, 'seek');
  assert.deepEqual(
    writes.find((entry) => entry.action === 'seek'),
    { action: 'seek', position: 2 },
    'the seek goes through apply, not a field'
  );
  assert.equal(seen.position, 2, 'the adapter made the write');
  assert.equal(client.publish().key, seen.key);
});

test('a late player replaces the adapter, and a missing one restores the element adapter', () => {
  const client = createRoomClient({ role: 'peer', peerId: 'peer', now: () => 0, send: () => {} });
  const player = {
    pick: () => null,
    state: () => null,
    flags: () => ({ buffering: false, adPlaying: false }),
    apply: () => 'applied',
  };

  assert.equal(client.setMediaAdapter(player), player);
  assert.equal(client.media, player);

  const restored = client.setMediaAdapter(null);
  assert.equal(restored, client.media);
  assert.notEqual(restored, player);
  assert.equal(typeof restored.pick, 'function');
});

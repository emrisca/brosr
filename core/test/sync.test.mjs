// Sync client behaviour that needs no browser: a media message against a fake
// element, with a clock the test controls.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomClient, SEEK_SETTLE_MS } from '../sync.mjs';
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
  at(5000 + SEEK_SETTLE_MS + 1);
  video.currentTime = 1.9;
  const settled = client.receive(frame(4, 5000 + SEEK_SETTLE_MS + 1), 5000 + SEEK_SETTLE_MS + 1);
  assert.equal(settled.step.action, 'seek');
  assert.equal(client.stats.corrections, 2);
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
  const client = createRoomClient({
    role: 'host',
    peerId: 'host',
    hostId: 'host',
    now: () => 1000,
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

  // The peer comes back to the host's layout, so the notice goes.
  client.receive(encode({ type: 'view', peerId: 'p2', scroll: 0, fingerprint }), 1200);
  assert.equal(client.publish().layoutMismatch, false);
  assert.equal(client.publish().layoutNotice, null);
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

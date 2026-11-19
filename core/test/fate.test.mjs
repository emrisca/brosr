import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomClient, STUTTER_MAX_MS } from '../sync.mjs';
import { encode } from '../protocol.mjs';
import { RELAY_BUFFER_WAIT_MS, RELAY_HOLD_MAX_MS, RemoteMediaSync } from '../media-relay.mjs';

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

test('a granted peer stutter holds the host and an ungranted one is ignored', () => {
  let local = 1000;
  const hostSent = [];
  const hostHolds = [];
  const host = createRoomClient({
    role: 'host',
    peerId: 'host',
    hostId: 'host',
    sameFate: true,
    now: () => local,
    overlay: false,
    send: (frame) => hostSent.push(JSON.parse(frame)),
    onMedia: () => true,
    onHold: (hold) => hostHolds.push(hold),
  });
  const peerSent = [];
  const peer = createRoomClient({
    role: 'peer',
    peerId: 'brave',
    name: 'Bob',
    hostId: 'host',
    now: () => local,
    overlay: false,
    send: (frame) => peerSent.push(JSON.parse(frame)),
  });

  host.receive(encode({ type: 'hello', peerId: 'brave', name: 'Bob', roomTime: local }), local);
  host.setGrant('brave', true);
  peer.receive(
    encode({ type: 'control', peerId: 'brave', allowed: true, roomTime: local }),
    local
  );
  peer.receive(encode({ type: 'fate', peerId: 'host', enabled: true, roomTime: local }), local);

  const starved = { key: KEY, position: 12, playing: true, buffering: true };
  peer.noteMedia(starved, 1000);
  assert.equal(peerSent.some((message) => message.type === 'stutter'), false);
  peer.noteMedia(starved, 1600);
  const active = peerSent.at(-1);
  assert.equal(active.type, 'stutter');
  assert.equal(active.active, true);

  host.receive(encode(active), 1600);
  assert.equal(hostHolds.at(-1).active, true);
  const relayed = hostSent.filter((message) => message.type === 'stutter').at(-1);
  assert.equal(relayed.from, 'host');
  assert.equal(relayed.peerId, 'brave');

  peer.noteMedia({ ...starved, buffering: false }, 2000);
  host.receive(encode(peerSent.at(-1)), 2000);
  assert.equal(hostHolds.at(-1).active, false);

  const bogus = host.receive(
    encode({
      type: 'stutter',
      peerId: 'lurker',
      key: KEY,
      position: 5,
      playing: true,
      active: true,
      roomTime: 2000,
    }),
    2000
  );
  assert.equal(bogus.ignored, 'no-grant');
});

test('a host stutter holds a guest and a routine tick cannot resume it', () => {
  const local = 1000;
  const video = fakeVideo();
  video.paused = false;
  const holds = [];
  const guest = createRoomClient({
    role: 'peer',
    peerId: 'peer',
    hostId: 'host',
    sameFate: true,
    now: () => local,
    overlay: false,
    mediaRoot: { querySelectorAll: () => [video] },
    send: () => {},
    onHold: (hold) => {
      holds.push(hold);
      if (hold.active) video.pause();
      else {
        video.currentTime = hold.position;
        video.paused = false;
      }
    },
  });

  guest.receive(encode({ type: 'fate', peerId: 'host', enabled: true, roomTime: local }), local);
  guest.receive(
    encode({
      type: 'stutter',
      peerId: 'host',
      from: 'host',
      key: KEY,
      position: 10,
      playing: true,
      active: true,
      roomTime: local,
    }),
    local
  );
  assert.equal(holds.at(-1).active, true);
  assert.equal(video.paused, true);

  const ignored = guest.receive(
    encode({
      type: 'media',
      peerId: 'host',
      key: KEY,
      action: 'tick',
      position: 10,
      playing: true,
      roomTime: local,
    }),
    local
  );
  assert.equal(ignored.ignored, 'hold');
  assert.equal(video.paused, true);

  guest.receive(
    encode({
      type: 'stutter',
      peerId: 'host',
      from: 'host',
      key: KEY,
      position: 10,
      playing: true,
      active: false,
      roomTime: local,
    }),
    local
  );
  assert.equal(holds.at(-1).active, false);
  const applied = guest.receive(
    encode({
      type: 'media',
      peerId: 'host',
      key: KEY,
      action: 'tick',
      position: 10,
      playing: true,
      roomTime: local,
    }),
    local
  );
  assert.equal(applied.ok, true);
  assert.equal(video.paused, false);
});

test('a hold with no recovery report releases itself', () => {
  let local = 1000;
  const holds = [];
  const host = createRoomClient({
    role: 'host',
    peerId: 'host',
    hostId: 'host',
    sameFate: true,
    now: () => local,
    overlay: false,
    send: () => {},
    onMedia: () => true,
    onHold: (hold) => holds.push(hold),
  });

  const starved = { key: KEY, position: 12, playing: true, buffering: true };
  host.noteMedia(starved, 1000);
  host.noteMedia(starved, 1600);
  assert.equal(host.publish().stutter.active, true);
  assert.equal(holds.at(-1).active, true);

  // A player paused under the hold sends no further sample, so silence has to
  // release the room instead of freezing every player for the session.
  local = 1600 + STUTTER_MAX_MS + 1;
  // publish() is what the page loop runs, so the expiry must happen there.
  assert.equal(host.publish().stutter.active, false);
  assert.equal(holds.at(-1).active, false);
});

test('a held film stays paused until the release carries the resume point', () => {
  const now = 10000;
  const video = fakeVideo();
  video.paused = false;
  const sync = new RemoteMediaSync({
    document: { querySelector: () => video },
    href: KEY,
    hostname: '127.0.0.1',
    now: () => now,
  });

  assert.equal(sync.handle({ key: KEY, position: 10, playing: true, hold: true, at: now }).action, 'hold');
  assert.equal(video.paused, true);
  assert.equal(sync.handle({ key: KEY, position: 10, playing: true, at: now }).skipped, 'held');
  assert.equal(video.paused, true);

  sync.handle({ key: KEY, position: 10, playing: true, hold: false, at: now });
  assert.equal(sync.held, false);
  assert.equal(video.paused, false);
});

test('a room hold does not discard the buffer wait that caused it', () => {
  let now = 10000;
  const video = fakeVideo();
  video.currentTime = 10;
  video.paused = false;
  video.buffered = { length: 1, start: () => 0, end: () => 60 };
  const sync = new RemoteMediaSync({
    document: { querySelector: () => video },
    href: KEY,
    hostname: '127.0.0.1',
    now: () => now,
  });

  const waiting = sync.handle({ key: KEY, position: 100, playing: true, at: now });
  assert.equal(waiting.skipped, 'buffer');
  assert.equal(video.paused, true);
  assert.equal(sync.waitingSince, now);

  // Same fate answers the buffering report with a hold. The hold is not a
  // reason to forget the seek target, because the release must not start the
  // film at the old point and immediately hold it again.
  sync.handle({ key: KEY, position: 10, playing: true, hold: true, at: now });
  assert.equal(sync.held, true);
  assert.equal(sync.waitingSince, now);

  now += 500;
  const released = sync.handle({ key: KEY, position: 100, playing: true, hold: false, at: now });
  assert.equal(released.skipped, 'buffer');
  assert.equal(video.paused, true);

  video.buffered = { length: 1, start: () => 0, end: () => 200 };
  const landed = sync.handle({ key: KEY, position: 100, playing: true, hold: false, at: now });
  assert.equal(landed.action, 'seek');
  assert.equal(video.currentTime, 100);
  assert.equal(video.paused, false);
});

test('a hold that outlasts the buffer deadline lands the seek on release', () => {
  let now = 10000;
  const video = fakeVideo();
  video.currentTime = 10;
  video.paused = false;
  video.buffered = { length: 1, start: () => 0, end: () => 60 };
  const sync = new RemoteMediaSync({
    document: { querySelector: () => video },
    href: KEY,
    hostname: '127.0.0.1',
    now: () => now,
  });

  sync.handle({ key: KEY, position: 100, playing: true, at: now });
  sync.handle({ key: KEY, position: 10, playing: true, hold: true, at: now });
  now += RELAY_BUFFER_WAIT_MS + 1;

  // The room is still holding, and the film tab stops reporting buffering so
  // the host can release. The seek waits for that release.
  const stillHeld = sync.handle({ key: KEY, position: 10, playing: true, hold: true, at: now });
  assert.equal(stillHeld.action, 'hold');
  assert.equal(sync.waitingSince, null);
  assert.equal(sync.bufferReady, true);

  const released = sync.handle({ key: KEY, position: 100, playing: true, hold: false, at: now });
  assert.equal(released.action, 'seek');
  assert.equal(video.currentTime, 100);
  assert.equal(video.paused, false);
});

test('a hold whose release was lost cannot freeze the film for the session', () => {
  let now = 10000;
  const video = fakeVideo();
  video.paused = false;
  const sync = new RemoteMediaSync({
    document: { querySelector: () => video },
    href: KEY,
    hostname: '127.0.0.1',
    now: () => now,
  });

  assert.equal(
    sync.handle({ key: KEY, position: 10, playing: true, hold: true, at: now }).action,
    'hold'
  );
  assert.equal(sync.held, true);
  assert.equal(video.paused, true);

  // The release frame never arrived. It is one frame and it can be lost: the
  // room tab restarts and forgets the hold it carried, or the frame lands
  // while the film tab is unreachable. Without a deadline the tab honours the
  // hold for the rest of the session and only a reload brings the film back.
  now += RELAY_HOLD_MAX_MS + 1;
  const resumed = sync.handle({ key: KEY, position: 10, playing: true, at: now });
  assert.equal(sync.held, false);
  assert.notEqual(resumed.skipped, 'held');
  assert.equal(video.paused, false);
});

test('revoking control drops the hold that peer left on the host', () => {
  let local = 2000;
  const holds = [];
  const host = createRoomClient({
    role: 'host',
    peerId: 'host',
    hostId: 'host',
    sameFate: true,
    now: () => local,
    overlay: false,
    send: () => {},
    onMedia: () => true,
    onHold: (hold) => holds.push(hold),
  });

  host.receive(encode({ type: 'hello', peerId: 'brave', name: 'Bob', roomTime: local }), local);
  host.setGrant('brave', true);
  host.receive(
    encode({
      type: 'stutter',
      peerId: 'brave',
      key: KEY,
      position: 12,
      playing: true,
      active: true,
      roomTime: local,
    }),
    local
  );
  assert.equal(host.publish().stutter.active, true);
  assert.equal(holds.at(-1).active, true);

  // A peer that loses control can no longer send the recovery frame for its
  // stutter, so the hold would sit on the film until the ten second expiry.
  // It has to go at the moment control does.
  local += 1000;
  host.setGrant('brave', false);
  assert.equal(host.publish().stutter.active, false);
  assert.equal(holds.at(-1).active, false);
});

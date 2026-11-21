import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomClient, HOST_MEDIA_PRIORITY_MS, HOST_PEER_APPLY_MS, HOST_PEER_JOIN_APPLY_MS } from '../sync.mjs';
import {
  RelayMediaAdapter,
  RemoteMediaSync,
  remoteMediaEcho,
  mediaEchoMatches,
  MEDIA_ECHO_MS,
  RELAY_NUDGE_RATE,
} from '../media-relay.mjs';
import { encode } from '../protocol.mjs';

const KEY = 'youtube:dQw4w9WgXcQ';
const HREF = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

function makeVideo({
  currentTime = 10,
  duration = 600,
  paused = false,
  seekLatencyMs = 0,
  bufferedEnd = 600,
} = {}) {
  const listeners = new Map();
  let _currentTime = currentTime;
  let _paused = paused;
  let _seeking = false;
  let _seekTarget = null;
  let _seekDueAt = Infinity;
  let _lastClockAt = 0;

  const video = {
    duration,
    playbackRate: 1,
    volume: 1,
    muted: false,
    readyState: 4,
    ended: false,
    currentSrc: '',
    src: '',
    buffered: {
      get length() {
        return 1;
      },
      start() {
        return 0;
      },
      end() {
        return bufferedEnd;
      },
    },
    get currentTime() {
      return _currentTime;
    },
    set currentTime(val) {
      _currentTime = Math.max(0, Math.min(duration, Number(val) || 0));
      if (seekLatencyMs > 0) {
        _seeking = true;
        _seekTarget = _currentTime;
        _seekDueAt = _lastClockAt + seekLatencyMs;
      } else {
        _seeking = false;
        video._emit('seeked');
      }
    },
    get paused() {
      return _paused;
    },
    get seeking() {
      return _seeking;
    },
    play() {
      const wasPaused = _paused;
      _paused = false;
      if (wasPaused) video._emit('play');
      return Promise.resolve();
    },
    pause() {
      const wasPlaying = !_paused;
      _paused = true;
      if (wasPlaying) video._emit('pause');
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    _emit(type) {
      for (const fn of listeners.get(type) || []) fn({ type, target: video });
    },
    _advanceTo(now) {
      if (_lastClockAt > 0 && !_paused && !_seeking) {
        const dt = Math.max(0, (now - _lastClockAt) / 1000);
        _currentTime = Math.min(duration, _currentTime + dt * video.playbackRate);
      }
      _lastClockAt = now;
      if (_seeking && now >= _seekDueAt) {
        _seeking = false;
        _seekDueAt = Infinity;
        _currentTime = _seekTarget;
        video._emit('seeked');
      }
    },
    _setClock(now) {
      _lastClockAt = now;
    },
  };
  return video;
}

function runTwoPeerSim({
  latencyMs = 40,
  hostSeekLatencyMs = 0,
  peerSeekLatencyMs = 0,
  hostBufferedEnd = 600,
  peerBufferedEnd = 600,
  events = [],
  endAt = 6000,
}) {
  let now = 1000;
  const queue = [];
  const schedule = (at, fn) => {
    queue.push({ at, fn });
    queue.sort((a, b) => a.at - b.at);
  };

  const hostVideo = makeVideo({
    currentTime: 10,
    paused: false,
    seekLatencyMs: hostSeekLatencyMs,
    bufferedEnd: hostBufferedEnd,
  });
  const peerVideo = makeVideo({
    currentTime: 10,
    paused: false,
    seekLatencyMs: peerSeekLatencyMs,
    bufferedEnd: peerBufferedEnd,
  });
  hostVideo._setClock(now);
  peerVideo._setClock(now);

  const makeFilmDoc = (video) => ({
    location: { href: HREF, hostname: 'www.youtube.com' },
    title: 'Test Film - YouTube',
    querySelector: (sel) => (sel.includes('video') ? video : null),
  });

  const hostRemote = new RemoteMediaSync({
    document: makeFilmDoc(hostVideo),
    href: HREF,
    hostname: 'www.youtube.com',
    now: () => now,
  });
  const peerRemote = new RemoteMediaSync({
    document: makeFilmDoc(peerVideo),
    href: HREF,
    hostname: 'www.youtube.com',
    now: () => now,
  });
  const hostRelayed = new RelayMediaAdapter({ now: () => now });

  let hostLastApplied = null;
  let hostRemoteEcho = null;
  let peerLastApplied = null;
  let peerRemoteEcho = null;

  function makeFilmApply(remote, getLast, setLast, setEcho) {
    return (msg) => {
      const prev = getLast();
      const result = remote.handle(msg);
      const echo = remoteMediaEcho(result, prev, msg, now);
      if (echo) setEcho(echo);
      if (!result || !result.ok || result.skipped) setLast(null);
      else {
        setLast({
          key: msg.key,
          position: Number(msg.position || 0),
          playing: Boolean(msg.playing),
          rate: Number(msg.rate || 1),
          at: now,
        });
      }
    };
  }

  const applyToHostFilm = makeFilmApply(
    hostRemote,
    () => hostLastApplied,
    (v) => {
      hostLastApplied = v;
    },
    (v) => {
      hostRemoteEcho = v;
    }
  );
  const applyToPeerFilm = makeFilmApply(
    peerRemote,
    () => peerLastApplied,
    (v) => {
      peerLastApplied = v;
    },
    (v) => {
      peerRemoteEcho = v;
    }
  );

  const hostClient = createRoomClient({
    role: 'host',
    room: 'sync',
    peerId: 'host',
    hostId: 'host',
    overlay: false,
    mediaAdapter: hostRelayed,
    now: () => now,
    send: (frame) => schedule(now + latencyMs, () => peerClient.receive(frame, now)),
    onMedia: (msg) => {
      schedule(now + 5, () =>
        applyToHostFilm({
          type: 'brosr:media-apply',
          from: msg.peerId,
          action: msg.action || null,
          key: msg.key,
          position: msg.expected,
          playing: Boolean(msg.playing),
          rate: Number(msg.rate || 1),
          volume: Number(msg.volume ?? 1),
          ad: Boolean(msg.ad),
          ...(Number.isFinite(Number(msg.rev)) ? { rev: Number(msg.rev) } : {}),
          at: Number(msg.at) || now,
        })
      );
      return true;
    },
  });

  const peerClient = createRoomClient({
    role: 'peer',
    room: 'sync',
    peerId: 'peer',
    hostId: 'host',
    overlay: false,
    now: () => now,
    send: (frame) => schedule(now + latencyMs, () => hostClient.receive(frame, now)),
    onMedia: (msg) => {
      schedule(now + 5, () =>
        applyToPeerFilm({
          type: 'brosr:media-apply',
          from: msg.peerId,
          action: msg.action || null,
          key: msg.key,
          position: msg.expected,
          playing: Boolean(msg.playing),
          rate: Number(msg.rate || 1),
          volume: Number(msg.volume ?? 1),
          ad: Boolean(msg.ad),
          ...(Number.isFinite(Number(msg.rev)) ? { rev: Number(msg.rev) } : {}),
          at: Number(msg.at) || now,
        })
      );
      return true;
    },
  });

  function reportHost(userAction = false) {
    const state = {
      key: KEY,
      position: hostVideo.currentTime,
      duration: hostVideo.duration,
      playing: !hostVideo.paused && !hostVideo.ended,
      rate:
        userAction === 'rate'
          ? hostVideo.playbackRate
          : hostRemote.reportedRate() || hostVideo.playbackRate,
      volume: hostVideo.volume,
      buffering: hostVideo.readyState < 2 || hostRemote.bufferWaitActive(),
      ad: false,
      action: typeof userAction === 'string' ? userAction : Boolean(userAction),
      at: now,
    };
    schedule(now + 5, () => {
      if (hostClient.sendHostMedia(state, now)) hostRelayed.set(state);
    });
  }

  function reportPeer(userAction = false) {
    if (!userAction) return;
    const state = {
      key: KEY,
      position: peerVideo.currentTime,
      duration: peerVideo.duration,
      playing: !peerVideo.paused && !peerVideo.ended,
      rate:
        userAction === 'rate'
          ? peerVideo.playbackRate
          : peerRemote.reportedRate() || peerVideo.playbackRate,
      volume: peerVideo.volume,
      buffering: peerVideo.readyState < 2 || peerRemote.bufferWaitActive(),
      ad: false,
      action: typeof userAction === 'string' ? userAction : Boolean(userAction),
      at: now,
    };
    schedule(now + 5, () => peerClient.sendMedia(state));
  }

  for (const [ev, act] of [
    ['play', 'play'],
    ['pause', 'pause'],
    ['seeked', 'seek'],
  ]) {
    hostVideo.addEventListener(ev, () => {
      const isEcho =
        act === 'seek'
          ? hostRemote.isEcho(act, now)
          : hostRemote.isEcho(act, now) || mediaEchoMatches(hostRemoteEcho, act, now);
      if (isEcho) return;
      hostRemote.noteLocalAct(act, now);
      reportHost(act);
    });
    peerVideo.addEventListener(ev, () => {
      const isEcho =
        act === 'seek'
          ? peerRemote.isEcho(act, now)
          : peerRemote.isEcho(act, now) || mediaEchoMatches(peerRemoteEcho, act, now);
      if (isEcho) return;
      peerRemote.noteLocalAct(act, now);
      reportPeer(act);
    });
  }

  for (let t = 1000; t <= endAt; t += 250) schedule(t, () => reportHost(false));
  for (const e of events) schedule(e.at, () => e.fn({ hostVideo, peerVideo }));

  const snapshots = [];
  for (let t = 1500; t <= endAt; t += 100) {
    schedule(t, () =>
      snapshots.push({
        t,
        host: hostVideo.currentTime,
        hostPlaying: !hostVideo.paused,
        peer: peerVideo.currentTime,
        peerPlaying: !peerVideo.paused,
      })
    );
  }

  while (queue.length && queue[0].at <= endAt) {
    const item = queue.shift();
    now = item.at;
    hostVideo._advanceTo(now);
    peerVideo._advanceTo(now);
    item.fn();
  }

  return { snapshots, end: snapshots.at(-1), hostClient, peerClient };
}

test('a peer jumping forward while playing does not snap back to host in-flight ticks', () => {
  const { snapshots, end } = runTwoPeerSim({
    latencyMs: 40,
    events: [{ at: 1520, fn: ({ peerVideo }) => { peerVideo.currentTime = 60; } }],
  });

  // Peer must never snap back toward 10s after jumping to 60s.
  const peerAfterJump = snapshots.filter((s) => s.t >= 1600).map((s) => s.peer);
  assert.ok(Math.min(...peerAfterJump) >= 59.5, `peer snapped back to ${Math.min(...peerAfterJump)}`);
  assert.equal(end.hostPlaying, true);
  assert.equal(end.peerPlaying, true);
  assert.ok(Math.abs(end.host - 64.48) < 0.5, `host ended at ${end.host}`);
  assert.ok(Math.abs(end.host - end.peer) < 0.25, `final drift ${end.host - end.peer}`);
});

test('host jumping rapidly while a peer has slow async YouTube seek does not ping-pong or snap back', () => {
  const { snapshots, end } = runTwoPeerSim({
    latencyMs: 40,
    peerSeekLatencyMs: 750,
    events: [
      { at: 1520, fn: ({ hostVideo }) => { hostVideo.currentTime = 60; } },
      { at: 1900, fn: ({ hostVideo }) => { hostVideo.currentTime = 120; } },
    ],
  });

  // Host must stay near/above 120s after its second jump (never snapped back to 60s).
  const hostAfterSecondJump = snapshots.filter((s) => s.t >= 2000).map((s) => s.host);
  assert.ok(
    Math.min(...hostAfterSecondJump) >= 119.5,
    `host snapped back to ${Math.min(...hostAfterSecondJump)}`
  );
  assert.equal(end.hostPlaying, true);
  assert.equal(end.peerPlaying, true);
  assert.ok(end.peer >= 122.5, `peer failed to converge near 124s (ended at ${end.peer})`);
  assert.ok(Math.abs(end.host - end.peer) < 1.0, `final drift too large: ${end.host - end.peer}`);
});

test('peer jumping into unbuffered range on host does not pause-freeze the room', () => {
  const { snapshots, end } = runTwoPeerSim({
    latencyMs: 40,
    hostBufferedEnd: 25,
    events: [{ at: 1520, fn: ({ peerVideo }) => { peerVideo.currentTime = 60; } }],
  });

  const peerAfterJump = snapshots.filter((s) => s.t >= 1600).map((s) => s.peer);
  assert.ok(Math.min(...peerAfterJump) >= 59.5, `peer snapped back to ${Math.min(...peerAfterJump)}`);
  assert.equal(end.hostPlaying, true, 'host stayed playing instead of freezing paused');
  assert.equal(end.peerPlaying, true, 'peer stayed playing');
  assert.ok(end.host >= 63.5, `host converged past 60s (ended at ${end.host})`);
  assert.ok(Math.abs(end.host - end.peer) < 0.25);
});

test('simultaneous host and peer jumps resolve deterministically with host winning', () => {
  const { snapshots, end } = runTwoPeerSim({
    latencyMs: 40,
    events: [
      {
        at: 1520,
        fn: ({ hostVideo, peerVideo }) => {
          hostVideo.currentTime = 120;
          peerVideo.currentTime = 60;
        },
      },
    ],
  });

  const hostAfter = snapshots.filter((s) => s.t >= 1600).map((s) => s.host);
  assert.ok(Math.min(...hostAfter) >= 119.5, `host snapped back to ${Math.min(...hostAfter)}`);
  assert.ok(end.peer >= 123.5, `peer converged to host jump (ended at ${end.peer})`);
  assert.ok(Math.abs(end.host - end.peer) < 0.25);
});

test('peer rapid consecutive jumps preempt cleanly without reverting', () => {
  const { snapshots, end } = runTwoPeerSim({
    latencyMs: 40,
    hostSeekLatencyMs: 400,
    events: [
      { at: 1520, fn: ({ peerVideo }) => { peerVideo.currentTime = 60; } },
      { at: 1850, fn: ({ peerVideo }) => { peerVideo.currentTime = 180; } },
    ],
  });

  const hostAfterSecond = snapshots.filter((s) => s.t >= 2300).map((s) => s.host);
  assert.ok(Math.min(...hostAfterSecond) >= 179.5, `host reverted to ${Math.min(...hostAfterSecond)}`);
  assert.ok(end.host >= 183, `host ended at ${end.host}`);
  assert.ok(Math.abs(end.host - end.peer) < 0.5);
});

test('stale-rev peer seek arriving after HOST_MEDIA_PRIORITY_MS is rejected by host', () => {
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
  host.receive(encode({ type: 'hello', peerId: 'peer', name: 'Peer', roomTime: local }), local);

  // Host jumps -> mediaRev becomes 1.
  host.sendHostMedia({ key: KEY, position: 120, playing: true, action: 'seek', rate: 1 }, local);

  // Advance well past HOST_MEDIA_PRIORITY_MS (500 ms).
  local += HOST_MEDIA_PRIORITY_MS + 400;

  // Delayed peer seek carrying rev: 1 (from before peer saw host's rev: 1) must be dropped.
  const stale = host.receive(
    encode({
      type: 'media',
      peerId: 'peer',
      key: KEY,
      action: 'seek',
      position: 60,
      playing: true,
      rev: 1,
      roomTime: local - 400,
    }),
    local
  );
  assert.equal(stale.ignored, 'stale-rev');
  assert.equal(relayed.length, 0);
  assert.equal(host.publish().mediaDrops['stale-rev'], 1);

  // A fresh peer seek after seeing rev: 1 carries rev: 2 and is accepted.
  const fresh = host.receive(
    encode({
      type: 'media',
      peerId: 'peer',
      key: KEY,
      action: 'seek',
      position: 180,
      playing: true,
      rev: 2,
      roomTime: local,
    }),
    local
  );
  assert.equal(fresh.relayed, true);
  assert.equal(relayed.length, 1);
  assert.equal(relayed[0].expected, 180);
});

test('RemoteMediaSync.isEcho suppresses remote seek echoes but passes immediate human jumps to a new timestamp', () => {
  let now = 5000;
  const video = makeVideo({ currentTime: 10, paused: false, seekLatencyMs: 0 });
  video._setClock(now);
  const doc = {
    location: { href: HREF, hostname: 'www.youtube.com' },
    querySelector: () => video,
  };
  const remote = new RemoteMediaSync({
    document: doc,
    href: HREF,
    hostname: 'www.youtube.com',
    now: () => now,
  });

  // Track whether synchronous seeked during handle() is treated as echo.
  const observed = [];
  video.addEventListener('seeked', () => {
    observed.push({ pos: video.currentTime, echo: remote.isEcho('seek', now) });
  });

  remote.handle({
    key: KEY,
    action: 'seek',
    position: 60,
    playing: true,
    rate: 1,
    rev: 1,
    at: now,
  });
  assert.deepEqual(observed, [{ pos: 60, echo: true }]);

  // 200 ms later (still within MEDIA_ECHO_MS), human jumps to 120s -> must NOT be treated as echo!
  now += 200;
  video._setClock(now);
  video.currentTime = 120;
  assert.equal(observed.at(-1).pos, 120);
  assert.equal(observed.at(-1).echo, false);
});

test('host room tab with media.pick() === null anchors non-seek peer acts to fresh host playhead and uses 2.5s apply window', () => {
  let local = 10000;
  const relayed = [];
  const hostSent = [];
  // Real host room tab without in-page video or RelayMediaAdapter: media.pick() is null.
  const host = createRoomClient({
    role: 'host',
    peerId: 'host',
    hostId: 'host',
    now: () => local,
    send: (frame) => hostSent.push(JSON.parse(frame)),
    overlay: false,
    onMedia: (frame) => {
      relayed.push(frame);
      return true;
    },
  });
  host.receive(encode({ type: 'hello', peerId: 'peer', name: 'Peer', roomTime: local }), local);

  // Host film tab reports active playing state at 120s (duration 600s).
  assert.equal(
    host.sendHostMedia(
      { key: KEY, title: 'Demo', position: 120, duration: 600, playing: true, rate: 1, at: local },
      local
    ),
    true
  );

  // 1 second later Host is at 121.0s. Granted peer (lagging at 118.0s) presses pause.
  local += 1000;
  const paused = host.receive(
    encode({
      type: 'media',
      peerId: 'peer',
      key: KEY,
      action: 'pause',
      position: 118.0,
      playing: false,
      rate: 1,
      rev: 1,
      roomTime: local - 60,
    }),
    local
  );
  assert.equal(paused.relayed, true);
  assert.ok(
    Math.abs(relayed.at(-1).expected - 121.0) < 0.05,
    `expected host playhead ~121.0s, got ${relayed.at(-1).expected}`
  );
  assert.ok(
    Math.abs(hostSent.at(-1).position - 121.0) < 0.05,
    `host broadcast should keep host playhead ~121.0s, got ${hostSent.at(-1).position}`
  );

  // Active host tab must use HOST_PEER_APPLY_MS (2.5s), NOT 12s HOST_PEER_JOIN_APPLY_MS.
  assert.ok(host.pendingPeerMedia(KEY, local + HOST_PEER_APPLY_MS - 100));
  assert.equal(
    host.pendingPeerMedia(KEY, local + HOST_PEER_APPLY_MS + 100),
    null,
    'active host tab applyWindow must expire after HOST_PEER_APPLY_MS, not 12s'
  );

  // Peer changes rate to 1.5x while sitting 2s behind: still anchors to host playhead (121.0s paused).
  local += 300;
  const rated = host.receive(
    encode({
      type: 'media',
      peerId: 'peer',
      key: KEY,
      action: 'rate',
      position: 118.0,
      playing: false,
      rate: 1.5,
      rev: 2,
      roomTime: local - 40,
    }),
    local
  );
  assert.equal(rated.relayed, true);
  assert.ok(
    Math.abs(relayed.at(-1).expected - 121.0) < 0.05,
    `rate change must keep host playhead 121.0s, got ${relayed.at(-1).expected}`
  );

  // Explicit seek past host known duration clamps cleanly even with media.pick() === null.
  local += 300;
  const clamped = host.receive(
    encode({
      type: 'media',
      peerId: 'peer',
      key: KEY,
      action: 'seek',
      position: 900,
      playing: false,
      rate: 1.5,
      rev: 3,
      roomTime: local,
    }),
    local
  );
  assert.equal(clamped.relayed, true);
  assert.equal(relayed.at(-1).expected, 600);

  // By contrast, joining a brand new peer film key that Host has not reported still gets 12s join window.
  const NEW_KEY = 'youtube:brandNew99';
  local += 300;
  host.receive(
    encode({
      type: 'media',
      peerId: 'peer',
      key: NEW_KEY,
      action: 'seek',
      position: 45,
      playing: true,
      rate: 1,
      rev: 4,
      roomTime: local,
    }),
    local
  );
  assert.ok(
    host.pendingPeerMedia(NEW_KEY, local + HOST_PEER_APPLY_MS + 1000),
    'joining tab with no known host state must keep 12s HOST_PEER_JOIN_APPLY_MS window'
  );
  assert.equal(host.pendingPeerMedia(NEW_KEY, local + HOST_PEER_JOIN_APPLY_MS + 100), null);
});

test('late async ratechange during/after drift nudge never escapes echo suppression or causes slow-motion loop', () => {
  let now = 5000;
  const video = makeVideo({ currentTime: 100, paused: false, seekLatencyMs: 0 });
  video._setClock(now);
  const doc = {
    location: { href: HREF, hostname: 'www.youtube.com' },
    querySelector: () => video,
  };
  const remote = new RemoteMediaSync({
    document: doc,
    href: HREF,
    hostname: 'www.youtube.com',
    now: () => now,
  });

  // Prime at 1.0x.
  remote.handle({ key: KEY, action: 'tick', position: 100, playing: true, rate: 1, at: now });
  assert.equal(video.playbackRate, 1);

  // Peer drifts +0.50s ahead -> RemoteMediaSync applies slowdown nudge (1 / 1.05 = 0.95238...).
  now += 250;
  video._setClock(now);
  video.currentTime = 100.75;
  const nudged = remote.handle({
    key: KEY,
    action: 'tick',
    position: 100.25,
    playing: true,
    rate: 1,
    at: now,
  });
  assert.equal(nudged.rateChanged, true);
  assert.ok(Math.abs(video.playbackRate - 1 / RELAY_NUDGE_RATE) < 0.001);

  // 1200 ms later (well past MEDIA_ECHO_MS = 600 ms!), YouTube/HLS fires a late ratechange
  // while the element is still running our active 0.952x nudge -> MUST still be echo!
  now += MEDIA_ECHO_MS + 600;
  video._setClock(now);
  assert.equal(
    remote.isEcho('rate', now),
    true,
    'late ratechange matching active nudge rate must be suppressed even past MEDIA_ECHO_MS'
  );
  assert.equal(remote.reportedRate(), 1);

  // Drift settles -> RemoteMediaSync resets element back to 1.0x.
  now += 250;
  video._setClock(now);
  video.currentTime = 101.7;
  const reset = remote.handle({
    key: KEY,
    action: 'tick',
    position: 101.7,
    playing: true,
    rate: 1,
    at: now,
  });
  assert.equal(reset.rateChanged, true);
  assert.equal(video.playbackRate, 1);

  // 1200 ms after reset (past MEDIA_ECHO_MS), late async ratechange at 1.0x is STILL suppressed.
  now += MEDIA_ECHO_MS + 600;
  assert.equal(
    remote.isEcho('rate', now),
    true,
    'late ratechange matching nudge reset to roomRate must be suppressed'
  );

  // Meanwhile, a genuine human rate change to 1.5x MUST pass immediately (even inside MEDIA_ECHO_MS!).
  now += 100;
  video.playbackRate = 1.5;
  assert.equal(remote.isEcho('rate', now), false, 'genuine user 1.5x must not be suppressed');
  remote.noteLocalAct('rate', now);

  // Returning to 1.0x immediately after 1.5x also passes cleanly.
  now += 150;
  video.playbackRate = 1.0;
  assert.equal(remote.isEcho('rate', now), false, 'user returning from 1.5x to 1.0x must pass');
  remote.noteLocalAct('rate', now);

  // Explicit local seek while actively nudging resets element playbackRate cleanly back to roomRate!
  now += 250;
  video._setClock(now);
  video.currentTime = 104.0;
  remote.handle({ key: KEY, action: 'tick', position: 103.7, playing: true, rate: 1, at: now });
  assert.ok(video.playbackRate < 0.99, 'nudge active before local seek');
  now += 100;
  remote.noteLocalAct('seek', now);
  assert.equal(video.playbackRate, 1, 'explicit local seek must reset active nudge back to roomRate');
  assert.equal(remote.isEcho('rate', now), true, 'rate reset from local seek must stay echo-suppressed');
});

test('active local scrub drag (seeking) blocks routine ticks until seeked lands, but yields to newer remote seek', () => {
  let now = 5000;
  const video = makeVideo({ currentTime: 20, paused: false, seekLatencyMs: 500 });
  video._setClock(now);
  const doc = {
    location: { href: HREF, hostname: 'www.youtube.com' },
    querySelector: () => video,
  };
  const remote = new RemoteMediaSync({
    document: doc,
    href: HREF,
    hostname: 'www.youtube.com',
    now: () => now,
  });

  // Prime video at 20s (rev 1).
  remote.handle({ key: KEY, action: 'tick', position: 20, playing: true, rate: 1, rev: 1, at: now });

  // User starts scrubbing toward 150s -> video.seeking is true, seeking event fires before seeked.
  now += 200;
  video._setClock(now);
  video.currentTime = 150;
  assert.equal(video.seeking, true);
  assert.equal(remote.isEcho('seek', now), false);
  remote.noteLocalSeeking(now);
  assert.equal(remote.isLocalSeeking(now), true);

  // Routine room tick arrives 200ms later while user is still dragging -> MUST skip as local-seeking.
  now += 200;
  video._setClock(now);
  const duringDrag = remote.handle({
    key: KEY,
    action: 'tick',
    position: 20.4,
    playing: true,
    rate: 1,
    rev: 1,
    at: now,
  });
  assert.equal(duringDrag.skipped, 'local-seeking');
  assert.equal(video.paused, false);

  // Once seeked lands, noteLocalAct clears localSeeking.
  now += 350;
  video._advanceTo(now);
  assert.equal(video.seeking, false);
  assert.equal(video.currentTime, 150);
  remote.noteLocalAct('seek', now);
  assert.equal(remote.isLocalSeeking(now), false);

  // A strictly newer remote explicit seek supersedes an in-progress local scrub.
  now += 100;
  video._setClock(now);
  video.currentTime = 240;
  remote.noteLocalSeeking(now);
  const override = remote.handle({
    key: KEY,
    action: 'seek',
    position: 300,
    playing: true,
    rate: 1,
    rev: 2,
    at: now,
  });
  assert.equal(override.action, 'seek');
  assert.equal(remote.isLocalSeeking(now), false);
});

test('multi-peer hand-off, late-joining peer rev sync, and host-priority rejection never drop or poison seeks', () => {
  let local = 10000;
  const hostRelayed = [];
  const peerARelayed = [];
  const peerBRelayed = [];
  const sentHost = [];
  const sentA = [];
  const sentB = [];

  const host = createRoomClient({
    role: 'host',
    peerId: 'host',
    hostId: 'host',
    now: () => local,
    send: (frame) => sentHost.push(frame),
    overlay: false,
    onMedia: (frame) => {
      hostRelayed.push(frame);
      return true;
    },
  });
  const peerA = createRoomClient({
    role: 'peer',
    peerId: 'peerA',
    name: 'Alice',
    hostId: 'host',
    now: () => local,
    send: (frame) => sentA.push(frame),
    overlay: false,
    onMedia: (frame) => {
      peerARelayed.push(frame);
      return true;
    },
  });
  const peerB = createRoomClient({
    role: 'peer',
    peerId: 'peerB',
    name: 'Bob',
    hostId: 'host',
    now: () => local,
    send: (frame) => sentB.push(frame),
    overlay: false,
    onMedia: (frame) => {
      peerBRelayed.push(frame);
      return true;
    },
  });

  const flushTo = (queue, targets) => {
    while (queue.length) {
      const frame = queue.shift();
      for (const target of targets) target.receive(frame, local);
    }
  };

  // Host advances mediaRev to 5 before Peer A and Peer B even join!
  for (let i = 1; i <= 5; i += 1) {
    local += 600;
    host.sendHostMedia({ key: KEY, position: i * 10, playing: false, action: 'seek', rate: 1, at: local }, local);
  }
  sentHost.length = 0;

  // Peer A and Peer B join late -> receive a snapshot with mediaRev: 5.
  local += 600;
  peerA.hello();
  peerB.hello();
  flushTo(sentA, [host]);
  flushTo(sentB, [host]);
  flushTo(sentHost, [peerA, peerB]);
  flushTo(sentHost, [peerA, peerB]);

  // Peer B's VERY FIRST seek after late join must carry rev: 6 and succeed (never stale-rev!).
  local += 100;
  assert.equal(peerB.sendMedia({ key: KEY, position: 90, playing: true, action: 'seek', rate: 1 }), true);
  flushTo(sentB, [host, peerA]);
  assert.equal(hostRelayed.at(-1).expected, 90);
  assert.equal(host.publish().mediaDrops['stale-rev'] || 0, 0);
  flushTo(sentHost, [peerA, peerB]);

  // Concurrent multi-controller hand-off: both Peer A and Peer B are at rev 6.
  // Peer A seeks to 120 (rev 7) -> Host accepts. Before Peer B sees rev 7, Peer B seeks to 180 (rev 7).
  // Latest explicit controller act (Peer B -> 180) must win with immediate rev 8 broadcast!
  local += 100;
  peerA.sendMedia({ key: KEY, position: 120, playing: true, action: 'seek', rate: 1 });
  flushTo(sentA, [host]); // Host receives Peer A (rev 7), broadcasts rev 7 (still in sentHost).
  assert.equal(hostRelayed.at(-1).expected, 120);

  // Peer B has NOT received sentHost yet -> Peer B seeks to 180 with rev 7!
  local += 20;
  peerB.sendMedia({ key: KEY, position: 180, playing: true, action: 'seek', rate: 1 });
  flushTo(sentB, [host]);
  assert.equal(
    hostRelayed.at(-1).expected,
    180,
    'concurrent second controller seek at equal peer rev must win as latest explicit act'
  );
  assert.equal(hostRelayed.at(-1).rev, 8);
  flushTo(sentHost, [peerA, peerB]);
  assert.equal(peerARelayed.at(-1).expected, 180);
  assert.equal(peerBRelayed.at(-1).expected, 180);

  // Host rejects a peer seek during HOST_MEDIA_PRIORITY_MS -> Peer's mediaRev must NOT be poisoned.
  local += 600;
  host.sendHostMedia({ key: KEY, position: 250, playing: true, action: 'seek', rate: 1, at: local }, local);
  flushTo(sentHost, [peerA, peerB]);
  // Peer A now has mediaRev = 9. 100ms later (inside host-priority), Peer A tries to seek (sends rev 10).
  local += 100;
  peerA.sendMedia({ key: KEY, position: 50, playing: true, action: 'seek', rate: 1 });
  flushTo(sentA, [host]);
  assert.equal(host.publish().mediaDrops['host-priority'], 1);
  // After PEER_ACT_GUARD_MS expires, Peer A MUST still accept Host's routine ticks at rev 9!
  local += 1600;
  host.sendHostMedia({ key: KEY, position: 251.7, playing: true, action: false, rate: 1, at: local }, local);
  const countBefore = peerARelayed.length;
  flushTo(sentHost, [peerA]);
  assert.equal(peerARelayed.length, countBefore + 1, 'peer must still accept host ticks after host-priority drop');
});

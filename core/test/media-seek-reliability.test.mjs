import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomClient, HOST_MEDIA_PRIORITY_MS } from '../sync.mjs';
import {
  RelayMediaAdapter,
  RemoteMediaSync,
  remoteMediaEcho,
  mediaEchoMatches,
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

  hostClient.setGrant('peer', true);
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

test('granted peer jumping forward while playing does not snap back to host in-flight ticks', () => {
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

test('host jumping rapidly while granted peer has slow async YouTube seek does not ping-pong or snap back', () => {
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

test('granted peer jumping into unbuffered range on host does not pause-freeze the room', () => {
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

test('simultaneous host and granted peer jumps resolve deterministically with host winning', () => {
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

test('granted peer rapid consecutive jumps preempt cleanly without reverting', () => {
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
  host.setGrant('peer', true);

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

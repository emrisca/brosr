// Deterministic boundary tests for:
// 1. Mid-playback rejoin seek against a non-restoring player starting at 0 s
//    (playing and paused hosts, buffer-wait seed preservation, SPA key swaps,
//    and in-flight seek protection).
// 2. Three-peer sync over 10+ simulated minutes under cross-machine wall-clock
//    offsets (+1900 ms, -850 ms), asymmetric RTT/jitter, periodic clock pings,
//    a mid-stream host seek, and a single 600 ms delay spike (p95 drift <= 250 ms,
//    <= 1 correction seek per 10 minutes, zero seek loops).
// 3. Ctrl+Alt+B / open-room-panel command wiring across MV2 (Gecko) and MV3
//    (Chromium) with a strict synchronous user-gesture gate on openPopup().

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRoomClient, HOST_TICK_MS, SEEK_BUFFER_WAIT_MS } from '../sync.mjs';
import { PING_INTERVAL_MS } from '../clock.mjs';
import {
  RELAY_NUDGE_SECONDS,
  RELAY_NUDGE_STOP_SECONDS,
  RemoteMediaSync,
  pageKey,
} from '../media-relay.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..');
const bgSource = fs.readFileSync(path.join(repoRoot, 'bridge', 'background.js'), 'utf8');
const mv2Manifest = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'bridge', 'manifest.json'), 'utf8')
);
const mv3Manifest = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'bridge', 'manifest.chrome.json'), 'utf8')
);

const FILM_URL = 'https://cinecat.eu/media/tmdb-movie-550';
const FILM_KEY = pageKey(FILM_URL);
const NEXT_FILM_URL = 'https://cinecat.eu/media/tmdb-movie-680';
const NEXT_FILM_KEY = pageKey(NEXT_FILM_URL);

function fakeVideo({
  src = 'blob:https://cinecat.eu/player-1',
  duration = 3600,
  currentTime = 0,
  paused = true,
  readyState = 4,
  playbackRate = 1,
  volume = 1,
  buffered = null,
} = {}) {
  const video = {
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
    buffered: buffered || {
      length: 1,
      start: () => 0,
      end: () => duration,
    },
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
  return video;
}

function fakeDoc(video, href = FILM_URL, hostname = 'cinecat.eu') {
  return {
    location: { href, hostname },
    querySelector(selector) {
      return selector === 'video.html5-main-video, video' ? video : null;
    },
  };
}

// Deterministic PRNG (Mulberry32) so network jitter is realistic and repeatable.
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(values, p) {
  assert.ok(values.length > 0, 'percentile needs at least one sample');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

// ---------------------------------------------------------------------------
// 1. Rejoin seek against a non-restoring player
// ---------------------------------------------------------------------------

test('rejoin mid-playback against a non-restoring player at 0 s seeks on first applied frame with no seek loop', () => {
  let hostNow = 200_000;
  let guestNow = hostNow + 1900; // Guest clock +1900 ms ahead of host.
  const hostSent = [];
  const guestFrames = [];

  const host = createRoomClient({
    role: 'host',
    peerId: 'host',
    hostId: 'host',
    now: () => hostNow,
    send: (frame) => hostSent.push(frame),
    overlay: false,
  });

  const guestRoom = createRoomClient({
    role: 'peer',
    peerId: 'guest-rejoin',
    hostId: 'host',
    now: () => guestNow,
    send: (frame) => {
      // Deliver ping to host with 10 ms one-way transit, 10 ms return.
      const hostReply = [];
      const origSend = hostSent.length;
      const savedHostNow = hostNow;
      hostNow = savedHostNow + 10;
      host.receive(frame, hostNow);
      hostNow = savedHostNow;
      for (let i = origSend; i < hostSent.length; i += 1) hostReply.push(hostSent[i]);
      for (const reply of hostReply) guestRoom.receive(reply, guestNow + 20);
    },
    onMedia: (frame) => {
      guestFrames.push(frame);
      return true;
    },
    overlay: false,
  });

  // Calibrate guest clock via ping/pong before media arrives.
  guestRoom.tick(guestNow);
  assert.equal(guestRoom.publish().clockOffset, -1900);

  // Guest opens the film tab fresh: player starts at 0 s, never restores its own mark.
  const guestVideo = fakeVideo({ currentTime: 0, paused: true, readyState: 1 });
  const guestRelay = new RemoteMediaSync({
    document: fakeDoc(guestVideo),
    href: FILM_URL,
    hostname: 'cinecat.eu',
    now: () => guestNow,
  });

  // Host is already at 185 s playing.
  let hostPos = 185;
  host.sendHostMedia(
    { key: FILM_KEY, position: hostPos, playing: true, rate: 1, duration: 3600, at: hostNow },
    hostNow
  );
  // First frame arrives while guest player is still loading metadata (readyState < 2).
  guestRoom.receive(hostSent.at(-1), guestNow + 15);
  const firstFrame = guestFrames.at(-1);
  const loading = guestRelay.handle({
    key: firstFrame.key,
    position: firstFrame.expected,
    playing: firstFrame.playing,
    rate: firstFrame.rate,
    at: firstFrame.at,
  });
  assert.equal(loading.skipped, 'buffering');
  assert.equal(guestRelay.primed, false, 'a skipped buffering frame must not consume the seed seek');
  assert.equal(guestRelay.stats.seeks, 0);

  // Player finishes loading metadata at 0 s (non-restoring). Next frame is the first applied frame.
  guestVideo.readyState = 4;
  hostNow += HOST_TICK_MS;
  guestNow = hostNow + 1900;
  hostPos += HOST_TICK_MS / 1000;
  host.sendHostMedia(
    { key: FILM_KEY, position: hostPos, playing: true, rate: 1, duration: 3600, at: hostNow },
    hostNow
  );
  guestRoom.receive(hostSent.at(-1), guestNow + 15);
  const appliedFrame = guestFrames.at(-1);
  guestNow += 20;
  const seeded = guestRelay.handle({
    key: appliedFrame.key,
    position: appliedFrame.expected,
    playing: appliedFrame.playing,
    rate: appliedFrame.rate,
    at: appliedFrame.at,
  });
  assert.equal(seeded.action, 'seek', 'first applied frame seeks immediately from 0 s to 185.25 s');
  assert.equal(guestRelay.stats.seeks, 1);
  assert.equal(guestVideo.paused, false);
  assert.ok(Math.abs(guestVideo.currentTime - 185.27) < 0.05);

  // Hold steady for 60 ticks (15 seconds) of normal playback: zero extra seeks, no seek loop.
  for (let i = 1; i <= 60; i += 1) {
    hostNow += HOST_TICK_MS;
    guestNow = hostNow + 1900;
    hostPos += HOST_TICK_MS / 1000;
    guestVideo.currentTime += (HOST_TICK_MS / 1000) * guestVideo.playbackRate;

    host.sendHostMedia(
      { key: FILM_KEY, position: hostPos, playing: true, rate: 1, duration: 3600, at: hostNow },
      hostNow
    );
    guestRoom.receive(hostSent.at(-1), guestNow + 15);
    const f = guestFrames.at(-1);
    guestNow += 20;
    const step = guestRelay.handle({
      key: f.key,
      position: f.expected,
      playing: f.playing,
      rate: f.rate,
      at: f.at,
    });
    assert.notEqual(step.action, 'seek', `tick ${i} must not trigger a seek loop`);
    assert.ok(Math.abs(step.drift) < 0.05, `tick ${i} drift stayed tiny (${step.drift}s)`);
  }
  assert.equal(guestRelay.stats.seeks, 1, 'exactly one rejoin seek and zero seek loops');
});

test('rejoin against a paused host at 185 s pauses and seeks from 0 s with zero follow-up seeks', () => {
  let now = 50_000;
  // Guest player auto-started at 0 s without restoring the host mark.
  const video = fakeVideo({ currentTime: 0, paused: false });
  const sync = new RemoteMediaSync({
    document: fakeDoc(video),
    href: FILM_URL,
    hostname: 'cinecat.eu',
    now: () => now,
  });

  const first = sync.handle({ key: FILM_KEY, position: 185, playing: false, rate: 1, at: now });
  assert.equal(first.action, 'seek');
  assert.equal(video.paused, true, 'paused host stops an auto-playing guest player');
  assert.equal(video.currentTime, 185);
  assert.equal(video.playbackRate, 1);
  assert.equal(sync.stats.seeks, 1);

  for (let i = 1; i <= 20; i += 1) {
    now += HOST_TICK_MS;
    const step = sync.handle({ key: FILM_KEY, position: 185, playing: false, rate: 1, at: now });
    assert.equal(step.action, 'tick');
    assert.equal(video.paused, true);
    assert.equal(video.currentTime, 185);
  }
  assert.equal(sync.stats.seeks, 1);
});

test('first-frame rejoin gap > 0.25 s still seeks after an initial buffer wait or SPA film swap', () => {
  let now = 10_000;
  let bufferedEnd = 0.2;
  const video = fakeVideo({
    currentTime: 0,
    paused: true,
    buffered: { length: 1, start: () => 0, end: () => bufferedEnd },
  });
  const doc = fakeDoc(video, FILM_URL, 'cinecat.eu');
  const sync = new RemoteMediaSync({
    document: doc,
    href: FILM_URL,
    hostname: 'cinecat.eu',
    now: () => now,
  });

  // Gap is 0.6 s (> 0.25 s seed threshold, <= 1.0 s steady-state threshold) and target is not buffered yet.
  const waiting = sync.handle({ key: FILM_KEY, position: 0.6, playing: true, rate: 1, at: now });
  assert.equal(waiting.skipped, 'buffer');
  assert.equal(sync.primed, false, 'buffer wait must not drop the first-frame seed threshold');
  assert.equal(sync.stats.seeks, 0);

  // Buffer arrives 250 ms later: because primed stayed false, the first applied frame seeks immediately.
  now += 250;
  bufferedEnd = 60;
  const landed = sync.handle({ key: FILM_KEY, position: 0.85, playing: true, rate: 1, at: now });
  assert.equal(landed.action, 'seek', 'seed seek lands once buffer is ready even when gap <= 1 s');
  assert.equal(video.currentTime, 0.85);
  assert.equal(sync.primed, true);
  assert.equal(sync.stats.seeks, 1);

  // While a seek is still in flight (video.seeking === true), no spurious rate nudge is written.
  video.seeking = true;
  video.currentTime = 0;
  now += 250;
  const inflight = sync.handle({ key: FILM_KEY, position: 1.1, playing: true, rate: 1, at: now });
  assert.equal(inflight.action, 'tick');
  assert.equal(video.playbackRate, 1, 'an in-flight seek must not write a rate nudge');
  video.seeking = false;
  video.currentTime = 1.1;

  // SPA navigation to a different film resets primed so the new film starting at 0 s seeks at > 0.25 s.
  doc.location.href = NEXT_FILM_URL;
  video.currentTime = 0;
  now += 1000;
  const swapped = sync.handle({
    key: NEXT_FILM_KEY,
    position: RELAY_NUDGE_SECONDS + 0.15,
    playing: true,
    rate: 1,
    at: now,
  });
  assert.equal(swapped.action, 'seek', 'a new film key seeds fresh with the 0.25 s threshold');
  assert.equal(video.currentTime, RELAY_NUDGE_SECONDS + 0.15);
  assert.equal(sync.stats.seeks, 2);
});

test('direct sync client buffer wait does not charge cooldown or double-count seeks when buffer arrives early', () => {
  let bufferedEnd = 10;
  let local = 5000;
  const video = fakeVideo({
    src: FILM_URL,
    currentTime: 0,
    paused: false,
    duration: 600,
    buffered: { length: 1, start: () => 0, end: () => bufferedEnd },
  });
  const client = createRoomClient({
    role: 'peer',
    peerId: 'guest',
    hostId: 'host',
    now: () => local,
    mediaRoot: { querySelectorAll: () => [video] },
    send: () => {},
    overlay: false,
  });
  const hostSent = [];
  const host = createRoomClient({
    role: 'host',
    peerId: 'host',
    hostId: 'host',
    now: () => local,
    send: (frame) => hostSent.push(frame),
    overlay: false,
  });

  host.sendHostMedia(
    { key: FILM_URL, position: 185, playing: true, rate: 1, duration: 600, at: local },
    local
  );
  const waiting = client.receive(hostSent.at(-1), local);
  assert.equal(waiting.pending, 'buffer');
  assert.equal(client.drift.seeks, 0, 'waiting for buffer must not increment drift.seeks');

  // Buffer arrives 250 ms later (well before SEEK_BUFFER_WAIT_MS and inside SEEK_COOLDOWN_MS).
  local += 250;
  bufferedEnd = 600;
  host.sendHostMedia(
    { key: FILM_URL, position: 185.25, playing: true, rate: 1, duration: 600, at: local },
    local
  );
  const landed = client.receive(hostSent.at(-1), local);
  assert.equal(landed.step.action, 'seek', 'seek lands as soon as buffer is ready');
  assert.equal(video.currentTime, 185.25);
  assert.equal(client.drift.seeks, 1);
  assert.equal(client.stats.corrections, 1);
  assert.ok(SEEK_BUFFER_WAIT_MS > 250);
});

// ---------------------------------------------------------------------------
// 2. Three-peer 10+ minute drift & seek-budget simulation
// ---------------------------------------------------------------------------

test('three-peer 12-minute relayed playback holds p95 drift <= 250 ms and <= 1 correction seek per 10 min under clock offsets, jitter, mid-stream seek, and 600 ms spike', () => {
  const rand = mulberry32(0x20261120);
  const TOTAL_MS = 12 * 60 * 1000; // 12 simulated minutes (> 10 minutes).
  const MID_SEEK_AT = 5 * 60 * 1000; // Host seeks +120 s at minute 5.
  const SPIKE_NET_AT = 7 * 60 * 1000; // Single 600 ms network delivery spike at minute 7.
  const SPIKE_STALL_AT = 9 * 60 * 1000; // Single 600 ms local player stall on guest1 at minute 9.

  let simTime = 1_000_000;
  const hostOffset = 0;
  const guestConfigs = [
    { id: 'guest-mac', clockOffset: +1900, baseOneWayMs: 14, jitterMs: 16 },
    { id: 'guest-win', clockOffset: -850, baseOneWayMs: 22, jitterMs: 20 },
  ];

  // Event queue ordered by delivery simTime.
  const wireQueue = [];
  function schedule(deliverAt, fn) {
    wireQueue.push({ at: deliverAt, fn });
  }
  function drainUntil(limitSimTime) {
    wireQueue.sort((a, b) => a.at - b.at);
    while (wireQueue.length && wireQueue[0].at <= limitSimTime) {
      const next = wireQueue.shift();
      next.fn(next.at);
    }
  }

  let hostPos = 185; // Host already mid-film when guests join!
  const hostNow = () => simTime + hostOffset;

  const host = createRoomClient({
    role: 'host',
    peerId: 'host',
    hostId: 'host',
    now: hostNow,
    send: (frame) => {
      for (const peer of peers) {
        const oneWay =
          peer.cfg.baseOneWayMs + Math.round(rand() * peer.cfg.jitterMs);
        const isSpike =
          simTime === 1_000_000 + SPIKE_NET_AT && !peer.netSpikeInjected;
        if (isSpike) peer.netSpikeInjected = true;
        const transit = oneWay + (isSpike ? 600 : 0);
        schedule(simTime + transit, (arrivedAt) => {
          peer.deliverFromHost(frame, arrivedAt);
        });
      }
    },
    overlay: false,
  });

  const peers = guestConfigs.map((cfg) => {
    // Non-restoring players start at 0 s!
    const video = fakeVideo({ currentTime: 0, paused: true, duration: 3600 });
    let lastAdvanceSim = simTime;
    let currentLocal = simTime + cfg.clockOffset;

    const advanceVideo = (toSimTime) => {
      const dtMs = toSimTime - lastAdvanceSim;
      if (dtMs > 0 && !video.paused) {
        video.currentTime += (dtMs / 1000) * video.playbackRate;
      }
      lastAdvanceSim = toSimTime;
    };

    const relay = new RemoteMediaSync({
      document: fakeDoc(video),
      href: FILM_URL,
      hostname: 'cinecat.eu',
      now: () => currentLocal,
    });

    const room = createRoomClient({
      role: 'peer',
      peerId: cfg.id,
      hostId: 'host',
      now: () => currentLocal,
      send: (frame) => {
        const oneWay = cfg.baseOneWayMs + Math.round(rand() * cfg.jitterMs);
        schedule(simTime + oneWay, (arrivedAt) => {
          const prev = simTime;
          simTime = arrivedAt;
          host.receive(frame, hostNow());
          simTime = prev;
        });
      },
      onMedia: (frame) => {
        // Simulate a 4-14 ms local browser IPC hop from room tab to film tab.
        const ipcMs = 4 + Math.round(rand() * 10);
        schedule(currentLocal - cfg.clockOffset + ipcMs, (filmSimTime) => {
          advanceVideo(filmSimTime);
          currentLocal = filmSimTime + cfg.clockOffset;
          const res = relay.handle({
            key: frame.key,
            position: frame.expected,
            playing: frame.playing,
            rate: frame.rate,
            at: frame.at,
          });
          peerState.record(filmSimTime, res);
        });
        return true;
      },
      overlay: false,
    });

    const peerState = {
      cfg,
      video,
      relay,
      room,
      netSpikeInjected: false,
      converged: false,
      seeksAfterConvergence: 0,
      hostSeekWindowUntil: 0,
      hostSeekFollowed: 0,
      driftSamplesMs: [],
      advanceVideo,
      setClock(atSimTime) {
        currentLocal = atSimTime + cfg.clockOffset;
      },
      deliverFromHost(frame, arrivedAt) {
        advanceVideo(arrivedAt);
        currentLocal = arrivedAt + cfg.clockOffset;
        room.receive(frame, currentLocal);
      },
      record(atSimTime, res) {
        if (!res || !res.ok) return;
        const elapsed = atSimTime - 1_000_000;
        if (!this.converged && res.action === 'seek') {
          this.converged = true;
          return;
        }
        if (this.converged && elapsed > 2000) {
          if (res.action === 'seek') {
            if (atSimTime <= this.hostSeekWindowUntil) {
              this.hostSeekFollowed += 1;
            } else {
              this.seeksAfterConvergence += 1;
            }
          } else if (atSimTime > this.hostSeekWindowUntil) {
            this.driftSamplesMs.push(Math.abs(res.drift) * 1000);
          }
        }
      },
    };
    return peerState;
  });

  // Initial clock calibration pings before first media frame.
  for (const peer of peers) {
    peer.setClock(simTime);
    peer.room.tick(simTime + peer.cfg.clockOffset);
  }
  drainUntil(simTime + 200);
  for (const peer of peers) {
    assert.ok(peer.room.clock.samples >= 1, `${peer.cfg.id} calibrated its clock`);
    assert.ok(
      Math.abs(peer.room.clock.offset() - -peer.cfg.clockOffset) <= 25,
      `${peer.cfg.id} clock offset accurate within half-RTT`
    );
  }

  // Run 12 simulated minutes at 250 ms host tick cadence.
  const startSim = 1_000_000;
  for (let elapsed = 0; elapsed <= TOTAL_MS; elapsed += HOST_TICK_MS) {
    simTime = startSim + elapsed;
    drainUntil(simTime);

    // Mid-stream host seek (+120 s) at minute 5.
    if (elapsed === MID_SEEK_AT) {
      hostPos += 120;
      for (const peer of peers) peer.hostSeekWindowUntil = simTime + 1500;
    }

    // Single 600 ms local player stall on guest-mac at minute 9.
    if (elapsed === SPIKE_STALL_AT) {
      peers[0].advanceVideo(simTime);
      peers[0].video.currentTime -= 0.6;
    }

    // Drive each peer tick at 250 ms cadence so ClockEstimator pings every PING_INTERVAL_MS.
    for (const peer of peers) {
      peer.setClock(simTime);
      peer.room.tick(simTime + peer.cfg.clockOffset);
    }

    // Host film tab sampled 10-80 ms before the room tab sends it.
    const reportAgeMs = 10 + Math.round(rand() * 70);
    const sampledPos = hostPos - reportAgeMs / 1000;
    host.sendHostMedia(
      {
        key: FILM_KEY,
        position: sampledPos,
        playing: true,
        rate: 1,
        duration: 3600,
        at: simTime - reportAgeMs,
      },
      simTime
    );

    hostPos += HOST_TICK_MS / 1000;
  }
  drainUntil(startSim + TOTAL_MS + 2000);

  for (const peer of peers) {
    assert.equal(peer.converged, true, `${peer.cfg.id} converged via rejoin seek`);
    assert.equal(peer.hostSeekFollowed, 1, `${peer.cfg.id} followed the mid-stream host seek once`);
    assert.ok(peer.room.clock.samples >= 20, `${peer.cfg.id} kept refreshing clock samples`);
    assert.ok(peer.driftSamplesMs.length >= 2500, `${peer.cfg.id} recorded 10+ min of samples`);

    const p95 = percentile(peer.driftSamplesMs, 0.95);
    const p50 = percentile(peer.driftSamplesMs, 0.5);
    assert.ok(
      p95 <= 250,
      `${peer.cfg.id} p95 drift ${p95.toFixed(1)} ms exceeded 250 ms budget (p50=${p50.toFixed(1)} ms)`
    );
    assert.ok(
      peer.seeksAfterConvergence <= 1,
      `${peer.cfg.id} ran ${peer.seeksAfterConvergence} correction seeks in 12 min (budget <= 1 per 10 min)`
    );
  }

  // Verify hysteresis brought guest-mac cleanly back below RELAY_NUDGE_STOP_SECONDS after the 600 ms stall.
  const tailDrifts = peers[0].driftSamplesMs.slice(-40);
  const tailMax = Math.max(...tailDrifts);
  assert.ok(
    tailMax <= RELAY_NUDGE_STOP_SECONDS * 1000 + 30,
    `post-stall tail drift settled inside hysteresis band (got ${tailMax.toFixed(1)} ms)`
  );
  assert.equal(
    peers[0].relay.stats.seeks,
    2,
    'guest-mac needed only initial rejoin seek + mid-stream host seek (0 extra seeks for 600 ms stall)'
  );
});

test('three-peer 10+ minute direct MediaAdapter sync handles 600 ms stall with <= 1 seek and <= 250 ms p95 drift', () => {
  const rand = mulberry32(0x1337c0de);
  const TOTAL_MS = 10 * 60 * 1000 + 15_000; // 10 min 15 s.
  const MID_SEEK_AT = 4 * 60 * 1000;
  const STALL_AT = 7 * 60 * 1000;

  let simTime = 2_000_000;
  const wireQueue = [];
  const schedule = (at, fn) => wireQueue.push({ at, fn });
  const drainUntil = (limit) => {
    wireQueue.sort((a, b) => a.at - b.at);
    while (wireQueue.length && wireQueue[0].at <= limit) {
      const item = wireQueue.shift();
      item.fn(item.at);
    }
  };

  let hostPos = 90;
  const host = createRoomClient({
    role: 'host',
    peerId: 'host',
    hostId: 'host',
    now: () => simTime,
    send: (frame) => {
      for (const peer of peers) {
        const transit = peer.cfg.baseOneWayMs + Math.round(rand() * peer.cfg.jitterMs);
        schedule(simTime + transit, (arrivedAt) => peer.deliver(frame, arrivedAt));
      }
    },
    overlay: false,
  });

  const peers = [
    { id: 'peer-a', clockOffset: +1900, baseOneWayMs: 12, jitterMs: 14 },
    { id: 'peer-b', clockOffset: -850, baseOneWayMs: 18, jitterMs: 18 },
  ].map((cfg) => {
    const video = fakeVideo({ src: FILM_URL, currentTime: 0, paused: true, duration: 3600 });
    let lastSim = simTime;
    let local = simTime + cfg.clockOffset;
    const advance = (toSim) => {
      const dt = toSim - lastSim;
      if (dt > 0 && !video.paused) video.currentTime += (dt / 1000) * video.playbackRate;
      lastSim = toSim;
    };
    const client = createRoomClient({
      role: 'peer',
      peerId: cfg.id,
      hostId: 'host',
      now: () => local,
      mediaRoot: { querySelectorAll: () => [video] },
      send: (frame) => {
        const transit = cfg.baseOneWayMs + Math.round(rand() * cfg.jitterMs);
        schedule(simTime + transit, (arrivedAt) => {
          const prev = simTime;
          simTime = arrivedAt;
          host.receive(frame, simTime);
          simTime = prev;
        });
      },
      overlay: false,
    });
    return {
      cfg,
      video,
      client,
      advance,
      converged: false,
      hostSeekWindowUntil: 0,
      hostSeekFollowed: 0,
      correctionSeeks: 0,
      driftMs: [],
      tickClock(atSim) {
        local = atSim + cfg.clockOffset;
        client.tick(local);
      },
      deliver(frame, arrivedAt) {
        advance(arrivedAt);
        local = arrivedAt + cfg.clockOffset;
        const res = client.receive(frame, local);
        if (!res || !res.step) return;
        if (!this.converged && res.step.action === 'seek') {
          this.converged = true;
          return;
        }
        if (this.converged && arrivedAt - 2_000_000 > 2000) {
          if (res.step.action === 'seek') {
            if (arrivedAt <= this.hostSeekWindowUntil) this.hostSeekFollowed += 1;
            else this.correctionSeeks += 1;
          } else if (arrivedAt > this.hostSeekWindowUntil) {
            this.driftMs.push(Math.abs(res.driftMs));
          }
        }
      },
    };
  });

  // Initial clock calibration.
  for (const peer of peers) peer.tickClock(simTime);
  drainUntil(simTime + 200);

  const startSim = 2_000_000;
  for (let elapsed = 0; elapsed <= TOTAL_MS; elapsed += HOST_TICK_MS) {
    simTime = startSim + elapsed;
    drainUntil(simTime);

    if (elapsed === MID_SEEK_AT) {
      hostPos += 95;
      for (const peer of peers) peer.hostSeekWindowUntil = simTime + 1500;
    }
    if (elapsed === STALL_AT) {
      // Single 600 ms stall on peer-b causes exactly 1 seek and no seek loop.
      peers[1].advance(simTime);
      peers[1].video.currentTime -= 0.6;
    }
    for (const peer of peers) peer.tickClock(simTime);

    host.sendHostMedia(
      { key: FILM_URL, position: hostPos, playing: true, rate: 1, duration: 3600, at: simTime },
      simTime
    );
    hostPos += HOST_TICK_MS / 1000;
  }
  drainUntil(startSim + TOTAL_MS + 1000);

  for (const peer of peers) {
    assert.ok(peer.client.clock.samples >= 18, `${peer.cfg.id} refreshed clock periodically (${PING_INTERVAL_MS} ms)`);
    assert.equal(peer.converged, true);
    assert.equal(peer.hostSeekFollowed, 1);
    const p95 = percentile(peer.driftMs, 0.95);
    assert.ok(p95 <= 250, `${peer.cfg.id} direct p95 drift ${p95} ms exceeded 250 ms`);
    assert.ok(
      peer.correctionSeeks <= 1,
      `${peer.cfg.id} direct correction seeks ${peer.correctionSeeks} exceeded 1 per 10 min`
    );
  }
  assert.equal(peers[0].correctionSeeks, 0, 'unstalled peer needs 0 correction seeks');
  assert.equal(peers[1].correctionSeeks, 1, '600 ms stall causes exactly 1 correction seek and no loop');
});

test('applyMedia scales transit extrapolation by playback rate when host plays faster than 1x', () => {
  let hostNow = 100_000;
  const sent = [];
  const host = createRoomClient({
    role: 'host',
    peerId: 'host',
    hostId: 'host',
    now: () => hostNow,
    send: (frame) => sent.push(frame),
    overlay: false,
  });

  let guestNow = 100_000;
  const relayed = [];
  const guest = createRoomClient({
    role: 'peer',
    peerId: 'guest',
    hostId: 'host',
    now: () => guestNow,
    onMedia: (frame) => {
      relayed.push(frame);
      return true;
    },
    overlay: false,
  });

  host.sendHostMedia(
    { key: FILM_KEY, position: 50, playing: true, rate: 2, duration: 600, at: hostNow },
    hostNow
  );
  // 200 ms transit at 2x speed equals 0.4 s of media progress -> expected 50.4 s.
  guestNow = hostNow + 200;
  guest.receive(sent.at(-1), guestNow);
  assert.ok(
    Math.abs(relayed.at(-1).expected - 50.4) < 0.001,
    `expected 50.4 s at 2x rate, got ${relayed.at(-1).expected}`
  );
});

// ---------------------------------------------------------------------------
// 3. Ctrl+Alt+B / open-room-panel command wiring (MV2 & MV3)
// ---------------------------------------------------------------------------

function loadBackgroundWithCommand({
  engine = 'gecko',
  roomTabUrl = 'http://127.0.0.1:8787/?role=host&room=test&peer=host',
  rejectPopup = false,
} = {}) {
  const tabs = [{ id: 7, url: roomTabUrl, active: true }];
  const sent = [];
  let commandListener = null;
  let handlingUserInput = false;
  let popupCalls = 0;
  let popupCalledSynchronously = false;

  const openPopup = () => {
    popupCalls += 1;
    if (!handlingUserInput) {
      return Promise.reject(
        new Error('openPopup may only be called from a user input handler')
      );
    }
    popupCalledSynchronously = true;
    if (rejectPopup) return Promise.reject(new Error('no browser window'));
    return Promise.resolve();
  };

  const api = {
    storage: {
      session: {
        // Yield through a real microtask/timer tick just like browser.storage.session.get.
        get: () => new Promise((resolve) => setTimeout(() => resolve({}), 5)),
        set: async () => {},
      },
      local: {
        get: async () => ({}),
        set: async () => {},
      },
    },
    tabs: {
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
      onActivated: { addListener: () => {} },
      query: async () => tabs.slice(),
      get: async (id) => tabs.find((tab) => tab.id === id) || null,
      create: async ({ url }) => ({ id: 99, url, active: false }),
      update: async () => {},
      remove: async () => {},
      sendMessage: async (tabId, message) => {
        sent.push({ tabId, message });
        return { ok: true };
      },
    },
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: async () => ({ ok: true }),
    },
    commands: {
      onCommand: {
        addListener: (fn) => {
          commandListener = fn;
        },
      },
    },
  };

  if (engine === 'gecko') {
    api.browserAction = { openPopup };
  } else {
    api.action = { openPopup };
  }

  const ctx = {
    URL,
    setTimeout,
    clearTimeout,
    console,
  };
  if (engine === 'gecko') ctx.browser = api;
  else ctx.chrome = api;

  vm.createContext(ctx);
  vm.runInContext(bgSource, ctx);

  return {
    sent,
    get popupCalls() {
      return popupCalls;
    },
    get popupCalledSynchronously() {
      return popupCalledSynchronously;
    },
    fireCommand(command) {
      assert.ok(commandListener, 'commands.onCommand listener must be registered');
      handlingUserInput = true;
      let pending;
      try {
        pending = commandListener(command);
      } finally {
        handlingUserInput = false;
      }
      return pending;
    },
  };
}

test('both MV2 and MV3 manifests declare open-room-panel and the anchored popup', () => {
  assert.equal(mv2Manifest.manifest_version, 2);
  assert.equal(mv2Manifest.commands['open-room-panel'].suggested_key.default, 'Ctrl+Alt+B');
  assert.equal(mv2Manifest.commands['open-room-panel'].suggested_key.mac, 'MacCtrl+Alt+B');
  assert.equal(mv2Manifest.browser_action.default_popup, 'panel/room.html?surface=popup');

  assert.equal(mv3Manifest.manifest_version, 3);
  assert.ok(
    mv3Manifest.commands['open-room-panel'] &&
      mv3Manifest.commands['open-room-panel'].suggested_key.default &&
      mv3Manifest.commands['open-room-panel'].suggested_key.mac,
    'MV3 manifest declares open-room-panel with default and mac suggested keys'
  );
  assert.equal(mv3Manifest.action.default_popup, 'panel/room.html?surface=popup');
});

test('Ctrl+Alt+B open-room-panel invokes browserAction.openPopup synchronously on MV2 Gecko and notifies the room tab', async () => {
  const harness = loadBackgroundWithCommand({ engine: 'gecko' });
  const results = await harness.fireCommand('open-room-panel');

  assert.equal(harness.popupCalls, 1);
  assert.equal(
    harness.popupCalledSynchronously,
    true,
    'browserAction.openPopup must be invoked synchronously before awaiting roomTab()'
  );
  assert.equal(results[0].ok, true);
  assert.equal(results[0].surface, 'popup');
  assert.deepEqual(JSON.parse(JSON.stringify(harness.sent)), [
    { tabId: 7, message: { type: 'brosr:command', command: 'open-room-panel' } },
  ]);
});

test('open-room-panel invokes action.openPopup synchronously on MV3 Chromium and ignores unrelated commands', async () => {
  const harness = loadBackgroundWithCommand({ engine: 'chrome' });

  await harness.fireCommand('unrelated-command');
  assert.equal(harness.popupCalls, 0);
  assert.equal(harness.sent.length, 0);

  const results = await harness.fireCommand('open-room-panel');
  assert.equal(harness.popupCalls, 1);
  assert.equal(
    harness.popupCalledSynchronously,
    true,
    'chrome.action.openPopup must be invoked synchronously inside the command user gesture'
  );
  assert.equal(results[0].ok, true);
  assert.equal(results[0].surface, 'popup');
  assert.deepEqual(JSON.parse(JSON.stringify(harness.sent)), [
    { tabId: 7, message: { type: 'brosr:command', command: 'open-room-panel' } },
  ]);
});

test('open-room-panel still delivers brosr:command to the room tab when openPopup is refused', async () => {
  const harness = loadBackgroundWithCommand({ engine: 'gecko', rejectPopup: true });
  const results = await harness.fireCommand('open-room-panel');

  assert.equal(harness.popupCalls, 1);
  assert.equal(harness.popupCalledSynchronously, true);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].reason, 'popup-refused');
  assert.deepEqual(JSON.parse(JSON.stringify(harness.sent)), [
    { tabId: 7, message: { type: 'brosr:command', command: 'open-room-panel' } },
  ]);
});

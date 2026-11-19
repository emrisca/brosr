import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const require = createRequire(import.meta.url);
const { buildSyncReport } = require(path.join(root, 'bridge', 'panel', 'sync-report.js'));

const NOW = Date.parse('2026-11-18T19:04:12.000Z');

const reply = {
  room: 'room-1',
  role: 'host',
  data: {
    roomName: 'Friday',
    role: 'host',
    peerId: 'host-1',
    build: { version: '0.4.0' },
    socket: 1,
    reconnects: 1,
    playing: true,
    peers: 2,
    peerList: [
      {
        id: 'host-1',
        name: 'Ada',
        self: true,
        build: { version: '0.4.0' },
        granted: false,
      },
      {
        id: 'guest-1',
        name: 'Bob',
        self: false,
        build: { version: '0.3.9' },
        granted: true,
      },
    ],
    media: {
      key: 'https://www.youtube.com/watch?v=abc&token=secret#frag',
      title: 'A film',
      position: 62.4,
      localPosition: 61.9,
      playing: true,
      buffering: false,
      ad: false,
      open: true,
      behind: 0.5,
      inSync: true,
    },
    viewers: [
      {
        id: 'guest-1',
        at: NOW - 2000,
        viewer: {
          open: true,
          playing: true,
          buffering: false,
          ad: false,
          behind: 0.4,
          inSync: true,
        },
      },
    ],
    align: { offsetMs: -1200 },
    lastMediaAction: {
      name: 'Bob',
      action: 'pause',
      text: 'Bob paused the video',
      at: NOW - 1000,
    },
    mediaDrops: { 'host-priority': 2, hold: 1 },
    lastMediaDrop: {
      reason: 'host-priority',
      action: 'seek',
      peerId: 'guest-1',
      at: NOW - 500,
    },
    seeks: 2,
    nudges: 4,
    corrections: 1,
    stuckSeeks: 0,
    relayed: 3,
    mediaEcho: 2,
    firstDrift: 0.8,
    convergedAt: NOW - 500,
    controlSent: 1,
    controlReceived: 0,
    lastControl: { peerId: 'guest-1', allowed: true, mine: false },
    controlHistory: [{ peerId: 'guest-1', allowed: true, roomTime: 5000 }],
    latency: { n: 10, p50: 20, p95: 45, max: 80 },
    clockOffset: 12,
    driftRate: 1.002,
    sampleCount: 12,
    sameFate: true,
    seal: { mode: 'on' },
    debug: {
      expected: 62.7,
      actual: 62.2,
      driftMs: -500,
      paused: false,
      seeking: false,
      readyState: 4,
      lastSeekTarget: 62.2,
    },
    location: 'https://www.youtube.com/watch?v=abc&token=secret#k=invite',
  },
};

const reading = {
  ok: true,
  relay: {
    applies: 42,
    last: { drift: -0.2 },
    stats: { bufferWaits: 3, bufferHolds: 2, stuckSeeks: 1, seeks: 5, skips: 9 },
    localDrops: { echo: 2 },
    lastLocalDrop: { reason: 'echo', action: 'pause', at: NOW - 250 },
  },
};

test('the sync report carries the room, both sides and the film reading', () => {
  const text = buildSyncReport(reply, reading, {
    now: NOW,
    userAgent: 'TestBrowser/1.0',
    surface: 'popup',
    route: 'tab',
  });

  assert.match(text, /^Brosr sync report/);
  assert.match(text, /Room: Friday/);
  assert.match(text, /Role: host/);
  assert.match(text, /Bridge: 0\.4\.0/);
  assert.match(text, /Relay: live, 1 reconnects/);
  assert.match(text, /Page: https:\/\/www\.youtube\.com\/watch$/m);
  assert.match(text, /Film: www\.youtube\.com|Film: youtube\.com/);
  assert.match(text, /Film key: https:\/\/www\.youtube\.com\/watch\?v=abc/);
  assert.match(text, /Room position: 1:02\.4/);
  assert.match(text, /Local position: 1:01\.9/);
  assert.match(text, /Local gap: 0\.50 s behind the room/);
  assert.match(
    text,
    /Reading: 42 applied · 0\.20 s on the last frame · 0\.50 s from the room · 3 buffer waits · 1 stuck seek/
  );
  assert.match(text, /Last media action: Bob paused the video at 2026-11-18T19:04:11\.000Z/);
  assert.match(text, /Dropped media acts: host-priority=2, hold=1, film-tab echo=2/);
  assert.match(
    text,
    /Last media drop: pause from film tab \(echo\) at 2026-11-18T19:04:11\.750Z/
  );
  assert.match(text, /"mediaDrops":\{"host-priority":2,"hold":1\}/);
  assert.match(text, /"lastLocalDrop":\{"reason":"echo"/);
  assert.match(text, /Build warning: Bob runs 0\.3\.9; this room runs 0\.4\.0\./);
  assert.match(text, /Bob: open, playing, 0\.40 s behind the room, in sync/);
  assert.match(text, /Media debug: \{"expected":62\.7/);
  assert.match(text, /seeks=2, nudges=4/);
  assert.match(text, /"bufferWaits":3/);
});

test('the sync report leaves invite keys and token parameters out', () => {
  const text = buildSyncReport(reply, reading, { now: NOW });
  assert.doesNotMatch(text, /token=secret/);
  assert.doesNotMatch(text, /#k=invite/);
  assert.doesNotMatch(text, /undefined/);
});

test('the report says why a film reading is missing', () => {
  const text = buildSyncReport(
    {
      data: {
        roomName: 'Room',
        media: { key: 'youtube:abc', position: 1, playing: false, open: false },
      },
    },
    null,
    { now: NOW, readingReply: { ok: false, reason: 'timeout' } }
  );
  assert.match(text, /Film: YouTube film/);
  assert.match(text, /Reading: unavailable \(timeout\)/);
});

test('the panel button is wired to the report builder and the clipboard', () => {
  const html = fs.readFileSync(path.join(root, 'bridge', 'panel', 'room.html'), 'utf8');
  const panel = fs.readFileSync(path.join(root, 'bridge', 'panel', 'room.js'), 'utf8');
  assert.match(html, /id="copy-sync"/);
  assert.match(html, /<script src="sync-report\.js"><\/script>\s*<script src="room\.js"><\/script>/);
  assert.match(panel, /function reportText\(\)/);
  assert.match(panel, /buildSyncReport\(lastReply, filmReading/);
  assert.match(panel, /navigator\.clipboard\.writeText\(text\)/);
  assert.match(panel, /legacyCopy\(text\)/);
});

#!/usr/bin/env node
// A room peer for the other machine. Every harness lane opens its pages on one
// machine, so a LAN hour or a LAN game needs a peer that lives across the hop.
// This one speaks the room protocol directly and journals what the soak reads,
// so the numbers come from the same publish() the pages use.

import fs from 'node:fs';
import path from 'node:path';
import { createRoomClient } from '../core/sync.mjs';

const args = new Map();
for (const raw of process.argv.slice(2)) {
  const parsed = /^--([^=]+)(?:=(.*))?$/.exec(raw);
  if (parsed) args.set(parsed[1], parsed[2] === undefined ? '1' : parsed[2]);
}

const relay = args.get('relay') || '127.0.0.1';
const port = Number(args.get('port') || 8787);
const room = args.get('room') || 'soak';
const peerId = args.get('peer') || 'mac';
const name = args.get('name') || 'Mac';
const hostId = args.get('host') || 'host';
const seconds = Number(args.get('seconds') || 60);
const game = args.get('game') === '1';
const out = args.get('out') || path.join('.runtime', `peer-${room}.json`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const journal = {
  relay,
  port,
  room,
  peerId,
  name,
  game,
  startedAt: new Date().toISOString(),
  endedAt: null,
  reconnects: 0,
  reconnectsAt: [],
  samples: [],
  statesReceived: 0,
  last: null,
};

let socket = null;
let leaving = false;
let retryTimer = null;
let samples = 0;
let lastLine = 0;

const client = createRoomClient({
  role: 'peer',
  room,
  peerId,
  hostId,
  name,
  colour: '#3f86e2',
  overlay: false,
  now: () => Date.now(),
  send: (frame) => {
    if (socket && socket.readyState === 1) socket.send(frame);
  },
  onApp: (message) => {
    if (!game || peerId === message.from) return;
    if (message.name !== 'state') return;
    const data = message.data || {};
    journal.statesReceived += 1;
    journal.last = {
      seq: data.seq || 0,
      scores: data.scores || null,
      paddles: data.paddles || null,
      ball: data.ball || null,
      at: new Date().toISOString(),
    };
  },
});

function write() {
  journal.endedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(journal, null, 2));
}

function sample() {
  const status = client.publish();
  journal.samples.push({
    at: new Date().toISOString(),
    peers: status.peers,
    // A snapshot copies the host's whole peer table, so an id that the host
    // still lists arrives here as a peer. The ids name it.
    peerIds: (status.peerList || []).map((peer) => peer.id),
    rtt: status.rtt,
    scroll: status.scroll,
    granted: Boolean(status.granted),
    latency: status.latency,
    app: status.app,
    game: game ? { statesReceived: journal.statesReceived, last: journal.last } : null,
  });
  samples += 1;
  if (samples % 10 === 0) write();
  if (Date.now() - lastLine >= 30000) {
    lastLine = Date.now();
    const p95 = status.latency ? status.latency.p95 : 'none';
    console.log(
      `[peer] room=${room} samples=${samples} peers=${status.peers} granted=${Boolean(
        status.granted
      )} scroll=${status.scroll} p95=${p95} app=${status.app.sent}/${status.app.received}`
    );
  }
}

// A refused port fires an error and no close, so both events ask for the same
// retry. A relay that dies under an open socket can also wait for a write to
// notice, and the presence frame at 100 ms supplies it.
function scheduleReconnect(delay = 500) {
  if (leaving || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, delay);
}

function connect() {
  if (leaving) return;
  socket = new WebSocket(
    `ws://${relay}:${port}/room?room=${encodeURIComponent(room)}&role=peer&peer=${encodeURIComponent(
      peerId
    )}`
  );
  socket.onmessage = (event) => client.receive(String(event.data), Date.now());
  socket.onopen = () => {
    console.log(`[peer] joined ws://${relay}:${port}/room room=${room} peer=${peerId}`);
    client.hello();
    client.tick(Date.now());
  };
  socket.onclose = () => {
    if (leaving) return;
    journal.reconnects += 1;
    journal.reconnectsAt.push(new Date().toISOString());
    scheduleReconnect(Math.min(5000, 250 * journal.reconnects));
  };
  socket.onerror = () => scheduleReconnect();
}

connect();
const ticker = setInterval(() => client.tick(Date.now()), 50);
const presence = setInterval(
  () =>
    client.presence({
      id: peerId,
      name,
      colour: '#3f86e2',
      point: { x: 160, y: 120 },
    }),
  100
);
const sampler = setInterval(sample, 1000);

// The peer paddle moves at 10 Hz, like the browser page does. One frame a
// second still tracks, but it would not match the loopback game row.
const paddles = setInterval(() => {
  if (!game) return;
  if (!socket || socket.readyState !== 1) return;
  client.sendApp('paddle', { y: Math.round(180 + Math.sin(Date.now() / 500) * 120) });
}, 100);

async function stop(reason) {
  if (leaving) return;
  leaving = true;
  clearInterval(ticker);
  clearInterval(presence);
  clearInterval(sampler);
  clearInterval(paddles);
  write();
  try {
    if (socket) socket.close();
  } catch {
    // Already closed.
  }
  const status = client.publish();
  console.log(
    `[peer] stopped (${reason}) after ${samples} samples; last latency ${JSON.stringify(
      status.latency
    )}; reconnects ${journal.reconnects}`
  );
  await sleep(200);
  process.exit(0);
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
setTimeout(() => stop('duration'), seconds * 1000);

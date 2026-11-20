// The app-side half of the room control channel. It joins the relay as a
// loopback panel peer, sends one app message, waits for the host tab's answer,
// and closes. The host tab checks the token before it changes anything.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { formatAddress } from '../core/friends.mjs';
import { PANEL_APP, PANEL_PEER } from '../core/panel.mjs';
import { decode, encode } from '../core/protocol.mjs';
import { openFrame, roomKey, sealFrame } from '../core/seal.mjs';
import { readJoin, readRun, RUN_DIR } from './room.mjs';

const TIMEOUT_MS = 8000;
const require = createRequire(import.meta.url);
const { buildSyncReport } = require('../bridge/panel/sync-report.js');

// One line per rate correction a film tab ran, on the host machine. A film
// that keeps getting slower shows as a run of entries where the element rate
// sits away from the room rate, which is the record a decay leaves on disk.
const MEDIA_LOG = path.join(RUN_DIR, 'media-sync.jsonl');
const MEDIA_LOG_LIMIT = 512 * 1024;

export function rateLogLines(data) {
  const rate = data && data.reading && data.reading.rate;
  if (!rate || !Array.isArray(rate.trace)) return [];
  const out = [];
  for (const entry of rate.trace) {
    if (!entry || !Number.isFinite(Number(entry.at))) continue;
    out.push({
      at: Number(entry.at),
      room: data.room || null,
      peer: data.peerId || null,
      role: data.role || null,
      kind: entry.kind || null,
      roomRate: entry.roomRate,
      elementRate: entry.elementRate,
      drift: entry.drift,
    });
  }
  return out;
}

function appendRateLog(data) {
  const entries = rateLogLines(data);
  if (!entries.length) return;
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    // Each status read is a new process, so the newest line in the file is the
    // cursor. A rate entry is written once, not on every poll.
    let seen = -Infinity;
    try {
      const text = fs.readFileSync(MEDIA_LOG, 'utf8').trimEnd();
      const last = JSON.parse(text.slice(text.lastIndexOf('\n') + 1) || '{}');
      if (Number.isFinite(Number(last.at))) seen = Number(last.at);
    } catch {
      // A new room or a half written tail starts the file again.
    }
    const fresh = entries.filter((entry) => entry.at > seen);
    if (!fresh.length) return;
    fs.appendFileSync(MEDIA_LOG, fresh.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    // The newest lines matter, so a limit keeps the tail instead of the head.
    if (fs.statSync(MEDIA_LOG).size > MEDIA_LOG_LIMIT) {
      const tail = fs.readFileSync(MEDIA_LOG, 'utf8').slice(-MEDIA_LOG_LIMIT);
      fs.writeFileSync(MEDIA_LOG, tail.slice(tail.indexOf('\n') + 1));
    }
  } catch {
    // A read only state folder must not break the controls.
  }
}

// The room tab sends the current room and film readings. The app shows the
// same report in Room controls, so the host turns that state into one text log
// before it crosses the loopback socket.
function withRoomLog(state) {
  if (!state || !state.diagnostics) return state;
  const data = {
    ...state.diagnostics,
    role: state.diagnostics.role || state.role,
    peerId: state.diagnostics.peerId || state.peerId,
  };
  appendRateLog(data);
  return {
    ...state,
    logFile: MEDIA_LOG,
    log: buildSyncReport(
      { room: data.room, roomName: data.roomName, role: data.role, data },
      data.reading || null,
      {
        now: Date.now(),
        surface: 'host app',
        readingReply: data.readingReply || null,
        logFile: MEDIA_LOG,
      }
    ),
  };
}

export async function panelCommand({ action = 'status', ...params } = {}, { guest = false } = {}) {
  // The host tab owns the full control state. A guest tab owns a read-only
  // people view, and its token lives in join.json instead of room.json.
  const record = guest ? readJoin() : readRun();
  if (!record || !record.panelToken) {
    throw new Error(
      guest
        ? 'Join a room before reading its people.'
        : 'Open a room before using its controls.'
    );
  }
  const host = record.host === '0.0.0.0' ? '127.0.0.1' : record.host || '127.0.0.1';
  const requestId = crypto.randomUUID();
  const inviteKey = (() => {
    try {
      return new URLSearchParams(new URL(record.url).hash.replace(/^#/, '')).get('k');
    } catch {
      return null;
    }
  })();
  const key = inviteKey ? await roomKey(inviteKey) : null;
  const url =
    `ws://${formatAddress(host, record.port)}/room` +
    `?room=${encodeURIComponent(record.room)}&role=panel&peer=${PANEL_PEER}`;
  const plain = encode({
    type: 'app',
    peerId: PANEL_PEER,
    name: PANEL_APP,
    data: { token: record.panelToken, requestId, action, ...params },
    roomTime: Date.now(),
  });
  const frame = key
    ? sealFrame(key, new TextEncoder().encode(plain), { room: record.room })
    : plain;

  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(url);
    const finish = (error, state) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // The socket may already be closed.
      }
      if (error) reject(error);
      else resolve(state);
    };
    const timer = setTimeout(() => finish(new Error('The room did not answer the control panel.')), TIMEOUT_MS);

    socket.addEventListener('open', () => socket.send(frame));
    socket.addEventListener('message', async (event) => {
      let frame = event.data;
      if (key) {
        if (typeof frame === 'string') return;
        if (frame instanceof Blob) frame = await frame.arrayBuffer();
        try {
          frame = new TextDecoder().decode(openFrame(key, new Uint8Array(frame), { room: record.room }));
        } catch {
          return;
        }
      } else if (typeof frame !== 'string') {
        frame = new TextDecoder().decode(frame);
      }
      let message;
      try {
        message = decode(String(frame));
      } catch {
        return;
      }
      if (message.type !== 'app' || message.name !== PANEL_APP) return;
      const data = message.data && typeof message.data === 'object' ? message.data : {};
      if (data.requestId !== requestId) return;
      if (data.ok === false) {
        const error = new Error(String(data.error || 'The room refused that change.'));
        if (data.reason) error.reason = String(data.reason);
        return finish(error);
      }
      if (!data.state || typeof data.state !== 'object') return finish(new Error('The room sent no control state.'));
      finish(null, withRoomLog(data.state));
    });
    socket.addEventListener('error', () => finish(new Error('Could not reach the room control channel.')));
    socket.addEventListener('close', () => {
      if (!settled) finish(new Error('The room control channel closed before it answered.'));
    });
  });
}

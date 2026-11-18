// The app-side half of the room control channel. It joins the relay as a
// loopback panel peer, sends one app message, waits for the host tab's answer,
// and closes. The host tab checks the token before it changes anything.
import crypto from 'node:crypto';
import { formatAddress } from '../core/friends.mjs';
import { PANEL_APP, PANEL_PEER } from '../core/panel.mjs';
import { decode, encode } from '../core/protocol.mjs';
import { openFrame, roomKey, sealFrame } from '../core/seal.mjs';
import { readJoin, readRun } from './room.mjs';

const TIMEOUT_MS = 8000;

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
      finish(null, data.state);
    });
    socket.addEventListener('error', () => finish(new Error('Could not reach the room control channel.')));
    socket.addEventListener('close', () => {
      if (!settled) finish(new Error('The room control channel closed before it answered.'));
    });
  });
}

// The launcher's loopback channel, prototype for M7. The bridge asks for an
// action over 127.0.0.1 with a token the page cannot read, and this process
// turns it into one trusted BiDi action. No token, no action.

import http from 'node:http';
import crypto from 'node:crypto';

export const GRANT_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;

function sameToken(presented, expected) {
  const left = Buffer.from(String(presented));
  const right = Buffer.from(String(expected));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body is over the limit'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function reply(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

export async function createAgent({ bidi, context, grant, ttlMs = GRANT_TTL_MS } = {}) {
  if (!bidi) throw new Error('the agent needs a BiDi session');
  if (!context) throw new Error('the agent needs a browsing context');
  if (!grant || grant.active !== true) throw new Error('the agent refuses to start without an active grant');
  if (!grant.peerId) throw new Error('the grant must name a peer');

  const token = crypto.randomBytes(32).toString('base64url');
  const stats = { actions: 0, rejected: 0, reasons: {}, tokenLeaks: 0 };
  let active = true;
  let closedAt = null;
  const expiresAt = Date.now() + ttlMs;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/health') {
      reply(res, 200, { ok: active, grant: grant.peerId });
      return;
    }
    if (url.pathname !== '/action') {
      req.resume();
      reply(res, 404, { ok: false, reason: 'not-found' });
      return;
    }

    // Drain the body before answering a refusal. A response that finishes
    // while the request is still writing resets the socket, and the caller
    // sees a connection error instead of the 401.
    const reject = async (status, reason) => {
      stats.rejected += 1;
      stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
      await readBody(req).catch(() => {});
      reply(res, status, { ok: false, reason });
    };

    if (!active) return reject(401, 'revoked');
    if (Date.now() > expiresAt) return reject(401, 'expired');

    const header = String(req.headers.authorization || '');
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!sameToken(presented, token)) return reject(401, 'token');

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      reply(res, 400, { ok: false, reason: 'body' });
      return;
    }
    if (!body || !Array.isArray(body.actions) || !body.actions.length) {
      reply(res, 400, { ok: false, reason: 'actions' });
      return;
    }

    try {
      await bidi.cmd('input.performActions', { context, actions: body.actions });
      stats.actions += 1;
      reply(res, 200, { ok: true, actions: body.actions.length });
    } catch (error) {
      reply(res, 502, { ok: false, reason: 'bidi', error: error.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address.address !== '127.0.0.1') {
    server.close();
    throw new Error(`the agent bound ${address.address}, not 127.0.0.1`);
  }

  return {
    grant,
    token,
    port: address.port,
    host: address.address,
    url: `http://127.0.0.1:${address.port}`,
    expiresAt,
    stats,
    revoke() {
      active = false;
      closedAt = Date.now();
      return new Promise((resolve) => server.close(resolve));
    },
    close() {
      if (!active) return Promise.resolve();
      active = false;
      return new Promise((resolve) => server.close(resolve));
    },
    isActive() {
      return active;
    },
    closedAt() {
      return closedAt;
    },
  };
}

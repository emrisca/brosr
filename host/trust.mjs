// The trusted input helper. It owns one debugger session beside the start path,
// binds a loopback listener only while a peer holds a trusted session, and
// closes the listener when that session ends or the room stops. Gecko answers over BiDi and
// Chromium over CDP, and the watcher does not know which one it holds.
//
// Three rules from the plan:
// 1. Loopback only, random port, a token the page cannot read.
// 2. Close the session with the last grant and on app exit.
// 3. Refuse to start the agent at all when the room has no trusted session.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BiDi } from '../spike/bidi.mjs';
import { ChromeCdp } from './chrome-cdp.mjs';
import { isTabOpeningKey, pointerLockDecision, scrollPolicyDecision } from '../core/input.mjs';
import { actionsForRecord } from '../core/trust.mjs';

export const TRUST_TTL_MS = 5 * 60 * 1000;
export const TRUST_RENEW_BEFORE_MS = 60 * 1000;
// A target tab can close or navigate after the panel named it. The helper looks
// it up again this often, and keeps the room tab when nothing matches.
export const TARGET_REFRESH_MS = 10 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_RECORDS = 256;

const text = (error) => String((error && error.message) || error);

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
  if (res.writableEnded || res.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    // The room page is served from the local relay on another port. The token
    // is the guard, and a request that lacks it never reaches an action.
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
  });
  res.end(payload);
}

// The loopback agent. It refuses to bind without an active grant, so a room
// with no trusted input has no control channel and no listening port.
export async function createTrustAgent({
  bidi,
  context,
  grant,
  token: givenToken = '',
  port: listenPort = 0,
  ttlMs = TRUST_TTL_MS,
  pointerLocked = () => false,
  onTargetError = null,
} = {}) {
  if (!bidi) throw new Error('the agent needs a BiDi session');
  if (!context) throw new Error('the agent needs a browsing context');
  if (!grant || grant.active !== true) throw new Error('the agent refuses to start without an active grant');
  if (!grant.peerId) throw new Error('the grant must name a peer');

  const token = givenToken || crypto.randomBytes(32).toString('base64url');
  const stats = { batches: 0, records: 0, applied: 0, skipped: 0, rejected: 0, reasons: {} };
  let active = true;
  let closedAt = null;
  let expiresAt = Date.now() + ttlMs;
  const bindPort =
    Number.isInteger(listenPort) && listenPort >= 0 && listenPort <= 65535 ? listenPort : 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'OPTIONS') {
      reply(res, 204, { ok: true });
      return;
    }
    if (url.pathname === '/health') {
      reply(res, 200, { ok: active, grant: grant.peerId, expiresAt });
      return;
    }
    if (url.pathname !== '/action') {
      req.resume();
      reply(res, 404, { ok: false, reason: 'not-found' });
      return;
    }
    if (req.method !== 'POST') {
      req.resume();
      reply(res, 405, { ok: false, reason: 'method' });
      return;
    }

    // Drain the body before answering a refusal. A response that finishes while
    // the request is still writing resets the socket, and the caller sees a
    // connection error instead of the 401.
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
    const records = body && Array.isArray(body.records) ? body.records : null;
    if (!records || !records.length) {
      reply(res, 400, { ok: false, reason: 'records' });
      return;
    }
    if (records.length > MAX_RECORDS) {
      reply(res, 413, { ok: false, reason: 'too-many-records' });
      return;
    }

    // Guardrail #5: pointer lock, scrolling, and tab-opening shortcuts/middle-clicks
    // are local by design. Refuse the batch with the explicit policy decision before
    // touching the browser actuator.
    const lockActive = Boolean(typeof pointerLocked === 'function' ? pointerLocked() : pointerLocked);
    for (const record of records) {
      const lock = pointerLockDecision({
        record,
        pointerLockElement: lockActive ? true : null,
      });
      if (!lock.allow) {
        stats.rejected += 1;
        stats.reasons[lock.reason] = (stats.reasons[lock.reason] || 0) + 1;
        reply(res, 403, { ok: false, ...lock });
        return;
      }
      const scroll = scrollPolicyDecision(record);
      if (!scroll.allow) {
        stats.rejected += 1;
        stats.reasons[scroll.reason] = (stats.reasons[scroll.reason] || 0) + 1;
        reply(res, 403, { ok: false, ...scroll });
        return;
      }
      if (
        record &&
        ((['click', 'down', 'up'].includes(record.kind) && Number(record.button) === 1) ||
          (record.kind === 'key' && isTabOpeningKey(null, record)))
      ) {
        stats.rejected += 1;
        stats.reasons['new-tab'] = (stats.reasons['new-tab'] || 0) + 1;
        reply(res, 403, { ok: false, allow: false, reason: 'new-tab' });
        return;
      }
    }

    let applied = 0;
    let skipped = 0;
    stats.batches += 1;
    stats.records += records.length;
    for (const record of records) {
      if (!active) {
        stats.applied += applied;
        stats.skipped += skipped;
        stats.rejected += 1;
        stats.reasons.revoked = (stats.reasons.revoked || 0) + 1;
        reply(res, 401, { ok: false, reason: 'revoked', applied });
        return;
      }
      if (Date.now() > expiresAt) {
        stats.applied += applied;
        stats.skipped += skipped;
        stats.rejected += 1;
        stats.reasons.expired = (stats.reasons.expired || 0) + 1;
        reply(res, 401, { ok: false, reason: 'expired', applied });
        return;
      }
      const actions = actionsForRecord(record);
      if (!actions) {
        skipped += 1;
        continue;
      }
      try {
        await bidi.cmd('input.performActions', { context, actions });
        applied += 1;
      } catch (error) {
        stats.applied += applied;
        stats.skipped += skipped;
        stats.rejected += 1;
        stats.reasons.bidi = (stats.reasons.bidi || 0) + 1;
        if (typeof onTargetError === 'function') onTargetError(error);
        reply(res, 502, {
          ok: false,
          reason: 'bidi',
          applied,
          error: text(error),
        });
        return;
      }
    }
    stats.applied += applied;
    stats.skipped += skipped;
    reply(res, 200, { ok: true, applied, skipped });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(bindPort, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address.address !== '127.0.0.1') {
    server.close();
    throw new Error(`the agent bound ${address.address}, not 127.0.0.1`);
  }

  return {
    grant,
    context,
    token,
    port: address.port,
    host: address.address,
    url: `http://127.0.0.1:${address.port}`,
    get expiresAt() {
      return expiresAt;
    },
    renew(nextTtlMs = ttlMs) {
      if (!active) return null;
      expiresAt = Date.now() + nextTtlMs;
      return expiresAt;
    },
    stats,
    revoke() {
      active = false;
      closedAt = Date.now();
      return new Promise((resolve) => {
        server.close(resolve);
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
    },
    close() {
      if (!active) return Promise.resolve();
      active = false;
      return new Promise((resolve) => {
        server.close(resolve);
        if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      });
    },
    isActive() {
      return active;
    },
    closedAt() {
      return closedAt;
    },
  };
}

// The room page publishes its members in document.documentElement.dataset. A
// peer with control and not this tab is the one the agent may act for.
export function grantedPeers(published) {
  if (!published || typeof published !== 'object') return [];
  const list = Array.isArray(published.peerList) ? published.peerList : [];
  return list
    .filter((peer) => peer && peer.granted === true && peer.self !== true)
    .map((peer) => String(peer.id || ''))
    .filter(Boolean);
}

// The panel names the tab a grant types into by URL. The helper finds that tab
// on the same browser, and a URL no tab shows resolves to nothing so the caller
// can keep the room tab.
export async function resolveTrustTarget(bidi, target) {
  const asked = String(target || '');
  if (!asked) return null;
  let wanted;
  try {
    wanted = new URL(asked);
  } catch {
    return null;
  }
  const tree = await bidi.cmd('browsingContext.getTree', {});
  const contexts = (tree && tree.contexts) || [];
  const read = (item) => {
    try {
      return new URL(item.url);
    } catch {
      return null;
    }
  };
  // An exact address wins, then same origin+path+query (ignoring only hash).
  // Query strings stay load-bearing so closing watch?v=A never redirects
  // actuation onto watch?v=B.
  const exact = contexts.find((item) => {
    const url = read(item);
    return url && url.href === wanted.href;
  });
  const withQuery = contexts.find((item) => {
    const url = read(item);
    return (
      url &&
      url.origin === wanted.origin &&
      url.pathname === wanted.pathname &&
      url.search === wanted.search
    );
  });
  const hit = exact || withQuery;
  return hit ? hit.context : null;
}

// Poll the room tab for control. The listener exists only while the list has a
// granted peer, follows a different grant by replacing the agent, and moves to
// the published target tab when the panel names one.
export function watchTrust({
  bidi,
  context,
  token = '',
  agentPort = 0,
  ttlMs = TRUST_TTL_MS,
  intervalMs = 500,
  log = () => {},
} = {}) {
  if (!bidi) throw new Error('the watcher needs a BiDi session');
  if (!context) throw new Error('the watcher needs a browsing context');
  const renewLeadMs = Math.max(1, Math.min(TRUST_RENEW_BEFORE_MS, Math.floor(ttlMs / 3)));
  const state = {
    checks: 0,
    peerId: null,
    agent: null,
    error: null,
    seenGrants: 0,
    renewals: 0,
    targetUrl: null,
    targetContext: context,
    missingTarget: null,
    pointerLocked: false,
  };
  let agent = null;
  let peerId = null;
  let targetUrl = null;
  let targetContext = context;
  let resolvedAt = 0;
  let timer = null;
  let stopped = false;

  const read = async () => {
    const res = await bidi.cmd('script.evaluate', {
      expression: 'document.documentElement.dataset.brosr || ""',
      target: { context },
      awaitPromise: true,
      resultOwnership: 'none',
    });
    const raw = res && res.result ? res.result.value : '';
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  const stopAgent = async () => {
    if (!agent) return;
    const old = agent;
    agent = null;
    state.agent = null;
    await old.revoke().catch(() => {});
  };

  const tick = async () => {
    if (stopped) return;
    state.checks += 1;
    let published = null;
    try {
      published = await read();
      state.error = null;
    } catch (error) {
      state.error = text(error);
    }
    state.pointerLocked = Boolean(published && published.pointerLock);
    const granted = grantedPeers(published);
    // The panel names the tab this grant types into. If a named target tab is
    // closed or missing, refuse actuation instead of falling back to the room tab.
    const asked =
      granted.length && published && typeof published.trustTarget === 'string'
        ? published.trustTarget
        : '';
    if (!asked) {
      targetContext = context;
      targetUrl = null;
      state.missingTarget = null;
    } else if (
      asked !== targetUrl ||
      !targetContext ||
      Date.now() - resolvedAt > TARGET_REFRESH_MS
    ) {
      let hit = null;
      try {
        hit = await resolveTrustTarget(bidi, asked);
      } catch (error) {
        state.error = text(error);
      }
      const next = hit || null;
      if (next !== targetContext) {
        log(
          hit
            ? `[trust] typing into ${asked} on context ${hit}`
            : `[trust] no tab shows ${asked}, refusing actuation`
        );
      }
      targetUrl = asked;
      targetContext = next;
      resolvedAt = Date.now();
      state.missingTarget = hit ? null : asked;
    }
    state.targetUrl = targetUrl;
    state.targetContext = targetContext;

    if (!granted.length) {
      if (agent) log('[trust] grant ended, listener closed');
      await stopAgent();
      peerId = null;
      state.peerId = null;
    } else if (!targetContext) {
      if (agent) log('[trust] target tab missing, listener closed');
      await stopAgent();
      peerId = granted[0];
      state.peerId = peerId;
    } else if (
      !agent ||
      granted[0] !== peerId ||
      agent.context !== targetContext ||
      !agent.isActive()
    ) {
      await stopAgent();
      peerId = granted[0];
      agent = await createTrustAgent({
        bidi,
        context: targetContext,
        token,
        port: agentPort,
        ttlMs,
        grant: { peerId, active: true },
        pointerLocked: () => state.pointerLocked,
        onTargetError: () => {
          resolvedAt = 0;
        },
      });
      state.seenGrants += 1;
      state.peerId = peerId;
      state.agent = {
        host: agent.host,
        port: agent.port,
        url: agent.url,
        expiresAt: agent.expiresAt,
      };
      log(`[trust] agent for ${peerId} on ${agent.url}`);
    } else if (Date.now() >= agent.expiresAt - renewLeadMs) {
      const nextExpiry = agent.renew(ttlMs);
      if (nextExpiry) {
        state.renewals += 1;
        state.agent = {
          host: agent.host,
          port: agent.port,
          url: agent.url,
          expiresAt: nextExpiry,
        };
        log(`[trust] renewed agent for ${peerId} until ${nextExpiry}`);
      }
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };

  timer = setTimeout(tick, 0);

  return {
    state,
    agent: () => agent,
    stop() {
      stopped = true;
      clearTimeout(timer);
      return stopAgent();
    },
  };
}

// Gecko opens one BiDi session on the debug port. Chromium exposes a debugger
// socket instead, so the family picks the client and not the watcher above it.
async function connect(debugPort, family = 'gecko', timeoutMs = 60000) {
  if (family === 'chromium') return ChromeCdp.connect(debugPort, timeoutMs);
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    try {
      return await new BiDi(`ws://127.0.0.1:${debugPort}/session`).connect();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw new Error(`no BiDi on ${debugPort}: ${last ? text(last) : 'unknown'}`);
}

async function roomContext(bidi, room, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const tree = await bidi.cmd('browsingContext.getTree', {});
    const hit = (tree.contexts || []).find((item) => {
      try {
        return new URL(item.url).searchParams.get('room') === room;
      } catch {
        return false;
      }
    });
    if (hit) return hit.context;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`no room tab for ${room}`);
}

// The detached process the start path spawns. It exits when the browser does or
// when the app sends SIGTERM, and either way the listener closes first.
export async function runTrustHelper({
  debugPort,
  agentPort = 0,
  room,
  token,
  ttlMs = TRUST_TTL_MS,
  family = 'gecko',
  log = () => {},
} = {}) {
  const bidi = await connect(debugPort, family);
  const context = await roomContext(bidi, room);
  const watcher = watchTrust({ bidi, context, token, agentPort, ttlMs, log });
  const close = async () => {
    await watcher.stop();
    bidi.close();
  };
  process.once('SIGTERM', () => {
    close().finally(() => process.exit(0));
  });
  process.once('SIGINT', () => {
    close().finally(() => process.exit(0));
  });
  log(`[trust] watching ${room} on context ${context}`);
  return { bidi, context, watcher, close };
}

const arg = (name, fallback = '') => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

function isDirectRun() {
  if (!process.argv[1]) return false;
  const norm = (file) => {
    try {
      const real = fs.realpathSync(file);
      return process.platform === 'win32' ? real.toLowerCase() : real;
    } catch {
      const resolved = path.resolve(file);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    }
  };
  return norm(process.argv[1]) === norm(fileURLToPath(import.meta.url));
}

if (isDirectRun()) {
  const debugPort = Number(arg('debug-port'));
  const agentPort = Number(arg('agent-port', '0')) || 0;
  const room = arg('room');
  const token = arg('token');
  const family = arg('family', 'gecko');
  if (!debugPort || !room || !token) {
    process.stderr.write('brosr trust: pass --debug-port, --room and --token\n');
    process.exit(2);
  }
  runTrustHelper({
    debugPort,
    agentPort,
    room,
    token,
    family,
    ttlMs: Number(arg('ttl')) || TRUST_TTL_MS,
    log: (line) => process.stderr.write(line + '\n'),
  })
    .then(() => {
      // The watcher owns the process lifetime from here. A signal closes it.
      setInterval(() => {}, 60 * 60 * 1000);
    })
    .catch((error) => {
      process.stderr.write(`brosr trust: ${text(error)}\n`);
      process.exit(1);
    });
}

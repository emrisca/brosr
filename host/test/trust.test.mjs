// The trusted input channel. The token, the grant gate and the grant lifecycle
// are the security surface, so each one gets a case.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BIDI_KEYS, actionsForRecord, prepareRecords } from '../../core/trust.mjs';
import { createRoomClient } from '../../core/sync.mjs';
import { encode } from '../../core/protocol.mjs';
import { ChromeCdp } from '../chrome-cdp.mjs';
import {
  createTrustAgent,
  grantedPeers,
  resolveTrustTarget,
  watchTrust,
} from '../trust.mjs';
import { roomUrl } from '../room.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, label, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function fakeBidi() {
  const calls = [];
  return {
    calls,
    async cmd(method, params) {
      calls.push({ method, params });
      return {};
    },
  };
}

function published(peerList, extra = {}) {
  return { result: { value: JSON.stringify({ peerList, ...extra }) } };
}

test('a click becomes one pointer move, press and release', () => {
  const actions = actionsForRecord({ kind: 'click', point: { x: 40, y: 80 }, button: 0 });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'pointer');
  assert.deepEqual(
    actions[0].actions.map((action) => action.type),
    ['pointerMove', 'pointerDown', 'pointerUp']
  );
  assert.equal(actions[0].actions[0].x, 40);
  assert.equal(actions[0].actions[2].button, 0);
});

test('a key record keeps its order with BiDi code points and a text run types every character', () => {
  const key = actionsForRecord({ kind: 'key', key: 'Enter' });
  assert.deepEqual(
    key[0].actions.map((action) => [action.type, action.value]),
    [
      ['keyDown', BIDI_KEYS.Enter],
      ['keyUp', BIDI_KEYS.Enter],
    ]
  );
  const text = actionsForRecord({ kind: 'text', value: 'hi' });
  assert.deepEqual(
    text[0].actions.map((action) => action.value),
    ['h', 'h', 'i', 'i']
  );
});

test('wheel and scroll records produce no BiDi actions because scrolling stays local', () => {
  assert.equal(
    actionsForRecord({
      kind: 'wheel',
      point: { x: 10, y: 20 },
      deltaX: 0,
      deltaY: 120,
    }),
    null
  );
  assert.equal(
    actionsForRecord({
      kind: 'scroll',
      point: { x: 10, y: 20 },
      deltaX: 0,
      deltaY: 120,
    }),
    null
  );
});

test('a record with no place is skipped instead of sent to the origin', () => {
  assert.equal(actionsForRecord({ kind: 'click' }), null);
  assert.equal(actionsForRecord({ kind: 'move' }), null);
  assert.equal(actionsForRecord({ kind: 'text', value: '' }), null);
});

test('preparation resolves a selector and focuses the field', () => {
  const field = {
    focused: false,
    focus() {
      this.focused = true;
    },
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 200, height: 40 }),
  };
  const doc = { querySelectorAll: (selector) => (selector === '#field' ? [field] : []) };
  const [record] = prepareRecords(
    [{ kind: 'click', path: '#field', canvas: { x: 0.25, y: 0.5 } }],
    doc
  );
  assert.deepEqual(record.point, { x: 150, y: 70 });
  const [typed] = prepareRecords([{ kind: 'text', path: '#field', value: 'a' }], doc);
  assert.equal(typed.kind, 'text');
  assert.equal(field.focused, true);
});

test('the agent refuses to exist without an active grant', async () => {
  const bidi = fakeBidi();
  await assert.rejects(() => createTrustAgent({ bidi, context: 'ctx' }), /active grant/);
  await assert.rejects(
    () => createTrustAgent({ bidi, context: 'ctx', grant: { peerId: 'p' } }),
    /active grant/
  );
  await assert.rejects(
    () => createTrustAgent({ bidi, context: 'ctx', grant: { active: true } }),
    /name a peer/
  );
});

test('the agent binds loopback, checks the token and applies the batch', async () => {
  const bidi = fakeBidi();
  const agent = await createTrustAgent({
    bidi,
    context: 'ctx',
    token: 'check-token',
    grant: { peerId: 'peer', active: true },
  });
  assert.equal(agent.host, '127.0.0.1');
  assert.ok(agent.port > 0);

  const call = (headers, body) =>
    fetch(`${agent.url}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  assert.equal((await fetch(`${agent.url}/action`, { method: 'GET' })).status, 405);
  assert.equal((await call({}, { records: [{ kind: 'key', key: 'a' }] })).status, 401);
  assert.equal(
    (await call({ authorization: 'Bearer wrong' }, { records: [{ kind: 'key', key: 'a' }] })).status,
    401
  );
  assert.equal(
    (await call({ authorization: 'Bearer check-token' }, { records: [] })).status,
    400
  );

  const ok = await call(
    { authorization: 'Bearer check-token' },
    {
      records: [
        { kind: 'key', key: 't' },
        { kind: 'text', value: 'hi' },
      ],
    }
  );
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.deepEqual({ ok: body.ok, applied: body.applied }, { ok: true, applied: 2 });
  assert.equal(bidi.calls.filter((entry) => entry.method === 'input.performActions').length, 2);

  await agent.revoke();
  assert.equal(agent.isActive(), false);
  await assert.rejects(() => call({ authorization: 'Bearer check-token' }, { records: [{ kind: 'key', key: 'a' }] }));
});

test('the agent refuses pointer-lock requests and active pointer lock with structured reason (Guardrail #5)', async () => {
  const bidi = fakeBidi();
  let locked = false;
  const agent = await createTrustAgent({
    bidi,
    context: 'ctx',
    token: 'lock-token',
    grant: { peerId: 'peer', active: true },
    pointerLocked: () => locked,
  });

  const post = (records) =>
    fetch(`${agent.url}/action`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer lock-token',
      },
      body: JSON.stringify({ records }),
    });

  const req = await post([{ kind: 'pointerlock' }]);
  assert.equal(req.status, 403);
  const reqBody = await req.json();
  assert.equal(reqBody.ok, false);
  assert.equal(reqBody.allow, false);
  assert.equal(reqBody.reason, 'pointer-lock-local');
  assert.equal(bidi.calls.length, 0);

  locked = true;
  const active = await post([{ kind: 'wheel', point: { x: 10, y: 20 }, deltaY: 120 }]);
  assert.equal(active.status, 403);
  const activeBody = await active.json();
  assert.equal(activeBody.ok, false);
  assert.equal(activeBody.allow, false);
  assert.equal(activeBody.reason, 'pointer-lock-active');
  assert.equal(bidi.calls.length, 0);

  locked = false;
  const scrollRefused = await post([{ kind: 'wheel', point: { x: 10, y: 20 }, deltaY: 120 }]);
  assert.equal(scrollRefused.status, 403);
  const scrollBody = await scrollRefused.json();
  assert.equal(scrollBody.ok, false);
  assert.equal(scrollBody.allow, false);
  assert.equal(scrollBody.reason, 'scroll');
  assert.equal(bidi.calls.length, 0);

  const ok = await post([{ kind: 'click', point: { x: 10, y: 20 }, button: 0 }]);
  assert.equal(ok.status, 200);
  assert.equal(bidi.calls.length, 1);

  await agent.revoke();
});

test('watchTrust propagates published pointerLock without tearing down the agent', async () => {
  let shown = published([{ id: 'peer', granted: true, self: false }], { pointerLock: true });
  const bidi = fakeBidi();
  bidi.cmd = async (method, params) => {
    if (method === 'script.evaluate') return shown;
    bidi.calls.push({ method, params });
    return {};
  };
  const watcher = watchTrust({ bidi, context: 'ctx', token: 'tok', intervalMs: 10 });
  await waitFor(() => watcher.agent(), 'the agent');
  const firstUrl = watcher.agent().url;
  assert.equal(watcher.state.pointerLocked, true);

  const refused = await fetch(`${firstUrl}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
    body: JSON.stringify({ records: [{ kind: 'key', key: 'a' }] }),
  });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).reason, 'pointer-lock-active');

  shown = published([{ id: 'peer', granted: true, self: false }], { pointerLock: false });
  await waitFor(() => watcher.state.pointerLocked === false, 'unlock');
  assert.equal(watcher.agent().url, firstUrl);
  const ok = await fetch(`${firstUrl}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
    body: JSON.stringify({ records: [{ kind: 'key', key: 'a' }] }),
  });
  assert.equal(ok.status, 200);

  await watcher.stop();
});

test('createTrustAgent refuses wheel/scroll and tab-opening records while delivering clicks to ChromeCdp', async () => {
  const socketCalls = [];
  const socket = {
    onEvent: null,
    async send(method, params = {}, sessionId = null) {
      socketCalls.push({ method, params, sessionId });
      if (method === 'Target.attachToTarget') return { sessionId: `s-${params.targetId}` };
      return {};
    },
    close() {},
  };
  const cdp = new ChromeCdp(socket);
  const agent = await createTrustAgent({
    bidi: cdp,
    context: 'tab-1',
    token: 'wheel-token',
    grant: { peerId: 'peer', active: true },
  });

  const post = (records) =>
    fetch(`${agent.url}/action`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wheel-token',
      },
      body: JSON.stringify({ records }),
    });

  try {
    const wheelRes = await post([
      { kind: 'wheel', point: { x: 80, y: 120 }, deltaX: 12, deltaY: -240, ctrl: true },
    ]);
    assert.equal(wheelRes.status, 403);
    assert.deepEqual(await wheelRes.json(), {
      ok: false,
      allow: false,
      reason: 'scroll',
      message: 'Scrolling is local by design and cannot be relayed remotely.',
    });

    const middleRes = await post([{ kind: 'click', point: { x: 80, y: 120 }, button: 1 }]);
    assert.equal(middleRes.status, 403);
    assert.deepEqual(await middleRes.json(), { ok: false, allow: false, reason: 'new-tab' });

    const newTabKeyRes = await post([{ kind: 'key', key: 't', meta: true }]);
    assert.equal(newTabKeyRes.status, 403);
    assert.deepEqual(await newTabKeyRes.json(), { ok: false, allow: false, reason: 'new-tab' });

    assert.equal(
      socketCalls.filter((call) => call.method.startsWith('Input.')).length,
      0,
      'refused scroll and tab-opening records must never reach CDP'
    );

    const clickRes = await post([{ kind: 'click', point: { x: 80, y: 120 }, button: 0, ctrl: true }]);
    assert.equal(clickRes.status, 200);
    const press = socketCalls.find(
      (call) => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mousePressed'
    );
    assert.ok(press);
    assert.equal(press.sessionId, 's-tab-1');
    assert.equal(press.params.modifiers, 2);
  } finally {
    await agent.revoke();
  }
});

test('the watcher opens only for a granted peer and closes when the grant ends', async () => {
  const answers = [
    published([{ id: 'peer', granted: false, self: false }]),
    published([{ id: 'peer', granted: true, self: false }]),
    published([{ id: 'peer', granted: true, self: false }]),
    published([{ id: 'peer', granted: false, self: false }]),
  ];
  const bidi = fakeBidi();
  bidi.cmd = async (method, params) => {
    if (method === 'script.evaluate') return answers.shift() || published([]);
    return {};
  };
  const watcher = watchTrust({ bidi, context: 'ctx', token: 't', intervalMs: 10 });
  assert.equal(watcher.state.peerId, null);
  await waitFor(() => watcher.agent(), 'the agent');
  assert.equal(watcher.state.peerId, 'peer');
  const first = watcher.agent();
  await waitFor(() => watcher.agent() === null, 'the closed agent');
  assert.equal(await first.isActive(), false);
  await watcher.stop();
  assert.equal(watcher.state.seenGrants, 1);
});

test('a trusted room keeps the token in the fragment and out of the query', () => {
  const url = new URL(
    roomUrl({
      host: '127.0.0.1',
      port: 8787,
      room: 'r1',
      key: 'room-key',
      name: 'Host',
      trust: { port: 9340, token: 'secret-token' },
    })
  );
  assert.equal(url.searchParams.get('t'), null);
  assert.equal(url.searchParams.get('token'), null);
  const fragment = new URLSearchParams(url.hash.slice(1));
  assert.equal(fragment.get('k'), 'room-key');
  assert.equal(fragment.get('t'), 'secret-token');
  assert.equal(fragment.get('tp'), '9340');
});

test('a trust target resolves exact and query-matched tabs and refuses mismatched query strings', async () => {
  const bidi = fakeBidi();
  bidi.cmd = async (method) => {
    if (method === 'browsingContext.getTree') {
      return {
        contexts: [
          { context: 'room', url: 'http://127.0.0.1:8787/?room=r1&peer=host' },
          { context: 'ep1', url: 'http://127.0.0.1:8787/watch?ep=1' },
          { context: 'ep2', url: 'http://127.0.0.1:8787/watch?ep=2' },
          { context: 'ytB', url: 'https://www.youtube.com/watch?v=otherVideo' },
          { context: 'form', url: 'http://127.0.0.1:8787/form.html' },
        ],
      };
    }
    return {};
  };
  assert.equal(await resolveTrustTarget(bidi, 'http://127.0.0.1:8787/form.html'), 'form');
  assert.equal(await resolveTrustTarget(bidi, 'http://127.0.0.1:8787/form.html#top'), 'form');
  assert.equal(await resolveTrustTarget(bidi, 'http://127.0.0.1:8787/watch?ep=2#player'), 'ep2');
  // Closing watch?v=A must never redirect actuation onto another watch?v=B tab.
  assert.equal(
    await resolveTrustTarget(bidi, 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'),
    null
  );
  assert.equal(await resolveTrustTarget(bidi, 'http://127.0.0.1:8787/watch?ep=3'), null);
  assert.equal(await resolveTrustTarget(bidi, 'http://127.0.0.1:8787/gone.html'), null);
  assert.equal(await resolveTrustTarget(bidi, ''), null);
});

test('the watcher moves to the published target, refuses actuation when missing, and returns only when cleared', async () => {
  const roomUrl = 'http://127.0.0.1:8787/?room=r1&peer=host';
  let shown = published([{ id: 'peer', granted: true, self: false }]);
  const bidi = fakeBidi();
  bidi.cmd = async (method) => {
    if (method === 'script.evaluate') return shown;
    if (method === 'browsingContext.getTree') {
      return {
        contexts: [
          { context: 'ctx', url: roomUrl },
          { context: 'form', url: 'http://127.0.0.1:8787/form.html' },
        ],
      };
    }
    return {};
  };
  const watcher = watchTrust({ bidi, context: 'ctx', token: 't', intervalMs: 10 });
  try {
    await waitFor(() => watcher.agent(), 'the room agent');
    const room = watcher.agent();
    assert.equal(room.context, 'ctx');
    assert.equal(watcher.state.targetContext, 'ctx');

    shown = published([{ id: 'peer', granted: true, self: false }], {
      trustTarget: 'http://127.0.0.1:8787/form.html',
    });
    await waitFor(() => watcher.agent() && watcher.agent() !== room, 'the target agent');
    assert.equal(watcher.agent().context, 'form');
    assert.equal(watcher.state.targetUrl, 'http://127.0.0.1:8787/form.html');
    assert.equal(room.isActive(), false);

    // Missing named target must stop the agent instead of falling back to the room tab.
    const target = watcher.agent();
    shown = published([{ id: 'peer', granted: true, self: false }], {
      trustTarget: 'http://127.0.0.1:8787/gone.html',
    });
    await waitFor(() => watcher.agent() === null, 'refusal on missing target');
    assert.equal(target.isActive(), false);
    assert.equal(watcher.state.targetContext, null);
    assert.equal(watcher.state.missingTarget, 'http://127.0.0.1:8787/gone.html');

    // Clearing trustTarget explicitly returns actuation to the room tab.
    shown = published([{ id: 'peer', granted: true, self: false }], {
      trustTarget: '',
    });
    await waitFor(() => watcher.agent() && watcher.agent().context === 'ctx', 'return to room');
    assert.equal(watcher.state.missingTarget, null);
    assert.equal(watcher.state.seenGrants, 3);
  } finally {
    await watcher.stop();
  }
  assert.equal(watcher.agent(), null);
});

test('the watcher closes the agent instead of falling back to the room tab when a target closes mid-dispatch', async () => {
  const roomUrl = 'http://127.0.0.1:8787/?room=r1&peer=host';
  let contexts = [
    { context: 'ctx', url: roomUrl },
    { context: 'form', url: 'http://127.0.0.1:8787/form.html' },
  ];
  const shown = published([{ id: 'peer', granted: true, self: false }], {
    trustTarget: 'http://127.0.0.1:8787/form.html',
  });
  const bidi = {
    async cmd(method, params) {
      if (method === 'script.evaluate') return shown;
      if (method === 'browsingContext.getTree') return { contexts };
      if (method === 'input.performActions' && params.context === 'form') {
        throw new Error('Target closed');
      }
      return {};
    },
  };
  const watcher = watchTrust({ bidi, context: 'ctx', token: 't', intervalMs: 15 });
  try {
    await waitFor(() => watcher.agent() && watcher.agent().context === 'form', 'the target agent');
    const formAgent = watcher.agent();

    // Target tab closes; an action fails with 502 and triggers immediate re-resolution
    // without waiting for TARGET_REFRESH_MS, stopping the agent instead of typing into the room tab.
    contexts = [{ context: 'ctx', url: roomUrl }];
    const failed = await fetch(`${formAgent.url}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: JSON.stringify({ records: [{ kind: 'key', key: 'a' }] }),
    });
    assert.equal(failed.status, 502);

    await waitFor(() => watcher.agent() === null, 'agent closed on missing target');
    assert.equal(formAgent.isActive(), false);
    assert.equal(watcher.state.targetContext, null);
    assert.equal(watcher.state.missingTarget, 'http://127.0.0.1:8787/form.html');
  } finally {
    await watcher.stop();
  }
});

test('a granted peer is never this tab', () => {
  assert.deepEqual(
    grantedPeers({
      peerList: [
        { id: 'host', granted: true, self: true },
        { id: 'guest', granted: true, self: false },
        { id: 'third', granted: false, self: false },
      ],
    }),
    ['guest']
  );
  assert.deepEqual(grantedPeers(null), []);
});

test('watchTrust binds a dedicated loopback agentPort only while granted (zero-listener lockdown)', async () => {
  // Reserve a free ephemeral loopback port without touching protected ports.
  const http = await import('node:http');
  const dedicatedPort = await new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });

  let shown = published([{ id: 'peer', granted: false, self: false }]);
  const bidi = fakeBidi();
  bidi.cmd = async (method) => (method === 'script.evaluate' ? shown : {});
  const watcher = watchTrust({
    bidi,
    context: 'ctx',
    token: 'secret-port-tok',
    agentPort: dedicatedPort,
    intervalMs: 10,
  });
  try {
    await waitFor(() => watcher.state.checks >= 2, 'ungranted checks');
    assert.equal(watcher.agent(), null);
    await assert.rejects(() => fetch(`http://127.0.0.1:${dedicatedPort}/health`));

    // Grant opens the exact configured agentPort.
    shown = published([{ id: 'peer', granted: true, self: false }]);
    await waitFor(() => watcher.agent(), 'agent bound');
    assert.equal(watcher.agent().port, dedicatedPort);
    const ok = await fetch(`http://127.0.0.1:${dedicatedPort}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret-port-tok' },
      body: JSON.stringify({ records: [{ kind: 'key', key: 'k' }] }),
    });
    assert.equal(ok.status, 200);

    // Revoking closes the listener on dedicatedPort immediately.
    shown = published([{ id: 'peer', granted: false, self: false }]);
    await waitFor(() => watcher.agent() === null, 'agent closed');
    await assert.rejects(() => fetch(`http://127.0.0.1:${dedicatedPort}/health`));
  } finally {
    await watcher.stop();
  }
});

test('watchTrust auto-renews the agent before TTL expires while granted', async () => {
  const shown = published([{ id: 'peer', granted: true, self: false }]);
  const bidi = fakeBidi();
  bidi.cmd = async (method) => (method === 'script.evaluate' ? shown : {});
  const watcher = watchTrust({
    bidi,
    context: 'ctx',
    token: 'renew-tok',
    ttlMs: 120,
    intervalMs: 15,
  });
  try {
    await waitFor(() => watcher.agent(), 'initial agent');
    const firstExpiry = watcher.agent().expiresAt;

    // Wait past the original 120 ms TTL; watcher must renew in-place before expiry.
    await sleep(170);
    assert.ok(watcher.state.renewals >= 1, 'expected at least one TTL renewal');
    assert.ok(watcher.agent().expiresAt > firstExpiry, 'expiresAt advanced');

    const res = await fetch(`${watcher.agent().url}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer renew-tok' },
      body: JSON.stringify({ records: [{ kind: 'key', key: 'a' }] }),
    });
    assert.equal(res.status, 200);
  } finally {
    await watcher.stop();
  }
});

test('createTrustAgent re-checks active inside the record loop and halts on mid-batch revocation', async () => {
  let agent = null;
  let dispatched = 0;
  const bidi = {
    async cmd(method) {
      if (method === 'input.performActions') {
        dispatched += 1;
        if (dispatched === 1) {
          // Revoke immediately after the first record applies; remaining records must not run.
          await agent.revoke();
        }
      }
      return {};
    },
  };
  agent = await createTrustAgent({
    bidi,
    context: 'ctx',
    token: 'mid-tok',
    grant: { peerId: 'peer', active: true },
  });

  await fetch(`${agent.url}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer mid-tok' },
    body: JSON.stringify({
      records: [
        { kind: 'key', key: 'a' },
        { kind: 'key', key: 'b' },
        { kind: 'key', key: 'c' },
      ],
    }),
  }).catch(() => {});

  assert.equal(dispatched, 1, 'only record 1 ran before mid-batch revocation halted the loop');
  assert.equal(agent.stats.reasons.revoked, 1);
});


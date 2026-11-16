// The trusted input channel. The token, the grant gate and the grant lifecycle
// are the security surface, so each one gets a case.
import assert from 'node:assert/strict';
import test from 'node:test';
import { actionsForRecord, prepareRecords } from '../../core/trust.mjs';
import { createRoomClient } from '../../core/sync.mjs';
import { encode } from '../../core/protocol.mjs';
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

test('a key record keeps its order and a text run types every character', () => {
  const key = actionsForRecord({ kind: 'key', key: 'Enter' });
  assert.deepEqual(
    key[0].actions.map((action) => [action.type, action.value]),
    [
      ['keyDown', 'Enter'],
      ['keyUp', 'Enter'],
    ]
  );
  const text = actionsForRecord({ kind: 'text', value: 'hi' });
  assert.deepEqual(
    text[0].actions.map((action) => action.value),
    ['h', 'h', 'i', 'i']
  );
});

test('a wheel record becomes a scroll at the record point', () => {
  const actions = actionsForRecord({
    kind: 'wheel',
    point: { x: 10, y: 20 },
    deltaX: 0,
    deltaY: 120,
  });
  assert.equal(actions[0].type, 'scroll');
  assert.equal(actions[0].actions[0].deltaY, 120);
  assert.equal(actions[0].actions[0].origin, 'viewport');
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

test('a granted batch goes to the trusted sink, and a refusal replays', async () => {
  const origin = 'http://127.0.0.1:8787';
  const doc = {
    location: { href: `${origin}/form.html`, origin },
    querySelectorAll: () => [],
    activeElement: null,
    defaultView: {},
    addEventListener() {},
    removeEventListener() {},
  };
  const calls = [];
  let mode = 'ok';
  const client = createRoomClient({
    role: 'host',
    peerId: 'host',
    document: doc,
    overlay: false,
    now: () => 1000,
    input: {
      capture: true,
      grantTo: 'peer',
      tabId: 'host',
      origin,
      trusted: async (records) => {
        calls.push(records);
        return mode === 'ok' ? { ok: true, applied: records.length } : { ok: false };
      },
    },
  });
  const frame = (seq, key) =>
    encode({ type: 'input', peerId: 'peer', seq, records: [{ kind: 'key', key }] });

  client.receive(frame(1, 'a'), 1000);
  await sleep(0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 1);
  assert.equal(client.publish().inputApplied, 1);

  // A refused batch falls back to the synthetic path. With no focused node it
  // drops the key with a reason instead of throwing or losing the frame.
  mode = 'fail';
  client.receive(frame(2, 'b'), 1100);
  await sleep(0);
  assert.equal(calls.length, 2);
  assert.equal(client.publish().inputApplied, 1);
  assert.equal(client.publish().inputReasons.target, 1);
});

test('a trust target resolves to the tab that shows it, not the room', async () => {
  const bidi = fakeBidi();
  bidi.cmd = async (method) => {
    if (method === 'browsingContext.getTree') {
      return {
        contexts: [
          { context: 'room', url: 'http://127.0.0.1:8787/?room=r1&peer=host' },
          { context: 'form', url: 'http://127.0.0.1:8787/form.html' },
        ],
      };
    }
    return {};
  };
  assert.equal(await resolveTrustTarget(bidi, 'http://127.0.0.1:8787/form.html'), 'form');
  assert.equal(await resolveTrustTarget(bidi, 'http://127.0.0.1:8787/form.html#top'), 'form');
  assert.equal(await resolveTrustTarget(bidi, 'http://127.0.0.1:8787/gone.html'), null);
  assert.equal(await resolveTrustTarget(bidi, ''), null);
});

test('the watcher moves the agent to the published target and back', async () => {
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
  await waitFor(() => watcher.agent(), 'the room agent');
  const room = watcher.agent();
  assert.equal(room.context, 'ctx');
  assert.equal(watcher.state.targetContext, 'ctx');

  shown = published([{ id: 'peer', granted: true, self: false }], {
    trustTarget: 'http://127.0.0.1:8787/form.html',
  });
  await waitFor(() => watcher.agent() !== room, 'the target agent');
  assert.equal(watcher.agent().context, 'form');
  assert.equal(watcher.state.targetUrl, 'http://127.0.0.1:8787/form.html');
  assert.equal(await room.isActive(), false);

  const target = watcher.agent();
  shown = published([{ id: 'peer', granted: true, self: false }], {
    trustTarget: 'http://127.0.0.1:8787/gone.html',
  });
  await waitFor(() => watcher.agent() !== target, 'the fallback agent');
  assert.equal(watcher.agent().context, 'ctx');
  assert.equal(watcher.state.missingTarget, 'http://127.0.0.1:8787/gone.html');

  await watcher.stop();
  assert.equal(watcher.agent(), null);
  assert.equal(watcher.state.seenGrants, 3);
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

// The loopback channel without a browser. A fake BiDi session plays the
// remote agent, so the token rules are testable in a second.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgent } from './agent.mjs';

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

const grant = { peerId: 'peer', tab: 'form.html', origin: 'http://127.0.0.1:8787', active: true };
const keyActions = (value) => [
  { type: 'key', id: 'k', actions: [{ type: 'keyDown', value }, { type: 'keyUp', value }] },
];

async function call(agent, headers, actions = keyActions('t')) {
  const res = await fetch(`${agent.url}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ actions }),
  });
  return { status: res.status, body: await res.json() };
}

test('the agent refuses to start without an active grant', async () => {
  await assert.rejects(() => createAgent({ bidi: fakeBidi(), context: 'ctx' }), /active grant/);
  await assert.rejects(
    () => createAgent({ bidi: fakeBidi(), context: 'ctx', grant: { ...grant, active: false } }),
    /active grant/
  );
});

test('it binds loopback only and mints a long token', async () => {
  const agent = await createAgent({ bidi: fakeBidi(), context: 'ctx', grant });
  assert.equal(agent.host, '127.0.0.1');
  assert.ok(agent.port > 1024);
  assert.ok(agent.token.length >= 32);
  await agent.close();
});

test('a request without a token, or with a wrong one, is refused before BiDi', async () => {
  const bidi = fakeBidi();
  const agent = await createAgent({ bidi, context: 'ctx', grant });
  const noToken = await call(agent, {});
  const wrongToken = await call(agent, { authorization: 'Bearer nope' });
  assert.equal(noToken.status, 401);
  assert.equal(wrongToken.status, 401);
  assert.equal(noToken.body.reason, 'token');
  assert.equal(bidi.calls.length, 0, 'a refused request never reaches the browser');
  assert.equal(agent.stats.rejected, 2);
  await agent.close();
});

test('a token turns into one trusted action on the room context', async () => {
  const bidi = fakeBidi();
  const agent = await createAgent({ bidi, context: 'room-tab', grant });
  const res = await call(agent, { authorization: `Bearer ${agent.token}` });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(bidi.calls.length, 1);
  assert.equal(bidi.calls[0].method, 'input.performActions');
  assert.equal(bidi.calls[0].params.context, 'room-tab');
  assert.equal(bidi.calls[0].params.actions[0].type, 'key');
  assert.equal(agent.stats.actions, 1);
  await agent.close();
});

test('a revoked grant closes the channel for the token it issued', async () => {
  const bidi = fakeBidi();
  const agent = await createAgent({ bidi, context: 'ctx', grant });
  const before = await call(agent, { authorization: `Bearer ${agent.token}` });
  assert.equal(before.status, 200);
  await agent.revoke();
  // revoke closes the listener, so the next call either fails to connect or
  // finds a dead grant. Both are a refusal, and neither reaches the browser.
  let after;
  try {
    after = await call(agent, { authorization: `Bearer ${agent.token}` });
  } catch (error) {
    after = { status: 0, error: error.message };
  }
  assert.notEqual(after.status, 200);
  assert.equal(bidi.calls.length, 1, 'nothing reached the browser after revoke');
  assert.equal(agent.isActive(), false);
});

test('an expired grant is refused even with the right token', async () => {
  const agent = await createAgent({ bidi: fakeBidi(), context: 'ctx', grant, ttlMs: -1 });
  const res = await call(agent, { authorization: `Bearer ${agent.token}` });
  assert.equal(res.status, 401);
  assert.equal(res.body.reason, 'expired');
  await agent.close();
});

test('a body without actions is refused', async () => {
  const agent = await createAgent({ bidi: fakeBidi(), context: 'ctx', grant });
  const res = await fetch(`${agent.url}/action`, {
    method: 'POST',
    headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ actions: [] }),
  });
  assert.equal(res.status, 400);
  await agent.close();
});

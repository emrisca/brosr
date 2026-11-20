// A BiDi client that never hears back takes its session down with it. Firefox
// answers one session in order, so a command that stays unanswered would hold
// every later one. These tests use a fake socket, because the point is the
// client's deadline and not a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiDi } from './bidi.mjs';

class FakeSocket {
  constructor() {
    this.sent = [];
    this.closed = false;
    this.onopen = null;
    this.onerror = null;
    this.onmessage = null;
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.closed = true;
  }

  answer(id, result) {
    this.onmessage({ data: JSON.stringify({ id, result }) });
  }
}

function client() {
  const bidi = new BiDi('ws://127.0.0.1:1/session');
  const socket = new FakeSocket();
  bidi.ws = socket;
  // connect() installs this handler on the real socket. The fake is wired the
  // same way so the answer travels the path the client actually reads.
  socket.onmessage = (event) => bidi.receive(event);
  return { bidi, socket };
}

test('an answered command settles and leaves nothing pending', async () => {
  const { bidi, socket } = client();
  const answer = bidi.cmd('browsingContext.captureScreenshot', { context: 'a' }, 500);
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].method, 'browsingContext.captureScreenshot');

  socket.answer(socket.sent[0].id, { data: 'png' });
  assert.deepEqual(await answer, { data: 'png' });
  assert.equal(bidi.pending.size, 0, 'the answered command left the map');
  assert.equal(bidi.closed, false);
  assert.equal(socket.closed, false);
});

test('an unanswered command retires the session instead of wedging it', async () => {
  const { bidi, socket } = client();
  const began = Date.now();
  await assert.rejects(
    bidi.cmd('browsingContext.captureScreenshot', { context: 'a' }, 60),
    /timeout: browsingContext\.captureScreenshot/
  );
  assert.ok(Date.now() - began >= 50, 'the command waited for its own deadline');
  assert.equal(bidi.closed, true, 'the client is retired');
  assert.equal(socket.closed, true, 'the stalled socket is closed');
  assert.equal(bidi.pending.size, 0, 'the timed out command left the map');
});

test('a later command fails at once after a timeout', async () => {
  const { bidi, socket } = client();
  await assert.rejects(bidi.cmd('browsingContext.captureScreenshot', {}, 40), /timeout/);
  const sent = socket.sent.length;
  const began = Date.now();
  await assert.rejects(bidi.cmd('script.evaluate', { expression: '1' }), /session closed/);
  assert.ok(Date.now() - began < 40, 'the retired client does not wait');
  assert.equal(socket.sent.length, sent, 'nothing new is queued on the socket');
});

test('close settles every waiter and is safe to repeat', async () => {
  const { bidi } = client();
  const first = bidi.cmd('script.evaluate', { expression: '1' });
  const second = bidi.cmd('script.evaluate', { expression: '2' });
  bidi.close();
  await assert.rejects(first, /session closed/);
  await assert.rejects(second, /session closed/);
  bidi.close();
  assert.equal(bidi.pending.size, 0);
});

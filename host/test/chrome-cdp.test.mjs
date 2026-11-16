// The Chromium side of trusted input. A BiDi action list has to arrive as CDP
// events, and the facade has to answer the three commands the watcher uses.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ChromeCdp, cdpEvents, keyFor } from '../chrome-cdp.mjs';

test('a click becomes a move, a press and a release at its point', () => {
  const events = cdpEvents([
    {
      type: 'pointer',
      actions: [
        { type: 'pointerMove', x: 40, y: 80 },
        { type: 'pointerDown', button: 0 },
        { type: 'pointerUp', button: 0 },
      ],
    },
  ]);
  assert.deepEqual(
    events.map((event) => event.params.type),
    ['mouseMoved', 'mousePressed', 'mouseReleased']
  );
  assert.deepEqual(events[0].params, { type: 'mouseMoved', x: 40, y: 80, buttons: 0 });
  assert.equal(events[1].params.button, 'left');
  assert.equal(events[1].params.buttons, 1);
  assert.equal(events[2].params.buttons, 0);
  assert.ok(events.every((event) => event.method === 'Input.dispatchMouseEvent'));
});

test('a right press keeps its own button bit', () => {
  const events = cdpEvents([
    {
      type: 'pointer',
      actions: [
        { type: 'pointerMove', x: 5, y: 6 },
        { type: 'pointerDown', button: 2 },
      ],
    },
  ]);
  assert.equal(events[1].params.button, 'right');
  assert.equal(events[1].params.buttons, 2);
});

test('a named key carries a code, a virtual key and its text', () => {
  const held = keyFor('Enter');
  assert.deepEqual(held, { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' });
  const events = cdpEvents([
    {
      type: 'key',
      actions: [
        { type: 'keyDown', value: 'Enter' },
        { type: 'keyUp', value: 'Enter' },
      ],
    },
  ]);
  assert.equal(events.length, 2);
  assert.equal(events[0].params.type, 'keyDown');
  assert.equal(events[0].params.windowsVirtualKeyCode, 13);
  assert.equal(events[0].params.text, '\r');
  assert.equal(events[1].params.type, 'keyUp');
  assert.equal(events[1].params.text, undefined);
});

test('a text run types every character down and up', () => {
  const events = cdpEvents([
    {
      type: 'key',
      actions: [...'hi'].flatMap((char) => [
        { type: 'keyDown', value: char },
        { type: 'keyUp', value: char },
      ]),
    },
  ]);
  assert.equal(events.length, 4);
  assert.deepEqual(
    events.filter((event) => event.params.type === 'keyDown').map((event) => event.params.text),
    ['h', 'i']
  );
  assert.equal(keyFor('h').code, 'KeyH');
  assert.equal(keyFor('7').code, 'Digit7');
});

test('a wheel record becomes one wheel event at its point', () => {
  const [wheel] = cdpEvents([
    {
      type: 'scroll',
      actions: [{ type: 'scroll', x: 10, y: 20, deltaX: 0, deltaY: 120, origin: 'viewport' }],
    },
  ]);
  assert.deepEqual(wheel.params, {
    type: 'mouseWheel',
    x: 10,
    y: 20,
    deltaX: 0,
    deltaY: 120,
  });
});

function fakeSocket() {
  const calls = [];
  return {
    calls,
    onEvent: null,
    closed: false,
    async send(method, params = {}, sessionId = null) {
      calls.push({ method, params, sessionId });
      if (method === 'Target.getTargets') {
        return {
          targetInfos: [
            { targetId: 'room', type: 'page', url: 'http://127.0.0.1:8787/?room=r1' },
            { targetId: 'dev', type: 'page', url: 'devtools://devtools/bundled/inspector.html' },
            { targetId: 'worker', type: 'service_worker', url: 'http://127.0.0.1:8787/sw.js' },
          ],
        };
      }
      if (method === 'Target.attachToTarget') return { sessionId: `s-${params.targetId}` };
      if (method === 'Runtime.evaluate') return { result: { value: '{"peerList":[]}' } };
      return {};
    },
    close() {
      this.closed = true;
    },
  };
}

test('the facade lists page targets and answers an evaluate', async () => {
  const socket = fakeSocket();
  const cdp = new ChromeCdp(socket);
  const tree = await cdp.cmd('browsingContext.getTree', {});
  assert.deepEqual(tree.contexts.map((item) => item.context), ['room']);

  const value = await cdp.cmd('script.evaluate', {
    expression: 'document.documentElement.dataset.brosr',
    target: { context: 'room' },
  });
  assert.equal(value.result.value, '{"peerList":[]}');

  // A second read reuses the session instead of attaching again.
  await cdp.cmd('script.evaluate', { expression: '1', target: { context: 'room' } });
  assert.equal(socket.calls.filter((call) => call.method === 'Target.attachToTarget').length, 1);
  assert.equal(
    socket.calls.filter((call) => call.method === 'Runtime.evaluate').at(-1).sessionId,
    's-room'
  );
});

test('the facade raises the tab and sends keys on the target session', async () => {
  const socket = fakeSocket();
  const cdp = new ChromeCdp(socket);
  await cdp.cmd('input.performActions', {
    context: 'room',
    actions: [
      {
        type: 'key',
        actions: [
          { type: 'keyDown', value: 'a' },
          { type: 'keyUp', value: 'a' },
        ],
      },
    ],
  });
  const keys = socket.calls.filter((call) => call.method === 'Input.dispatchKeyEvent');
  assert.equal(keys.length, 2);
  assert.equal(keys[0].sessionId, 's-room');
  assert.equal(keys[0].params.text, 'a');
  assert.ok(socket.calls.some((call) => call.method === 'Target.activateTarget'));

  cdp.close();
  assert.equal(socket.closed, true);
});

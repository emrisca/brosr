// The Chromium side of trusted input. A BiDi action list has to arrive as CDP
// events, and the facade has to answer the three commands the watcher uses.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ChromeCdp, cdpEvents, keyFor } from '../chrome-cdp.mjs';
import { BIDI_KEYS, actionsForRecord } from '../../core/trust.mjs';

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

test('a right press and back/forward buttons keep their own button bits', () => {
  const events = cdpEvents([
    {
      type: 'pointer',
      actions: [
        { type: 'pointerMove', x: 5, y: 6 },
        { type: 'pointerDown', button: 2 },
        { type: 'pointerDown', button: 3 },
        { type: 'pointerDown', button: 4 },
        { type: 'pointerUp', button: 4 },
      ],
    },
  ]);
  assert.equal(events[1].params.button, 'right');
  assert.equal(events[1].params.buttons, 2);
  assert.equal(events[2].params.button, 'back');
  assert.equal(events[2].params.buttons, 2 | 8);
  assert.equal(events[3].params.button, 'forward');
  assert.equal(events[3].params.buttons, 2 | 8 | 16);
  assert.equal(events[4].params.button, 'forward');
  assert.equal(events[4].params.buttons, 2 | 8);
});

test('a named key and its BiDi code point carry a code, a virtual key and its text', () => {
  const held = keyFor('Enter');
  assert.deepEqual(held, { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' });
  assert.deepEqual(keyFor(BIDI_KEYS.Enter), held);
  assert.deepEqual(keyFor(BIDI_KEYS.Backspace), { key: 'Backspace', code: 'Backspace', keyCode: 8 });
  assert.deepEqual(keyFor(BIDI_KEYS.F5), { key: 'F5', code: 'F5', keyCode: 116 });
  assert.deepEqual(keyFor(' '), { key: ' ', code: 'Space', keyCode: 32, text: ' ' });

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

test('a text run types every character down and up, keeping Space code', () => {
  const events = cdpEvents([
    {
      type: 'key',
      actions: [...'h i'].flatMap((char) => [
        { type: 'keyDown', value: char },
        { type: 'keyUp', value: char },
      ]),
    },
  ]);
  assert.equal(events.length, 6);
  assert.deepEqual(
    events.filter((event) => event.params.type === 'keyDown').map((event) => event.params.text),
    ['h', ' ', 'i']
  );
  assert.equal(events[2].params.code, 'Space');
  assert.equal(keyFor('h').code, 'KeyH');
  assert.equal(keyFor('7').code, 'Digit7');
});

test('a BiDi wheel source and legacy scroll source both become a CDP mouseWheel event', () => {
  const [wheel] = cdpEvents([
    {
      type: 'wheel',
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

  const [legacy] = cdpEvents([
    {
      type: 'scroll',
      actions: [{ type: 'scroll', x: 10, y: 20, deltaX: 5, deltaY: -60, origin: 'viewport' }],
    },
  ]);
  assert.deepEqual(legacy.params, {
    type: 'mouseWheel',
    x: 10,
    y: 20,
    deltaX: 5,
    deltaY: -60,
  });
});

test('multi-source BiDi ticks carry keyboard modifiers onto wheel and pointer events', () => {
  const wheelWithMods = cdpEvents([
    {
      type: 'key',
      id: 'brosr-keys',
      actions: [
        { type: 'keyDown', value: '\uE009' },
        { type: 'keyDown', value: '\uE008' },
        { type: 'pause', duration: 0 },
        { type: 'keyUp', value: '\uE008' },
        { type: 'keyUp', value: '\uE009' },
      ],
    },
    {
      type: 'wheel',
      id: 'brosr-wheel',
      actions: [
        { type: 'pause', duration: 0 },
        { type: 'pause', duration: 0 },
        { type: 'scroll', x: 100, y: 200, deltaX: 0, deltaY: -120, duration: 0, origin: 'viewport' },
        { type: 'pause', duration: 0 },
        { type: 'pause', duration: 0 },
      ],
    },
  ]);
  const wheelEvent = wheelWithMods.find((e) => e.params.type === 'mouseWheel');
  assert.ok(wheelEvent);
  assert.equal(wheelEvent.params.modifiers, 2 | 8);

  const clickWithAlt = cdpEvents(
    actionsForRecord({
      kind: 'click',
      point: { x: 30, y: 40 },
      button: 0,
      alt: true,
    })
  );
  const press = clickWithAlt.find((e) => e.params.type === 'mousePressed');
  assert.ok(press);
  assert.equal(press.params.modifiers, 1);
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

test('target detachment and stale sessions re-attach cleanly, and missing targets reject', async () => {
  let attachCount = 0;
  let failStaleOnce = false;
  let failSecondKey = false;
  let keyCalls = 0;
  const calls = [];
  const socket = {
    onEvent: null,
    closed: false,
    async send(method, params = {}, sessionId = null) {
      calls.push({ method, params, sessionId });
      if (method === 'Target.attachToTarget') {
        if (params.targetId === 'missing') {
          throw new Error('No target with given id');
        }
        attachCount += 1;
        return { sessionId: `s-${params.targetId}-${attachCount}` };
      }
      if (method === 'Runtime.evaluate' || method === 'Input.dispatchMouseEvent') {
        if (failStaleOnce) {
          failStaleOnce = false;
          throw new Error('Session with given id not found');
        }
        return { result: { value: 'ok' } };
      }
      if (method === 'Input.dispatchKeyEvent') {
        keyCalls += 1;
        if (failSecondKey && keyCalls === 2) {
          throw new Error('Target closed');
        }
        return {};
      }
      return {};
    },
    close() {
      this.closed = true;
    },
  };

  const cdp = new ChromeCdp(socket);

  // Concurrent session() calls deduplicate attach.
  const [s1, s2] = await Promise.all([cdp.session('room'), cdp.session('room')]);
  assert.equal(s1, s2);
  assert.equal(attachCount, 1);

  // Target.detachedFromTarget with sessionId only evicts the cached session.
  socket.onEvent({ method: 'Target.detachedFromTarget', params: { sessionId: s1 } });
  const sDetached = await cdp.session('room');
  assert.equal(attachCount, 2);
  assert.notEqual(sDetached, s1);

  // Target.targetDestroyed evicts the cached session.
  socket.onEvent({ method: 'Target.targetDestroyed', params: { targetId: 'room' } });
  const s3 = await cdp.session('room');
  assert.equal(attachCount, 3);
  assert.notEqual(s3, sDetached);

  // A stale session error during evaluate evicts and re-attaches once.
  failStaleOnce = true;
  const evaluated = await cdp.cmd('script.evaluate', {
    expression: '1',
    target: { context: 'room' },
  });
  assert.equal(evaluated.result.value, 'ok');
  assert.equal(attachCount, 4);

  // A stale session error on the first performActions event evicts and re-attaches once.
  failStaleOnce = true;
  await cdp.cmd('input.performActions', {
    context: 'room',
    actions: actionsForRecord({ kind: 'click', point: { x: 10, y: 20 }, button: 0 }),
  });
  assert.equal(attachCount, 5);
  const mouseCalls = calls.filter((c) => c.method === 'Input.dispatchMouseEvent');
  assert.equal(mouseCalls.at(-1).sessionId, 's-room-5');

  // A mid-batch detachment evicts the dead session without duplicating earlier events.
  failSecondKey = true;
  await assert.rejects(
    () =>
      cdp.cmd('input.performActions', {
        context: 'room',
        actions: actionsForRecord({ kind: 'key', key: 'a' }),
      }),
    /Target closed/
  );
  assert.equal(keyCalls, 2);
  assert.equal(cdp.sessions.has('room'), false);

  // Missing target rejects cleanly without caching a bad session.
  await assert.rejects(
    () => cdp.cmd('input.performActions', { context: 'missing', actions: [] }),
    /No target with given id/
  );
  assert.equal(cdp.sessions.has('missing'), false);
});

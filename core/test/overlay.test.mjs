import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ActionNotice,
  CursorOverlay,
  CURSOR_WIDTH,
  actionText,
  mediaAction,
} from '../overlay.mjs';

function fakeElement() {
  const node = {
    style: {},
    children: [],
    parentNode: null,
    textContent: '',
    attributes: {},
    setAttribute(name, value) {
      node.attributes[name] = value;
    },
    appendChild(child) {
      child.parentNode = node;
      node.children.push(child);
      return child;
    },
    removeChild(child) {
      node.children = node.children.filter((entry) => entry !== child);
      child.parentNode = null;
      return child;
    },
    attachShadow(options) {
      node.shadowMode = options.mode;
      node.shadowRoot = fakeElement();
      return node.shadowRoot;
    },
  };
  return node;
}

function fakeDocument() {
  return {
    documentElement: fakeElement(),
    createElement: () => fakeElement(),
  };
}

function animatedDocument() {
  const doc = fakeDocument();
  const frames = [];
  doc.defaultView = {
    requestAnimationFrame(fn) {
      frames.push(fn);
      return frames.length;
    },
    cancelAnimationFrame() {},
    matchMedia: () => ({ matches: false }),
  };
  doc.frames = frames;
  doc.runFrame = (time) => {
    const fn = frames.shift();
    if (fn) fn(time);
  };
  return doc;
}

test('the notice words an action with the person behind it', () => {
  assert.equal(actionText({ name: 'Bob', action: 'pause' }), 'Bob paused the video');
  assert.equal(actionText({ name: 'Carol', action: 'play' }), 'Carol played the video');
  assert.equal(actionText({ name: 'Bob', action: 'seek', position: 65 }), 'Bob jumped to 1:05');
  assert.equal(actionText({ name: 'Bob', action: 'seek', position: 3725 }), 'Bob jumped to 1:02:05');
  assert.equal(actionText({ name: 'Bob', action: 'rate', rate: 1.5 }), 'Bob set the speed to 1.5x');
  assert.equal(actionText({ name: '', action: 'pause' }), '');
  assert.equal(actionText({ name: 'Bob', action: 'tick' }), '');
});

test('a frame names an action only when a person changed something', () => {
  const prev = { key: 'youtube:x', position: 10, playing: true, rate: 1, at: 1000 };
  const tick = { key: 'youtube:x', position: 10.25, playing: true, rate: 1 };
  assert.equal(mediaAction(null, tick, 1000), null);
  assert.equal(mediaAction(prev, tick, 1000), null);
  assert.equal(mediaAction(prev, { ...tick, playing: false }, 1000), 'pause');
  assert.equal(mediaAction({ ...prev, playing: false }, { ...tick, playing: true }, 1000), 'play');
  assert.equal(mediaAction(prev, { ...tick, rate: 1.5 }, 1000), 'rate');
  assert.equal(mediaAction(prev, { ...tick, position: 40 }, 1000), 'seek');
  assert.equal(mediaAction(prev, { ...tick, key: 'youtube:other' }, 1000), null);
  // A paused tab does not advance, so a small gap there is still a seek.
  const paused = { ...prev, playing: false };
  assert.equal(mediaAction(paused, { ...tick, playing: false, position: 8.5 }, 1000), 'seek');
});

test('the notice mounts one closed shadow root and hides itself', () => {
  const doc = fakeDocument();
  const timers = [];
  const notice = new ActionNotice({
    document: doc,
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => {},
  });
  assert.equal(notice.show({ name: 'Bob', action: 'tick' }), false);
  assert.equal(doc.documentElement.children.length, 0, 'a tick mounts nothing');

  assert.equal(notice.show({ name: 'Bob', action: 'pause' }), true);
  const host = doc.documentElement.children[0];
  assert.equal(host.shadowMode, 'closed');
  assert.equal(host.attributes['data-brosr-notice'], '');
  assert.equal(host.style.pointerEvents, 'none');
  assert.equal(host.style.position, 'fixed');
  assert.equal(host.style.inset, '0');
  const [node] = notice.shadow.children;
  assert.equal(node.style.top, '16px');
  assert.equal(node.style.left, '50%');
  assert.equal(node.attributes.role, 'status');
  assert.equal(node.attributes['aria-live'], 'polite');
  assert.equal(notice.stats().text, 'Bob paused the video');
  assert.equal(node.style.opacity, '1');

  timers[0]();
  assert.equal(node.style.opacity, '0');
  assert.equal(notice.stats().showing, false);
});

test('the overlay mounts one host inside a closed shadow root', () => {
  const doc = fakeDocument();
  const overlay = new CursorOverlay({ document: doc }).attach();
  const host = doc.documentElement.children[0];
  assert.equal(host.shadowMode, 'closed');
  assert.equal(host.attributes['data-brosr-overlay'], '');
  assert.equal(host.style.pointerEvents, 'none');
  assert.equal(host.style.position, 'fixed');
  assert.equal(doc.documentElement.children.length, 1);
  assert.deepEqual(overlay.stats(), { mounted: true, peers: 0 });
});

test('a peer cursor is one node that moves instead of piling up', () => {
  const doc = fakeDocument();
  const overlay = new CursorOverlay({ document: doc }).attach();
  overlay.setPeer({ id: 'bob', name: 'Bob', colour: '#3f86e2', point: { x: 10.4, y: 20.6 } });
  const layer = overlay.layer;
  assert.equal(layer.children.length, 1);
  const [wrap] = layer.children;
  assert.equal(wrap.style.transform, 'translate3d(10.4px, 20.6px, 0)');
  const [pointer, label] = wrap.children;
  assert.equal(pointer.style.width, `${CURSOR_WIDTH}px`);
  assert.equal(pointer.style.color, '#3f86e2');
  assert.equal(pointer.children[0].attributes.fill, 'currentColor');
  assert.equal(label.textContent, 'Bob');

  overlay.setPeer({ id: 'bob', name: 'Bob', colour: '#3f86e2', point: { x: 300, y: 400 } });
  assert.equal(layer.children.length, 1);
  assert.equal(wrap.style.transform, 'translate3d(300px, 400px, 0)');
  assert.deepEqual(overlay.stats(), { mounted: true, peers: 1 });
});

test('two peers get two cursors, and a removal leaves the other', () => {
  const doc = fakeDocument();
  const overlay = new CursorOverlay({ document: doc }).attach();
  overlay.setPeer({ id: 'bob', point: { x: 1, y: 2 } });
  overlay.setPeer({ id: 'carol', point: { x: 3, y: 4 } });
  assert.equal(overlay.layer.children.length, 2);
  assert.equal(overlay.removePeer('bob'), true);
  assert.equal(overlay.removePeer('bob'), false);
  assert.equal(overlay.layer.children.length, 1);
  overlay.clear();
  assert.equal(overlay.layer.children.length, 0);
});

test('a peer without a colour falls back to the room default', () => {
  const doc = fakeDocument();
  const overlay = new CursorOverlay({ document: doc }).attach();
  const node = overlay.setPeer({ id: 'bob', point: { x: 0, y: 0 } });
  assert.equal(node.pointer.style.color, '#e2603f');
  assert.equal(node.label.textContent, 'bob');
});

test('a moved cursor eases toward the new point instead of jumping', () => {
  const doc = animatedDocument();
  const overlay = new CursorOverlay({ document: doc }).attach();
  const node = overlay.setPeer({ id: 'bob', point: { x: 10, y: 10 } });
  doc.runFrame(0);
  assert.equal(doc.frames.length, 0, 'a settled cursor stops the frame loop');

  overlay.setPeer({ id: 'bob', point: { x: 210, y: 10 } });
  assert.equal(doc.frames.length, 1);

  doc.runFrame(16);
  const mid = Number(/translate3d\(([-\d.]+)px/.exec(node.wrap.style.transform)[1]);
  assert.ok(mid > 10 && mid < 210, 'the first frame covers part of the distance');

  for (let time = 32; time < 3000 && doc.frames.length; time += 16) doc.runFrame(time);
  assert.equal(node.wrap.style.transform, 'translate3d(210px, 10px, 0)');
  assert.equal(doc.frames.length, 0);
});

test('a far point is a jump, because easing it would invent a path', () => {
  const doc = animatedDocument();
  const overlay = new CursorOverlay({ document: doc }).attach();
  const node = overlay.setPeer({ id: 'bob', point: { x: 10, y: 10 } });
  doc.runFrame(0);
  overlay.setPeer({ id: 'bob', point: { x: 900, y: 10 } });
  doc.runFrame(16);
  assert.equal(node.wrap.style.transform, 'translate3d(900px, 10px, 0)');
});

test('a cursor with no position yet stays hidden until the peer moves', () => {
  const doc = fakeDocument();
  const overlay = new CursorOverlay({ document: doc }).attach();
  const node = overlay.setPeer({ id: 'bob', point: { x: 0, y: 0 } });
  assert.equal(node.wrap.style.visibility, 'hidden');
  overlay.setPeer({ id: 'bob', point: { x: 8, y: 8 } });
  assert.equal(node.wrap.style.visibility, 'visible');
});

test('destroy takes the host out of the page and can be mounted again', () => {
  const doc = fakeDocument();
  const overlay = new CursorOverlay({ document: doc }).attach();
  overlay.setPeer({ id: 'bob', point: { x: 1, y: 1 } });
  overlay.destroy();
  assert.equal(doc.documentElement.children.length, 0);
  assert.deepEqual(overlay.stats(), { mounted: false, peers: 0 });
  overlay.attach();
  assert.equal(doc.documentElement.children.length, 1);
});

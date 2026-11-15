import test from 'node:test';
import assert from 'node:assert/strict';
import { CursorOverlay, CURSOR_WIDTH } from '../overlay.mjs';

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

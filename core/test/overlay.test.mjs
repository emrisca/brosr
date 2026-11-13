import test from 'node:test';
import assert from 'node:assert/strict';
import { CursorOverlay, CURSOR_SIZE } from '../overlay.mjs';

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
  assert.equal(wrap.style.transform, 'translate(10px, 21px)');
  const [dot, label] = wrap.children;
  assert.equal(dot.style.width, `${CURSOR_SIZE}px`);
  assert.equal(dot.style.background, '#3f86e2');
  assert.equal(label.textContent, 'Bob');

  overlay.setPeer({ id: 'bob', name: 'Bob', colour: '#3f86e2', point: { x: 300, y: 400 } });
  assert.equal(layer.children.length, 1);
  assert.equal(wrap.style.transform, 'translate(300px, 400px)');
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
  assert.equal(node.dot.style.background, '#e2603f');
  assert.equal(node.label.textContent, 'bob');
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

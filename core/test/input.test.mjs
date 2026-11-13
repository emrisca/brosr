import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GrantBook,
  InputBatcher,
  BLOCKED_ORIGINS,
  isSensitiveField,
  originAllowed,
  replayInput,
  resolvePath,
  canvasPoint,
} from '../input.mjs';
import { decode } from '../protocol.mjs';

function fixedClock(value = 0) {
  let now = value;
  const clock = () => now;
  clock.advance = (ms) => {
    now += ms;
  };
  return clock;
}

function field(props = {}) {
  return {
    tagName: 'INPUT',
    type: 'text',
    getAttribute(name) {
      return props[name] || '';
    },
  };
}

test('a grant names one peer, one tab and one origin', () => {
  const now = fixedClock(0);
  const book = new GrantBook({ now });
  assert.equal(book.allows('peer', { kind: 'click' }), false);
  book.grant('peer', { tabId: 'tab-1', origin: 'https://a.test' });
  assert.equal(book.allows('peer', { tabId: 'tab-1', origin: 'https://a.test', kind: 'click' }), true);
  assert.equal(book.allows('peer', { tabId: 'tab-2', origin: 'https://a.test', kind: 'click' }), false);
  assert.equal(book.allows('peer', { tabId: 'tab-1', origin: 'https://b.test', kind: 'click' }), false);
  assert.equal(book.allows('other', { tabId: 'tab-1', origin: 'https://a.test', kind: 'click' }), false);
});

test('a cursor and a scroll need no grant', () => {
  const book = new GrantBook();
  assert.equal(book.allows('anyone', { kind: 'move' }), true);
  assert.equal(book.allows('anyone', { kind: 'scroll' }), true);
});

test('a grant expires and a closed tab revokes it', () => {
  const now = fixedClock(0);
  const book = new GrantBook({ now });
  book.grant('peer', { tabId: 'tab-1', origin: 'https://a.test', ttlMs: 1000 });
  now.advance(1001);
  assert.equal(book.allows('peer', { tabId: 'tab-1', origin: 'https://a.test', kind: 'click' }), false);
  assert.equal(book.active().length, 0);

  book.grant('peer', { tabId: 'tab-2', origin: 'https://a.test' });
  assert.equal(book.active().length, 1);
  book.endTab('tab-2');
  assert.equal(book.active().length, 0);
});

test('a password field, a credential hint and a card field count as sensitive', () => {
  assert.equal(isSensitiveField({ ...field({ autocomplete: 'current-password' }) }), true);
  assert.equal(isSensitiveField({ ...field(), type: 'password' }), true);
  assert.equal(isSensitiveField(field({ autocomplete: 'cc-number' })), true);
  assert.equal(isSensitiveField(field({ name: 'cardNumber' })), true);
  assert.equal(isSensitiveField(field({ id: 'cvv' })), true);
  assert.equal(isSensitiveField(field({ name: 'search' })), false);
  assert.equal(isSensitiveField({ tagName: 'DIV' }), false);
  assert.equal(isSensitiveField(null), true);
});

test('the origin allowlist refuses a payment site and an unparsable URL', () => {
  assert.equal(originAllowed('https://example.test/page'), true);
  assert.equal(originAllowed('https://www.paypal.com/checkout'), false);
  assert.ok(BLOCKED_ORIGINS.includes('https://www.paypal.com'));
  assert.equal(originAllowed('not a url'), false);
});

test('a path resolves only when it names exactly one element', () => {
  const one = { id: 'one' };
  const root = {
    querySelectorAll: (path) => {
      if (path === '#one') return [one];
      if (path === '#none') return [];
      return [one, { id: 'two' }];
    },
  };
  assert.equal(resolvePath(root, '#one'), one);
  assert.equal(resolvePath(root, '#none'), null);
  assert.equal(resolvePath(root, '#many'), null);
  assert.equal(resolvePath(root, ''), null);
});

test('a canvas fraction maps to a point inside the canvas', () => {
  const canvas = {
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 400, height: 200 }),
  };
  assert.deepEqual(canvasPoint(canvas, { x: 0.5, y: 0.25 }), { x: 300, y: 100 });
  assert.deepEqual(canvasPoint(canvas, { x: 4, y: -1 }), { x: 500, y: 50 });
});

test('the batcher keeps the last move and the order of clicks', () => {
  const sent = [];
  const batcher = new InputBatcher({ send: (frame) => sent.push(decode(frame)) });
  batcher.move({ kind: 'move', x: 1, y: 2 });
  batcher.move({ kind: 'move', x: 3, y: 4 });
  batcher.push({ kind: 'click', path: '#go' });
  assert.equal(batcher.flush(), 2);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'input');
  assert.equal(sent[0].seq, 1);
  assert.deepEqual(
    sent[0].records.map((record) => record.kind),
    ['move', 'click']
  );
  assert.equal(sent[0].records[0].x, 3, 'only the newest move survived');
  assert.equal(batcher.stats().movesDropped, 1);
  assert.equal(batcher.flush(), 0, 'an empty flush sends nothing');
});

test('a large batch splits into frames with increasing sequence numbers', () => {
  const sent = [];
  const batcher = new InputBatcher({ send: (frame) => sent.push(decode(frame)) });
  for (let index = 0; index < 120; index += 1) {
    batcher.push({ kind: 'text', path: '#field', value: 'x'.repeat(200), index });
  }
  batcher.flush();
  assert.ok(sent.length > 1, 'the batch needed more than one frame');
  const seqs = sent.map((message) => message.seq);
  assert.deepEqual([...seqs].sort((a, b) => a - b), seqs);
  assert.equal(new Set(seqs).size, seqs.length);
  let total = sent.reduce((sum, message) => sum + message.records.length, 0);
  assert.equal(total, 120);
});

test('replay drops a record without a grant, without a target, or on a password field', () => {
  const allowedElement = {
    tagName: 'BUTTON',
    ownerDocument: null,
    getAttribute: () => '',
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
    dispatchEvent: () => true,
  };
  const password = { ...field({ id: 'password' }), getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  password.type = 'password';
  const root = {
    activeElement: null,
    defaultView: {
      Event: class {},
      MouseEvent: class {
        constructor(type) {
          this.type = type;
        }
      },
      KeyboardEvent: class {},
      WheelEvent: class {},
    },
    querySelectorAll: (path) => {
      if (path === '#allowed') return [allowedElement];
      if (path === '#password') return [password];
      if (path === '#denied') return [allowedElement];
      return [];
    },
    dispatchEvent: () => true,
  };

  const result = replayInput(
    [
      { kind: 'click', path: '#allowed' },
      { kind: 'click', path: '#denied' },
      { kind: 'click', path: '#missing' },
      { kind: 'click', path: '#password' },
      { kind: 'move', x: 1, y: 1 },
    ],
    { root, allowed: (record) => record.path !== '#denied' }
  );

  assert.equal(result.applied, 1);
  assert.equal(result.dropped, 3);
  assert.equal(result.reasons.grant, 1);
  assert.equal(result.reasons.target, 1);
  assert.equal(result.reasons.sensitive, 1);
  assert.equal(result.reasons.move, undefined, 'a move is not a failure');
});

test('a click across a layout mismatch is dropped, and the reason says so', () => {
  const button = {
    tagName: 'BUTTON',
    ownerDocument: null,
    getAttribute: () => '',
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
    dispatchEvent: () => true,
  };
  const root = {
    activeElement: null,
    defaultView: {
      Event: class {},
      MouseEvent: class {
        constructor(type) {
          this.type = type;
        }
      },
      KeyboardEvent: class {},
      WheelEvent: class {},
    },
    querySelectorAll: (path) => (path === '#go' ? [button] : []),
    dispatchEvent: () => true,
  };

  const matched = replayInput([{ kind: 'click', path: '#go' }], { root });
  assert.equal(matched.applied, 1, 'the same layout still applies the click');

  const mismatch = replayInput([{ kind: 'click', path: '#go' }], { root, layoutMatches: false });
  assert.equal(mismatch.applied, 0);
  assert.equal(mismatch.dropped, 1);
  assert.equal(mismatch.reasons.layout, 1);
  assert.equal(mismatch.reasons.target, undefined, 'the target resolved, so it is not a target drop');
});

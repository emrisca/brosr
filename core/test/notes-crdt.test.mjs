// Co-typing rests on one claim: two pages that receive the same operations in
// any order show the same note. These tests apply operations to two models in
// opposite orders and compare the text, the faces and the block order.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDoc,
  addBlock,
  ensureBlock,
  insertText,
  deleteText,
  setMarkIds,
  setBlockType,
  deleteBlock,
  apply,
  snapshot,
  restore,
  blockOrder,
  charOrder,
  blockText,
  docText,
  runsOf,
  markString,
} from '../../landing/notes/text-crdt.mjs';

function pair() {
  const a = createDoc('aaaa');
  const b = createDoc('bbbb');
  const first = ensureBlock(a);
  // Give the second page the same starting block by replaying the add.
  apply(b, { op: 'badd', b: first, l: '', t: 'p' });
  return { a, b, first };
}

function shuffled(list, order) {
  return order.map((index) => list[index]);
}

test('a character keeps the id of the one it was typed after', () => {
  const doc = createDoc('aaaa');
  const block = ensureBlock(doc);
  const ops = insertText(doc, block, 0, 'hi');
  assert.equal(ops.length, 2);
  assert.equal(ops[0].p, '');
  assert.equal(ops[1].p, ops[0].i);
  assert.equal(blockText(doc.blocks.get(block)), 'hi');
});

test('two people typing at the same spot both keep their words', () => {
  const { a, b, first } = pair();
  const mine = insertText(a, first, 0, 'hello');
  const yours = insertText(b, first, 0, 'world');

  for (const op of mine) apply(b, op);
  for (const op of yours) apply(a, op);

  assert.equal(docText(a), docText(b));
  assert.equal(docText(a).length, 10);
  assert.ok(docText(a).includes('hello'));
  assert.ok(docText(a).includes('world'));
});

test('both orders of the same two batches settle on one text', () => {
  const { a, b, first } = pair();
  const mine = insertText(a, first, 0, 'abc');
  const yours = insertText(b, first, 0, 'xyz');

  for (const op of [...mine, ...yours]) apply(b, op);

  const third = restore(snapshot(a), 'cccc');
  for (const op of shuffled([...yours, ...mine], [5, 4, 3, 2, 1, 0])) apply(third, op);

  assert.equal(docText(b), docText(third));
});

test('typing mid word does not cut the other side out', () => {
  const { a, b, first } = pair();
  for (const op of insertText(a, first, 0, 'shell')) apply(b, op);
  for (const op of insertText(a, first, 5, 'fish')) apply(b, op);
  assert.equal(blockText(a.blocks.get(first)), 'shellfish');

  // One types inside the word while the other appends at the end.
  const left = insertText(a, first, 2, 'X');
  const right = insertText(b, first, 9, 'Y');
  for (const op of right) apply(a, op);
  for (const op of left) apply(b, op);

  assert.equal(blockText(a.blocks.get(first)), blockText(b.blocks.get(first)));
  assert.equal(blockText(a.blocks.get(first)), 'shXellfishY');
});

test('a delete on one side and an insert on the other both land', () => {
  const { a, b, first } = pair();
  for (const op of insertText(a, first, 0, 'draft')) apply(b, op);

  const cut = deleteText(a, first, 0, 1);
  const add = insertText(b, first, 5, '!');
  for (const op of add) apply(a, op);
  for (const op of cut) apply(b, op);

  assert.equal(blockText(a.blocks.get(first)), 'raft!');
  assert.equal(blockText(b.blocks.get(first)), 'raft!');
});

test('deleting the character another person typed after keeps that text', () => {
  const { a, b, first } = pair();
  for (const op of insertText(a, first, 0, 'ab')) apply(b, op);
  // b types between a and b, then a deletes the a.
  for (const op of insertText(b, first, 1, 'X')) apply(a, op);
  for (const op of deleteText(a, first, 0, 1)) apply(b, op);
  assert.equal(blockText(a.blocks.get(first)), 'Xb');
  assert.equal(blockText(b.blocks.get(first)), 'Xb');
});

test('a face travels with its characters and merges without a reset', () => {
  const { a, b, first } = pair();
  for (const op of insertText(a, first, 0, 'bold me')) apply(b, op);

  const live = charOrder(a.blocks.get(first));
  const ids = live.slice(0, 4).map((node) => node.id);
  const bold = setMarkIds(a, first, ids, 'b', true);
  assert.ok(bold);
  apply(b, bold);

  const italic = setMarkIds(b, first, live.slice(5, 7).map((node) => node.id), 'i', true);
  apply(a, italic);

  assert.equal(blockText(a.blocks.get(first)), blockText(b.blocks.get(first)));
  const left = runsOf(a.blocks.get(first)).map((run) => run.marks + ':' + run.text);
  const right = runsOf(b.blocks.get(first)).map((run) => run.marks + ':' + run.text);
  assert.deepEqual(left, right);
  assert.deepEqual(left, ['b:bold', ': ', 'i:me']);
});

test('two people formatting the same word keep both marks', () => {
  const { a, b, first } = pair();
  for (const op of insertText(a, first, 0, 'word')) apply(b, op);
  const ids = charOrder(a.blocks.get(first)).map((node) => node.id);

  const u = setMarkIds(a, first, ids, 'u', true);
  const h = setMarkIds(b, first, ids, 'h', true);
  apply(b, u);
  apply(a, h);

  const marks = charOrder(a.blocks.get(first)).map((node) => markString(node.marks));
  assert.deepEqual(marks, ['uh', 'uh', 'uh', 'uh']);
  assert.equal(
    charOrder(b.blocks.get(first)).map((node) => markString(node.marks)).join(''),
    marks.join('')
  );
});

test('a mark taken away on one side does not come back', () => {
  const { a, b, first } = pair();
  for (const op of insertText(a, first, 0, 'plain')) apply(b, op);
  const ids = charOrder(a.blocks.get(first)).map((node) => node.id);
  apply(b, setMarkIds(a, first, ids, 'b', true));

  const off = setMarkIds(b, first, ids, 'b', false);
  assert.ok(off);
  apply(a, off);
  assert.equal(charOrder(a.blocks.get(first)).every((node) => node.marks === ''), true);
});

test('two people pressing Enter in the same place keep both lines', () => {
  const { a, b, first } = pair();
  for (const op of insertText(a, first, 0, 'one')) apply(b, op);

  const left = addBlock(a, first, 'p');
  const right = addBlock(b, first, 'p');
  const mine = insertText(a, left.id, 0, 'mine');
  const yours = insertText(b, right.id, 0, 'yours');

  apply(b, left.op);
  apply(a, right.op);
  for (const op of mine) apply(b, op);
  for (const op of yours) apply(a, op);

  const order = blockOrder(a);
  assert.deepEqual(order, blockOrder(b));
  assert.equal(order.length, 3);
  const text = docText(a);
  assert.ok(text.includes('mine'));
  assert.ok(text.includes('yours'));
});

test('a block order survives a snapshot and a restore', () => {
  const doc = createDoc('aaaa');
  let at = ensureBlock(doc);
  insertText(doc, at, 0, 'first');
  for (const value of ['second', 'third']) {
    const made = addBlock(doc, at, value === 'second' ? 'h1' : 'p');
    insertText(doc, made.id, 0, value);
    at = made.id;
  }
  const copy = restore(snapshot(doc), 'cccc');
  assert.deepEqual(blockOrder(copy), blockOrder(doc));
  assert.equal(docText(copy), 'first\nsecond\nthird');
  assert.deepEqual(
    blockOrder(copy).map((id) => copy.blocks.get(id).type),
    ['p', 'h1', 'p']
  );
});

test('a snapshot carries a deleted block and a deleted character', () => {
  const doc = createDoc('aaaa');
  const first = ensureBlock(doc);
  insertText(doc, first, 0, 'gone');
  deleteText(doc, first, 0, 4);
  const second = addBlock(doc, first, 'p');
  insertText(doc, second.id, 0, 'kept');
  deleteBlock(doc, second.id);

  const copy = restore(snapshot(doc), 'cccc');
  assert.deepEqual(blockOrder(copy), blockOrder(doc));
  assert.equal(docText(copy), '');
  assert.equal(copy.blocks.get(first).nodes.size, 4);
});

test('a restore keeps the counter above the ids it carries', () => {
  const doc = createDoc('aaaa');
  const first = ensureBlock(doc);
  insertText(doc, first, 0, 'ab');

  const copy = restore(snapshot(doc), 'aaaa');
  const ops = insertText(copy, first, 2, 'c');
  assert.equal(ops[0].i, 'aaaa:4');
  assert.equal(blockText(copy.blocks.get(first)), 'abc');
});

test('a snapshot can be split across frames and still restore', () => {
  const doc = createDoc('aaaa');
  const first = ensureBlock(doc);
  insertText(doc, first, 0, 'abcdefghij');
  const state = snapshot(doc);
  const rows = state.blocks[0].c;
  // The sender cuts the character table in two and the receiver joins it.
  const partA = { v: 1, blocks: [{ ...state.blocks[0], c: rows.slice(0, 4) }] };
  const partB = { v: 1, blocks: [{ ...state.blocks[0], c: rows.slice(4) }] };
  const joined = {
    v: 1,
    blocks: [{ ...partA.blocks[0], c: [...partA.blocks[0].c, ...partB.blocks[0].c] }],
  };
  const copy = restore(joined, 'cccc');
  assert.equal(blockText(copy.blocks.get(first)), 'abcdefghij');
});

test('an operation that arrives twice changes nothing the second time', () => {
  const { a, b, first } = pair();
  const ops = insertText(a, first, 0, 'once');
  for (const op of ops) apply(b, op);
  const after = docText(b);
  for (const op of ops) apply(b, op);
  assert.equal(docText(b), after);
});

test('an insert that names a block this page has not seen is dropped, not fatal', () => {
  const doc = createDoc('aaaa');
  ensureBlock(doc);
  const touched = apply(doc, { op: 'ins', b: 'missing:1', i: 'aaaa:9', p: '', c: 'x', m: '' });
  assert.equal(touched.size, 0);
  assert.equal(docText(doc), '');
});

test('a block type change on one side reaches the other', () => {
  const { a, b, first } = pair();
  insertText(a, first, 0, 'Title');
  const op = setBlockType(a, first, 'h1');
  apply(b, op);
  assert.equal(b.blocks.get(first).type, 'h1');
  assert.equal(setBlockType(a, first, 'h1'), null);
});

test('a note that starts from html keeps its paragraphs', () => {
  const doc = createDoc('aaaa');
  const first = ensureBlock(doc);
  insertText(doc, first, 0, 'old note');
  const copy = restore(snapshot(doc), 'cccc');
  assert.equal(docText(copy), 'old note');
  assert.deepEqual(blockOrder(copy), blockOrder(doc));
});

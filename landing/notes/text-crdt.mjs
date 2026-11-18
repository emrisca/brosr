'use strict';
// One note, many hands. This is the text model behind the Notes room app: a
// replicated growable array of characters plus an ordered list of blocks. Each
// character and each block carries an id and the id it was placed after, so two
// people who type in the same spot both keep their words and every reader
// settles on one order. No clock, no server, no library.
//
// ids look like "ab12:1f". The site part is per page, the counter only rises,
// and a plain string compare breaks a tie the same way on every machine.

export const TYPES = ['p', 'h1', 'h2', 'pre', 'li', 'li1'];
const TYPE_SET = new Set(TYPES);

export function normalizeType(value) {
  return TYPE_SET.has(value) ? value : 'p';
}

export const MARKS = ['b', 'i', 'u', 'h'];
const MARK_SET = new Set(MARKS);

export function markSet(value) {
  const out = new Set();
  for (const ch of String(value || '')) if (MARK_SET.has(ch)) out.add(ch);
  return out;
}

export function markString(value) {
  const set = value instanceof Set ? value : markSet(value);
  let out = '';
  for (const mark of MARKS) if (set.has(mark)) out += mark;
  return out;
}

function nextId(doc) {
  doc.clock += 1;
  return doc.site + ':' + doc.clock.toString(36);
}

// Children sit in descending id order, so the newest child of an anchor comes
// first. That is what keeps a fresh insert right after the character it was
// typed behind instead of after the text that already followed it.
function addSorted(map, parent, id) {
  const list = map.get(parent);
  if (!list) {
    map.set(parent, [id]);
    return;
  }
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] > id) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, id);
}

export function createDoc(site) {
  const clean = String(site || 'anon').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'anon';
  return {
    site: clean,
    clock: 0,
    blocks: new Map(),
    blockKids: new Map([['', []]]),
    blockDeleted: new Set(),
  };
}

function placeBlock(doc, id, left, type) {
  if (typeof id !== 'string' || !id || doc.blocks.has(id)) return false;
  const parent = typeof left === 'string' && doc.blocks.has(left) ? left : '';
  const block = {
    id,
    left: parent,
    type: normalizeType(type),
    nodes: new Map(),
    kids: new Map([['', []]]),
  };
  doc.blocks.set(id, block);
  addSorted(doc.blockKids, parent, id);
  return true;
}

// A preorder walk is the document: a block's own inserts come before anything
// typed into the blocks that were opened after it.
function walkBlocks(doc, parent, out, liveOnly) {
  for (const id of doc.blockKids.get(parent) || []) {
    const block = doc.blocks.get(id);
    if (!block) continue;
    if (!liveOnly || !doc.blockDeleted.has(id)) out.push(id);
    walkBlocks(doc, id, out, liveOnly);
  }
}

export function blockOrder(doc, { deleted = false } = {}) {
  const out = [];
  walkBlocks(doc, '', out, !deleted);
  return out;
}

export function charOrder(block) {
  const out = [];
  const walk = (parent) => {
    for (const id of block.kids.get(parent) || []) {
      const node = block.nodes.get(id);
      if (!node) continue;
      if (!node.deleted) out.push(node);
      // Children of a deleted character stay: the text typed after it belongs
      // where the deleted character sat.
      walk(id);
    }
  };
  walk('');
  return out;
}

export function blockText(block) {
  if (!block) return '';
  return charOrder(block)
    .map((node) => node.ch)
    .join('');
}

export function docText(doc) {
  return blockOrder(doc)
    .map((id) => blockText(doc.blocks.get(id)))
    .join('\n');
}

// Consecutive characters that share a face. The editor paints one span per run.
export function runsOf(block) {
  const out = [];
  for (const node of charOrder(block)) {
    const last = out[out.length - 1];
    if (last && last.marks === node.marks) last.text += node.ch;
    else out.push({ text: node.ch, marks: node.marks });
  }
  return out;
}

export function charCount(doc) {
  let count = 0;
  for (const block of doc.blocks.values()) {
    for (const node of block.nodes.values()) if (!node.deleted) count += 1;
  }
  return count;
}

export function addBlock(doc, left, type) {
  const id = nextId(doc);
  const parent = left && doc.blocks.has(left) ? left : '';
  placeBlock(doc, id, parent, type);
  return { id, op: { op: 'badd', b: id, l: parent, t: normalizeType(type) } };
}

// An empty note still needs one block with a caret target.
export function ensureBlock(doc) {
  const order = blockOrder(doc);
  if (order.length) return order[0];
  return addBlock(doc, '', 'p').id;
}

export function insertText(doc, blockId, index, text, marks) {
  const block = doc.blocks.get(blockId);
  const value = String(text || '');
  if (!block || !value) return [];
  const live = charOrder(block);
  const at = Math.max(0, Math.min(Number(index) || 0, live.length));
  let parent = at > 0 ? live[at - 1].id : '';
  const face = markString(marks);
  const ops = [];
  for (const ch of value) {
    const id = nextId(doc);
    const node = { id, ch, parent, marks: face, deleted: false };
    block.nodes.set(id, node);
    addSorted(block.kids, parent, id);
    ops.push({ op: 'ins', b: blockId, i: id, p: parent, c: ch, m: face });
    parent = id;
  }
  return ops;
}

export function deleteText(doc, blockId, index, count) {
  const block = doc.blocks.get(blockId);
  if (!block) return [];
  const live = charOrder(block);
  const from = Math.max(0, Math.min(Number(index) || 0, live.length));
  const to = Math.min(from + Math.max(0, Number(count) || 0), live.length);
  const ops = [];
  for (let k = from; k < to; k += 1) {
    const node = live[k];
    if (node.deleted) continue;
    node.deleted = true;
    ops.push({ op: 'del', b: blockId, i: node.id });
  }
  return ops;
}

export function setMarkIds(doc, blockId, ids, mark, on) {
  const block = doc.blocks.get(blockId);
  if (!block || !MARK_SET.has(mark) || !Array.isArray(ids) || !ids.length) return null;
  const changed = [];
  for (const id of ids) {
    const node = block.nodes.get(id);
    if (!node || node.deleted) continue;
    const set = markSet(node.marks);
    if (on ? set.has(mark) : !set.has(mark)) continue;
    if (on) set.add(mark);
    else set.delete(mark);
    node.marks = markString(set);
    changed.push(id);
  }
  if (!changed.length) return null;
  return { op: 'fmt', b: blockId, m: mark, on: Boolean(on), ids: changed };
}

export function setBlockType(doc, blockId, type) {
  const block = doc.blocks.get(blockId);
  const next = normalizeType(type);
  if (!block || block.type === next) return null;
  block.type = next;
  return { op: 'btype', b: blockId, t: next };
}

export function deleteBlock(doc, blockId) {
  const block = doc.blocks.get(blockId);
  if (!block || doc.blockDeleted.has(blockId)) return null;
  doc.blockDeleted.add(blockId);
  return { op: 'bdel', b: blockId };
}

// ---------------------------------------------------------------------------
// Remote

export function apply(doc, op) {
  const touched = new Set();
  if (!op || typeof op !== 'object') return touched;
  switch (op.op) {
    case 'badd':
      if (placeBlock(doc, op.b, op.l, op.t)) touched.add(op.b);
      break;
    case 'btype': {
      const block = doc.blocks.get(op.b);
      if (block) {
        const next = normalizeType(op.t);
        if (block.type !== next) {
          block.type = next;
          touched.add(op.b);
        }
      }
      break;
    }
    case 'bdel': {
      const block = doc.blocks.get(op.b);
      if (block && !doc.blockDeleted.has(op.b)) {
        doc.blockDeleted.add(op.b);
        touched.add(op.b);
      }
      break;
    }
    case 'ins': {
      const block = doc.blocks.get(op.b);
      if (!block || block.nodes.has(op.i)) break;
      // Keep the named parent even when it has not arrived yet. The character
      // joins the page once its parent lands, and never at the wrong end.
      const parent = typeof op.p === 'string' ? op.p : '';
      const ch = String(op.c || '').slice(0, 1);
      if (!ch) break;
      block.nodes.set(op.i, {
        id: op.i,
        ch,
        parent,
        marks: markString(op.m),
        deleted: false,
      });
      addSorted(block.kids, parent, op.i);
      touched.add(op.b);
      break;
    }
    case 'del': {
      const block = doc.blocks.get(op.b);
      const node = block && block.nodes.get(op.i);
      if (node && !node.deleted) {
        node.deleted = true;
        touched.add(op.b);
      }
      break;
    }
    case 'fmt': {
      const block = doc.blocks.get(op.b);
      if (!block || !MARK_SET.has(op.m)) break;
      for (const id of op.ids || []) {
        const node = block.nodes.get(id);
        if (!node || node.deleted) continue;
        const set = markSet(node.marks);
        if (op.on ? set.has(op.m) : !set.has(op.m)) continue;
        if (op.on) set.add(op.m);
        else set.delete(op.m);
        node.marks = markString(set);
        touched.add(op.b);
      }
      break;
    }
    default:
      break;
  }
  return touched;
}

// ---------------------------------------------------------------------------
// Save and catch up

// Every block, its tombstones and its dead marks travel, so a late reader can
// place a character that refers to something it never saw.
export function snapshot(doc) {
  const blocks = [];
  for (const id of blockOrder(doc, { deleted: true })) {
    const block = doc.blocks.get(id);
    if (!block) continue;
    const chars = [];
    const walk = (parent) => {
      for (const child of block.kids.get(parent) || []) {
        const node = block.nodes.get(child);
        if (!node) continue;
        chars.push([node.id, node.parent, node.ch, node.marks, node.deleted ? 0 : 1]);
        walk(child);
      }
    };
    walk('');
    const row = { id: block.id, l: block.left, t: block.type, c: chars };
    if (doc.blockDeleted.has(id)) row.d = 1;
    blocks.push(row);
  }
  return { v: 1, blocks };
}

export function restore(state, site) {
  const doc = createDoc(site);
  const rows = state && Array.isArray(state.blocks) ? state.blocks : [];
  // A page that restores its own ids must keep its counter above them, or the
  // next character reuses an id and the text doubles.
  const own = (id) => {
    const cut = String(id || '').indexOf(':');
    if (cut < 0 || id.slice(0, cut) !== doc.site) return 0;
    return parseInt(id.slice(cut + 1), 36) || 0;
  };
  let high = 0;
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !row.id) continue;
    high = Math.max(high, own(row.id));
    placeBlock(doc, row.id, row.l, row.t);
  }
  for (const row of rows) {
    const block = doc.blocks.get(row.id);
    if (!block) continue;
    for (const part of row.c || []) {
      if (!Array.isArray(part) || typeof part[0] !== 'string' || !part[0]) continue;
      high = Math.max(high, own(part[0]));
      const [id, parent, ch, marks, live] = part;
      if (block.nodes.has(id)) continue;
      block.nodes.set(id, {
        id,
        ch: String(ch || '').slice(0, 1),
        parent: typeof parent === 'string' ? parent : '',
        marks: markString(marks),
        deleted: live === 0,
      });
    }
    for (const part of row.c || []) {
      const node = block.nodes.get(part[0]);
      if (!node) continue;
      addSorted(block.kids, node.parent, node.id);
    }
    if (row.d === 1) doc.blockDeleted.add(row.id);
    if (typeof row.t === 'string') block.type = normalizeType(row.t);
  }
  doc.clock = high;
  return doc;
}

// Cursor sets: one pointer per Windows role, a room frame that stays small,
// and the follower element a moving pointer needs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanCursor,
  cleanCursorStates,
  cursorNeedsFollower,
  cursorRole,
  restoreCursor,
} from '../cursor.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const still = (name) => ({ name, src: 'data:image/png;base64,AAAA', w: 32, h: 32 });

test('every Windows pointer role maps to a room role', () => {
  const roles = {
    'Normal Select': 'default',
    'Help Select': 'help',
    'Working in Background': 'progress',
    Busy: 'wait',
    'Precision Select': 'crosshair',
    'Text Select': 'text',
    Handwriting: 'text',
    Unavailable: 'not-allowed',
    'Vertical Resize': 'ns-resize',
    'Horizontal Resize': 'ew-resize',
    'Diagonal Resize 1': 'nwse-resize',
    'Diagonal Resize 2': 'nesw-resize',
    Move: 'move',
    'Alternate Select': 'default',
    'Link Select': 'pointer',
    'Scuba Cat Link Select': 'pointer',
    'rainbow-bongo-cat-busy': 'wait',
  };
  for (const [name, role] of Object.entries(roles)) assert.equal(cursorRole(name), role, name);
  assert.equal(cursorRole(''), 'default');
});

test('a set keeps one image per role and drops a state past the local budget', () => {
  const huge = 'A'.repeat(200001);
  const states = cleanCursorStates([
    still('Normal Select'),
    still('Arrow'),
    { ...still('Link Select'), src: `data:image/png;base64,${huge}` },
    still('Busy'),
    { name: 'Broken', src: 'https://example.com/cursor.png' },
  ]);
  assert.deepEqual(Object.keys(states).sort(), ['default', 'wait']);
  assert.equal(cleanCursorStates([]), null);
  assert.equal(cleanCursorStates(null), null);
});

test('a local state may be larger than a room frame', () => {
  const big = 'A'.repeat(15000);
  const states = cleanCursorStates([
    { ...still('Normal Select'), src: `data:image/webp;base64,${big}`, animated: true },
  ]);
  assert.equal(states.default.src.length, `data:image/webp;base64,${big}`.length);
  assert.equal(states.default.animated, true);
  assert.ok(cleanCursor({ ...still('Normal Select'), src: `data:image/webp;base64,${big}` }) === null);
});

test('the stored cursor keeps its states and the room frame does not', () => {
  const states = [still('Normal Select'), still('Link Select')];
  const saved = restoreCursor({ ...still('Normal Select'), states });
  assert.deepEqual(Object.keys(saved.states).sort(), ['default', 'pointer']);
  assert.equal(cleanCursor(saved).states, undefined);
  assert.equal(saved.w, 32);
});

test('a moving or multi-state pointer needs a follower element', () => {
  assert.equal(cursorNeedsFollower({ src: 'data:image/gif;base64,R0lGOD', w: 32 }), true);
  assert.equal(cursorNeedsFollower({ src: 'data:image/png;base64,AAAA', w: 32 }), false);
  const states = cleanCursorStates([still('Normal Select'), still('Busy')]);
  assert.equal(cursorNeedsFollower({ ...still('Normal Select'), states }), true);
  const moving = cleanCursorStates([{ ...still('Normal Select'), animated: true }]);
  assert.equal(cursorNeedsFollower({ ...still('Normal Select'), states: moving }), true);
  assert.equal(cursorNeedsFollower(null), false);
});

test('the page draws the set with a follower and the panel sends every state', () => {
  const entry = fs.readFileSync(path.join(root, 'browser-entry.mjs'), 'utf8');
  assert.match(entry, /data-brosr-own-cursor/);
  assert.match(entry, /cursor: none !important/);
  assert.match(entry, /document\.elementFromPoint/);
  assert.match(entry, /cleanCursorStates\(message\.cursor && message\.cursor\.states\)/);

  const panel = fs.readFileSync(path.join(root, '..', 'bridge', 'panel', 'room.js'), 'utf8');
  assert.match(panel, /async function useWholeSet/);
  assert.match(panel, /cursor: \{\s*\.\.\.base,[\s\S]{0,200}states:/);
});

// A real scuba cat page keeps one anchor around its default pointer. Before
// the CDN scan ran first, that single card closed the list at one and the
// other fourteen pointers never reached the panel.
test('one leftover anchor does not hide the rest of the set', () => {
  const panel = fs.readFileSync(path.join(root, '..', 'bridge', 'panel', 'room.js'), 'utf8');
  const grab = (name) => {
    const start = panel.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `missing ${name}`);
    let depth = 0;
    for (let i = panel.indexOf('{', start); i < panel.length; i += 1) {
      if (panel[i] === '{') depth += 1;
      else if (panel[i] === '}') {
        depth -= 1;
        if (!depth) return panel.slice(start, i + 1);
      }
    }
    assert.fail(`unclosed ${name}`);
  };
  const at = panel.indexOf('const CURSOR_PREVIEW');
  assert.ok(at >= 0, 'missing CURSOR_PREVIEW');
  const source = [
    panel.slice(at, panel.indexOf(';', at) + 1),
    grab('cursorSetSlug'),
    grab('cursorStateName'),
    grab('cursorCardsFrom'),
    'return cursorCardsFrom;',
  ].join('\n');
  const build = new Function(source)();
  const base = 'https://www.cursors-4u.com/cursor/scuba-cat-cursor-set';
  const roles = [
    'Scuba Cat',
    'Handwriting',
    'Move',
    'Alternate Select',
    'Precision Select',
    'Link Select',
    'Diagonal Resize 2',
    'Text Select',
    'Vertical Resize',
    'Horizontal Resize',
    'Busy',
    'Help Select',
    'Unavailable',
    'Diagonal Resize 1',
    'Working in Background',
  ];
  const images = roles.map((role, index) => ({
    src: `https://cdn.cursors-4u.net/previews/scuba-cat-cursor-set-scuba-cat-${index}.webp`,
    alt: index === 0 ? 'Scuba Cat Cursor' : role,
  }));
  // A nav tile names another set, and the slug keeps it out.
  images.push({
    src: 'https://cdn.cursors-4u.net/previews/chrome-glass-remastered-hd-animated-cursor-set-arr-1.webp',
    alt: 'Chrome Glass Remastered',
  });
  const anchors = [
    {
      href: 'https://www.cursors-4u.com/cursor/scuba-cat-normal-select',
      src: images[0].src,
      alt: 'Scuba Cat Cursor',
      title: '',
    },
  ];
  const cards = build(images, anchors, base);
  assert.equal(cards.length, 15);
  assert.deepEqual(cards.map((card) => card.name), roles);
  assert.equal(new Set(cards.map((card) => card.preview)).size, 15);
});

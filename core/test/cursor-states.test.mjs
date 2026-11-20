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

test('a set keeps one image per role and drops a state the room would refuse', () => {
  const huge = 'A'.repeat(15000);
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
  assert.match(panel, /cursor: \{\s*\.\.\.base,[\s\S]{0,80}states,/);
});

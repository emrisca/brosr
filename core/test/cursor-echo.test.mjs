// The room repeats this browser's cursor shape every two seconds. The echo was
// written in page scope and read the cursor that only start() holds, so the
// first hello threw a ReferenceError. start() stopped at that throw, before it
// registered the message listener and the media tick, so the room never named
// its film and no frame reached a peer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wireCursor } from '../browser-entry.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'browser-entry.mjs'), 'utf8');
const IMAGE = 'data:image/png;base64,iVBORw0KGgo=';

test('a room with no cursor echoes none', () => {
  assert.equal(wireCursor(null), null);
  assert.equal(wireCursor(undefined), null);
});

test('the echo carries the room shape and drops the states', () => {
  const cursor = {
    src: IMAGE,
    w: 32,
    h: 48,
    name: 'Ring',
    states: { default: { src: IMAGE, w: 32, h: 48 } },
  };
  assert.deepEqual(wireCursor(cursor), { src: IMAGE, w: 32, h: 48, name: 'Ring' });
});

test('the hello passes the cursor this tab holds to the echo', () => {
  assert.match(source, /wireCursor\(ownCursor\)/);
});

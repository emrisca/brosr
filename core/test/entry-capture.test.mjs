import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A grant arrives on the room socket after the page has loaded. A flag read
// from the URL at start time cannot turn input on later, so the entry installs
// the listeners for every room tab and the core gates each record on the grant.
const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'browser-entry.mjs'), 'utf8');

test('a room tab always installs input capture', () => {
  assert.match(source, /capture: true/);
  assert.doesNotMatch(source, /params\.get\('capture'\)/);
});

test('a grant is sent again once the socket is open', () => {
  // A grant frame sent before the socket opened went nowhere, and the peer then
  // never started capturing. The open handler has to send it again.
  assert.match(source, /socket\.onopen[\s\S]*?client\.setGrant\(input\.grantTo, true\)/);
});

test('a click flushes at once, so a link cannot unload the page first', () => {
  const sync = fs.readFileSync(path.join(here, '..', 'sync.mjs'), 'utf8');
  assert.match(sync, /batcher\.push\(\{[\s\S]*?kind: 'click'[\s\S]*?batcher\.flush\(\);/);
});

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

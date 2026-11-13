import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The page clock bug that cost a LAN hour: performance.now() starts at zero in
// each process, so the offset absorbed the page's own start time. A unit test
// cannot see a browser, so this reads the entry file instead.
const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'browser-entry.mjs'), 'utf8');

test('the page hands the room client wall time', () => {
  assert.match(source, /now: \(\) => Date\.now\(\)/);
  assert.match(source, /client\.receive\(event\.data, Date\.now\(\)\)/);
  assert.match(source, /client\.tick\(Date\.now\(\)\)/);
});

test('performance.now stays on the page timeline and never stamps a frame', () => {
  const uses = source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('performance.now()'))
    // A comment may name the call. Only code stamps a frame.
    .filter((line) => !line.startsWith('//') && !line.startsWith('*'));
  assert.ok(uses.length >= 2, 'the page should still time itself');
  for (const line of uses) {
    const ownTimeline = /performance\.now\(\) - started/.test(line);
    const ownStart = /^const started = performance\.now\(\);$/.test(line);
    assert.ok(ownTimeline || ownStart, `unexpected performance.now() use: ${line}`);
  }
});

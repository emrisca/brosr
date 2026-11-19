// The bridge package keeps its core file list by hand. A module left out of
// that list still imports on disk, so only the browser fails: the injected
// script stops at its import and the page ends up with no dataset and no
// socket. This test walks the imports of both shipped entry points and names
// every reachable module the package list omits. Host-only modules such as
// friends.mjs are not reachable from a browser entry, so they stay optional.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = path.join(here, '..');
const pack = path.join(core, '..', 'zen', 'package.mjs');
const ENTRY = ['browser-entry.mjs', 'panel.mjs'];

test('the bridge package ships every module its entries reach', () => {
  const source = fs.readFileSync(pack, 'utf8');
  const listed = new Set(
    [...source.matchAll(/'([\w-]+\.mjs)'/g)].map((hit) => hit[1])
  );

  const reached = new Set();
  const walk = (name) => {
    if (reached.has(name)) return;
    const file = path.join(core, name);
    if (!fs.existsSync(file)) return;
    reached.add(name);
    const text = fs.readFileSync(file, 'utf8');
    for (const hit of text.matchAll(/from\s+'\.\/([\w-]+\.mjs)'/g)) walk(hit[1]);
    for (const hit of text.matchAll(/import\s+'\.\/([\w-]+\.mjs)'/g)) walk(hit[1]);
  };
  for (const name of ENTRY) walk(name);

  const missing = [...reached].filter((name) => !listed.has(name));
  assert.deepEqual(
    missing,
    [],
    `zen/package.mjs does not list ${missing.join(', ')}, which ${ENTRY.join(' or ')} imports`
  );
});

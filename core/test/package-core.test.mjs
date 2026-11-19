// The bridge package builds its core file list from the imports, so the bundle
// has to hold every module the entries reach. This test walks those imports on
// its own and reads the files the builder would pack. A missing module only
// fails inside the browser: the injected core stops at its import, and the page
// ends up with no dataset and no socket.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { bridgeEntries } from '../../zen/package.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = path.join(here, '..');
const ENTRY = ['browser-entry.mjs', 'page-entry.mjs', 'panel.mjs'];

test('the bridge package holds every module its entries reach', () => {
  const packed = new Set(bridgeEntries().map((entry) => entry.name));
  const reached = new Set();
  const walk = (name) => {
    if (reached.has(name)) return;
    const file = path.join(core, name);
    if (!fs.existsSync(file)) return;
    reached.add(name);
    const source = fs.readFileSync(file, 'utf8');
    for (const hit of source.matchAll(/from\s+'\.\/([\w-]+\.mjs)'/g)) walk(hit[1]);
    for (const hit of source.matchAll(/import\s+'\.\/([\w-]+\.mjs)'/g)) walk(hit[1]);
  };
  for (const name of ENTRY) walk(name);

  const missing = [...reached].filter((name) => !packed.has(`core/${name}`));
  assert.deepEqual(
    missing,
    [],
    `the bridge omits ${missing.join(', ')}, which ${ENTRY.join(' or ')} imports`
  );
});

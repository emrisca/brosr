import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A peer that joins after a tab was shared never saw the frame that opened the
// copy, because the relay keeps no history. Every browser repeats the
// announcement for each new peer, and the room page asks for that replay on its
// own socket, so nobody has to share the tab again.
const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'browser-entry.mjs'), 'utf8');
const background = fs.readFileSync(
  path.join(here, '..', '..', 'bridge', 'background.js'),
  'utf8'
);

test('the greet asks for a tab replay when a new peer appears', () => {
  assert.match(
    source,
    /if \(fresh && api && api\.runtime && api\.runtime\.sendMessage\) \{\s*api\.runtime\.sendMessage\(\{ type: 'brosr:tabs-replay' \}\)/
  );
});

test('the ask runs for every role, and the anchor stays with the host', () => {
  // A granted guest shares tabs too, so a replay ask behind the host-only guard
  // would leave the host without the tab that guest shared before it joined.
  assert.match(
    source,
    /type: 'brosr:tabs-replay' \}\)[\s\S]{0,240}?if \(role !== 'host'\) return;/
  );
});

test('the replay is not gated on a film anchor', () => {
  // A browser that shared a plain tab has no media anchor, and the greet returns
  // before the anchor code. The replay ask sits above that return.
  const replay = source.indexOf("type: 'brosr:tabs-replay'");
  const anchor = source.indexOf('const anchor = relayedMedia.state()');
  assert.ok(replay > 0, 'the replay ask is missing');
  assert.ok(anchor > 0, 'the anchor read is missing');
  assert.ok(replay < anchor, 'the replay ask sits below the anchor early return');
});

test('the replay only sends tabs that already went out', () => {
  assert.match(background, /if \(message\.type === 'brosr:tabs-replay'\) \{/);
  assert.match(
    background,
    /if \(!\(await mayShare\(\)\)\) return \{ ok: false, reason: 'no-control' \}/
  );
  assert.match(background, /for \(const \[raw, url\] of announced\)/);
  assert.match(background, /if \(!tab \|\| tab\.url !== url \|\| !shareable\(tab\.url\)\) continue;/);
  assert.match(background, /await announce\(tab\.url, key\)/);
});

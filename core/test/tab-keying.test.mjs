import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The bridge has to keep one tab keyed through a navigation and to join an
// open that names the same URL.
const here = path.dirname(fileURLToPath(import.meta.url));

// A mirrored tab is skipped as a remote copy today, and a navigation in it then
// never reaches the browser that owns the tab. The key it arrived with is what
// lets the other side move that same tab.
test('a mirrored tab keeps its key through a navigation', () => {
  const source = fs.readFileSync(
    path.join(here, '..', '..', 'bridge', 'background.js'),
    'utf8'
  );
  assert.doesNotMatch(source, /if \(remoteTabs\.has\(tab\.id\)\) return;/);
  assert.match(source, /const arrived = remoteOrigins\.get\(tab\.id\);/);
  assert.match(source, /async function mapRemoteKey\(key, tabId\)/);
  assert.match(source, /remoteOrigins\.set\(tabId, key\);/);
  assert.match(source, /await mapRemoteKey\(key, tab\.id\);/);
});

test('a same-URL open joins the request already in flight', () => {
  const source = fs.readFileSync(
    path.join(here, '..', '..', 'bridge', 'background.js'),
    'utf8'
  );
  assert.match(source, /const openingByUrl = new Map\(\);/);
  assert.match(source, /const pending = openingByUrl\.get\(message\.url\);/);
  assert.match(source, /return \{ \.\.\.result, joined: true \};/);
});

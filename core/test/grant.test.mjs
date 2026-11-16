import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GrantBook } from '../input.mjs';
import { createRoomClient } from '../sync.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// A grant is for a browser, not for one tab or one origin. A granted peer can
// act in any tab it can see, including one it just opened.
test('a wildcard grant allows every tab and every origin', () => {
  const book = new GrantBook({ now: () => 0 });
  book.grant('peer', { tabId: '*', origin: '' });
  assert.equal(
    book.allows('peer', { tabId: 'host', origin: 'https://a.test', kind: 'click' }),
    true
  );
  assert.equal(
    book.allows('peer', { tabId: 'anything', origin: 'https://b.test', kind: 'text' }),
    true
  );
  assert.equal(
    book.allows('other', { tabId: 'host', origin: 'https://a.test', kind: 'click' }),
    false
  );
});

test('a host sends a browser-wide grant on the wire', () => {
  const sent = [];
  const host = createRoomClient({
    role: 'host',
    peerId: 'host',
    hostId: 'host',
    now: () => 0,
    overlay: false,
    send: (frame) => sent.push(JSON.parse(frame)),
  });
  host.setGrant('peer', true);
  const control = sent.find((message) => message.type === 'control');
  assert.equal(control.tabId, '*');
  assert.equal(control.origin, '');
});

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
  assert.match(source, /remoteOrigins\.set\(tab\.id, key\);/);
});

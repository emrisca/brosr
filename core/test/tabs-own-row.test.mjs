import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A shared tab leaves the browser that published it. The relay skips the
// sending socket, and the room page drops a frame that names this peer, so the
// offer never came back and the landing page had no row for a tab this browser
// was sharing. The room tab now writes the offer from the frame it sends.
const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'browser-entry.mjs'), 'utf8');
const landing = fs.readFileSync(path.join(here, '..', '..', 'landing', 'index.html'), 'utf8');

function announceBlock() {
  const start = source.indexOf("if (message.type === 'brosr:tabs-announce')");
  const end = source.indexOf("if (message.type === 'brosr:tabs-resumed')");
  assert.ok(start > 0, 'the announce handler is missing');
  assert.ok(end > start, 'the resume handler moved above the announce handler');
  return source.slice(start, end);
}

test('a published tab is written into the list of the browser that sent it', () => {
  const block = announceBlock();
  assert.match(block, /sharedTab\(data, \{ from: peerId, hostId \}\)/);
  assert.match(block, /sharedTabs = rememberSharedTab\(sharedTabs, offer\);/);
  assert.match(block, /publishSharedTabs\(\);/);
});

test('the local row is the offer that went out, not a second shape', () => {
  // The page decides a row is this browser's own by comparing the owner id, so
  // a local offer built without the sender id would draw an Open button.
  const block = announceBlock();
  assert.match(block, /client\.sendApp\(TAB_APP, data\);/);
  assert.match(block, /sharedTab\(data, \{/);
});

test('a media or close announcement keeps its action', () => {
  // The bridge sends a player state and a withdrawal through the same announce
  // message. Turning every one of them into an open sent an empty URL and the
  // receiver dropped it, so a row never said playing or paused and a closed
  // tab stayed listed.
  const block = announceBlock();
  assert.match(block, /ask !== 'open' && ask !== 'media' && ask !== 'close'/);
  assert.match(block, /const action = ask;/);
  assert.match(block, /if \(action === 'media'\) data\.playing = message\.playing === true;/);
  assert.doesNotMatch(block, /action: 'open',\n\s*url: String\(message\.url \|\| ''\),/);
});

test('an unknown announce action is refused, not turned into an open', () => {
  const block = announceBlock();
  assert.match(block, /ask !== 'open' && ask !== 'media' && ask !== 'close'/);
  assert.match(block, /reason: 'action'/);
});

test('the first offer keeps the playback state the row shows', () => {
  // A film tab is shared with its state. Dropping it here would leave the
  // publisher row without the badge every other row has.
  const block = announceBlock();
  assert.match(block, /if \(typeof message\.playing === 'boolean'\) data\.playing = message\.playing;/);
});

test('a close drops this browser own row only', () => {
  // Tab ids are per publisher, so two people can share a tab with the same id.
  // A withdrawal from this browser must not take the other person row with it.
  const block = announceBlock();
  assert.match(block, /entry\.ownerId === peerId/);
  assert.match(block, /sharedTabs = sharedTabs\.filter/);
});

test('the landing page draws a Sharing row for a tab this browser published', () => {
  assert.match(landing, /textContent = 'Sharing';/);
});

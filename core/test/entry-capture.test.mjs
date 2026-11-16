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

test('your own cursor is a switch beside sharing it', () => {
  // Sharing sends the pointer to the room. Showing it is a separate choice, so
  // either one can be off while the other stays on.
  assert.match(source, /let showOwnCursor = readSetting\('brosr-show-own-cursor'\) !== '0'/);
  assert.match(source, /applyOwnCursor\(showOwnCursor \? ownCursor : null\)/);
  assert.match(source, /cursor: showOwnCursor \? ownCursor : null/);
  assert.match(source, /if \(showOwnCursor && api && api\.runtime && api\.runtime\.sendMessage\)/);
});

test('a granted peer sends an act and not its own clock', () => {
  // A peer's own sample inside the anchor window pulled the host playhead back
  // and beat the host's play and pause. Only a real act crosses the room.
  assert.match(source, /if \(!state\.action\) return reply\(\{ ok: true, skipped: 'tick' \}\)/);
  assert.match(source, /Date\.now\(\) - remoteAppliedAt < 600/);
  // The echo window opens on an act, not on a tick. A tick lands four times a
  // second, so refreshing the window on every apply kept a granted peer's own
  // pause and seek home while the host's play ran on.
  assert.match(source, /message\.action \|\| corrected/);
  // A correction seek issues a seek of its own, and that seek would arrive at
  // the host as a person's act. It opens the window too.
  assert.match(source, /result\.action === 'seek' \|\| result\.action === 'seek-retry'/);
});

test('the active tab names the site a pointer belongs to', () => {
  // The room tab holds the socket and used to name its own relay page, so a
  // film tab was never attributed and a site toggle did nothing.
  assert.match(source, /message\.type === 'brosr:active-page'/);
  const background = fs.readFileSync(
    path.join(here, '..', '..', 'bridge', 'background.js'),
    'utf8'
  );
  assert.match(background, /type: 'brosr:active-page', url/);
});

test('an animated cursor keeps its frames', () => {
  // A canvas keeps the first frame of an animation, so an animated pick used
  // to arrive as a still pointer.
  const panel = fs.readFileSync(
    path.join(here, '..', '..', 'bridge', 'panel', 'room.js'),
    'utf8'
  );
  assert.match(panel, /readAsDataURL/);
  assert.match(panel, /CURSOR_MAX_DATA/);
  // A closed ImageBitmap reports a zero width, so the size has to be read
  // before the close or a 96 px cursor arrives as a 32 px one.
  const sized = panel.slice(panel.indexOf('const width ='));
  assert.ok(panel.indexOf('const width =') < panel.indexOf('bitmap.close?.()'));
  assert.match(sized, /bitmap\.width/);
  assert.match(sized, /Math\.min\(96/);
});

test('the first site toggle keeps the other sites on', () => {
  // A room with no policy allows every site. Basing the first click on the two
  // app defaults turned every other site off, so a site could not be allowed
  // on its own.
  assert.match(source, /Array\.isArray\(published\.cursorSites\)/);
  assert.match(source, /published\.cursorSeen \|\| \[\]/);
});

test('a click flushes at once, so a link cannot unload the page first', () => {
  const sync = fs.readFileSync(path.join(here, '..', 'sync.mjs'), 'utf8');
  assert.match(sync, /batcher\.push\(\{[\s\S]*?kind: 'click'[\s\S]*?batcher\.flush\(\);/);
});

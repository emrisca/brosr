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
  // The echo window opens on an act, not on a tick. A host pause also carries
  // action: "tick", so the label cannot decide it. A changed playing flag is
  // the act; a routine sample leaves the flag alone and must not keep a granted
  // peer's own pause home.
  assert.match(source, /previous\.playing !== Boolean\(message\.playing\)/);
  assert.match(source, /playingChanged \|\| corrected/);
  assert.doesNotMatch(source, /message\.action \|\| corrected/);
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

test('the host room tab reads its own film without the page helper', () => {
  // pageHref() lives inside startPageMedia. The room tab tick called it from
  // start(), so every pass threw a ReferenceError and a host that played the
  // film in the room tab never sent its state to the room.
  const tick = source.slice(source.indexOf('A host that plays the film in the room tab'));
  const body = tick.slice(0, tick.indexOf('}, 500);'));
  assert.match(body, /mediaStateFromDocument\(document, location\.href, location\.hostname\)/);
  assert.doesNotMatch(body, /pageHref\(\)/);
});

test('a host greets a guest that joins a paused room', () => {
  // The host sent its anchor only when the state changed. A guest that joined a
  // paused room received no frame at all, so its film tab applied nothing and
  // the film never started there.
  const greet = source.slice(source.indexOf('const greeted = new Set()'));
  const body = greet.slice(0, greet.indexOf('}, 500);'));
  assert.match(body, /relayedMedia\.state\(\)/);
  assert.match(
    body,
    /client\.sendHostMedia\(\{ \.\.\.relayedMedia\.latest, \.\.\.anchor, at: Date\.now\(\) \}\)/,
    'the projected anchor is sent as it stands'
  );
  assert.match(body, /greeted\.delete\(id\)/, 'a rejoin is greeted again');
  // A guest usually opens the room first, so the greet can arrive before its
  // film tab exists. The refresh covers a film that opens after the join.
  assert.match(body, /Date\.now\(\) - greetedAt < 2000/);
});

test('a click flushes at once, so a link cannot unload the page first', () => {
  const sync = fs.readFileSync(path.join(here, '..', 'sync.mjs'), 'utf8');
  assert.match(sync, /batcher\.push\(\{[\s\S]*?kind: 'click'[\s\S]*?batcher\.flush\(\);/);
});

test('a film report refreshes presence while its room tab is hidden', () => {
  // The room tab sits behind the film tab, so the browser throttles its
  // presence timer. The guest pruned a live host after fifteen seconds and
  // elected itself. A valid film report has to keep this peer alive too.
  const media = source.slice(source.indexOf("if (message.type === 'brosr:media-state')"));
  const body = media.slice(0, media.indexOf("if (client.stats.role === 'host')"));
  assert.match(
    body,
    /state && typeof state === 'object' && state\.key\)[\s\S]*?client\.presence\(\)/
  );
});

test('a film report names the instant its position was read', () => {
  // The room sends a report a moment after the tab reads it. A report with no
  // read time makes the room stamp the send, and every guest then extrapolates
  // from an instant later than the position it was given. On a hidden tab the
  // gap is a whole throttled tick.
  const report = source.slice(source.indexOf('function reportMedia('));
  const body = report.slice(0, report.indexOf('setInterval(reportMedia'));
  assert.match(body, /state\.at = Date\.now\(\)/);
});

test('a room frame keeps the anchor instant it arrived with', () => {
  // The expected position was worked out at that instant. A fresh stamp at the
  // handoff shortens the age the film tab adds, so the playhead lands short.
  const media = source.slice(source.indexOf('onMedia: (message) =>'));
  const body = media.slice(0, media.indexOf('input: {'));
  assert.match(body, /const at = Number\(message\.at\) \|\| Date\.now\(\)/);
  assert.doesNotMatch(body, /at: Date\.now\(\)/);
});

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

test('a published tab withdraws its offer when it closes, a copy only leaves', () => {
  assert.match(background, /const shared = announced\.has\(id\) && remoteKey === undefined;/);
  assert.match(background, /if \(remoteKey !== undefined && !shared && !remotelyClosed\) \{/);
  assert.match(background, /notifyLeft\(remoteKey\)/);
  assert.match(background, /if \(shared && !remotelyClosed\)/);
  assert.match(background, /announceClose\(key\)/);
  assert.match(background, /if \(message\.type === 'brosr:tab-close-local'\)/);
});

test('a received tab is an offer that only a click can open', () => {
  // The old path opened a copy as soon as the frame arrived. Nothing opens
  // now until the landing page sends the key the reader clicked.
  assert.match(source, /sharedTabs = rememberSharedTab\(sharedTabs, offer\);/);
  assert.match(source, /if \(!joinedTabs\.has\(offer\.key\)\) return;/);
  assert.match(source, /if \(message\.type === 'join-tab'\)/);
  assert.doesNotMatch(source, /tabOpen\(message\.data\)/);
});

test('the replay only sends tabs that already went out', () => {
  assert.match(background, /if \(message\.type === 'brosr:tabs-replay'\) \{/);
  assert.match(
    background,
    /if \(!\(await mayShare\(\)\)\) return \{ ok: false, reason: 'no-control' \}/
  );
  assert.match(background, /for \(const \[raw, url\] of announced\)/);
  // A copy this browser opened is not one of this person's offers.
  assert.match(background, /if \(remoteOrigins\.has\(id\)\) continue;/);
  assert.match(background, /if \(!tab \|\| tab\.url !== url \|\| !shareable\(tab\.url\)\) continue;/);
  assert.match(background, /await announce\(tab\.url, id, tab\.title, mediaTabs\.get\(id\)\)/);
});

test('a hello asks for the replay at once, not only on the greet timer', () => {
  // A hidden room tab throttles its timer to about once a minute, and the host
  // tab usually sits behind the page someone reads. A guest that joined then
  // waited that long, because the timer was the only ask.
  assert.match(source, /if \(kind === 'hello'\) replayTabsSoon\(\);/);
  assert.match(source, /const replayTabsSoon = \(\) => \{/);
  assert.match(
    source,
    /api\.runtime\.sendMessage\(\{ type: 'brosr:tabs-replay' \}\)\.catch/
  );
  // The coalescing window is a clock comparison, not a timer, because the
  // hidden tab holds the same timers back.
  const ask = source.slice(
    source.indexOf('const replayTabsSoon'),
    source.indexOf('const connect =')
  );
  assert.doesNotMatch(ask, /setTimeout/);
});

test('a tab this browser owns is not recorded as a copy', () => {
  // Writing a local offer into the remote book made the offer look like a copy,
  // so a replay skipped it and closing it reported a peer leaving instead of
  // withdrawing the offer.
  assert.match(
    background,
    /if \(arrived !== undefined && arrived !== null\) await mapRemoteKey\(key, tab\.id\);/
  );
});

test('a room that starts after tabs were opened offers them', () => {
  // A tab was offered only when it loaded, and a tab that was already open
  // never loads again, so a room started later announced nothing.
  assert.match(background, /if \(roomRole === 'host'\) sweepTabs\(\)\.catch/);
  assert.match(background, /if \(!before && prefs\.granted\) sweepTabs\(\)\.catch/);
  assert.match(background, /async function sweepTabs\(\) \{/);
});

test('replayed clicks and remote tab updates never auto-open new tabs on another peer', () => {
  // Tabs never relay open: browser-entry must not pass an openTab callback to
  // createRoomClient, remote TAB_APP follow updates must pass updateOnly: true,
  // and background.js must refuse to call api.tabs.create when updateOnly is set.
  assert.doesNotMatch(source, /openTab\s*:/, 'browser-entry must not wire an openTab relay hook');
  const joinedFollow = source.slice(
    source.indexOf('if (!joinedTabs.has(offer.key)) return;'),
    source.indexOf('if (!joinedTabs.has(offer.key)) return;') + 320
  );
  assert.match(joinedFollow, /updateOnly:\s*true/);
  assert.match(background, /const updateOnly = message\.updateOnly === true;/);
  assert.match(background, /if \(updateOnly\)\s*\{\s*return \{ ok: false, reason: 'no-copy' \};\s*\}/);
});

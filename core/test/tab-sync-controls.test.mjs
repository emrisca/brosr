import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A row is a choice, and a stop is a choice too. Joining a row must bring the
// copy forward, and stopping it must leave the tab open. Both rules cross the
// page, the core and the background, so this test reads the three files that
// carry them.
const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'browser-entry.mjs'), 'utf8');
const background = fs.readFileSync(
  path.join(here, '..', '..', 'bridge', 'background.js'),
  'utf8'
);
const page = fs.readFileSync(path.join(here, '..', '..', 'landing', 'index.html'), 'utf8');
const ui = fs.readFileSync(
  path.join(here, '..', '..', 'bridge', 'panel', 'room.js'),
  'utf8'
);
const panel = fs.readFileSync(
  path.join(here, '..', '..', 'bridge', 'panel', 'room.html'),
  'utf8'
);

test('a click on a row asks for the copy in front', () => {
  // A copy that opens behind the room tab looks like nothing happened.
  assert.match(source, /type: 'brosr:tab-open-local',[\s\S]{0,160}?foreground: true,/);
  assert.match(background, /const foreground = message\.foreground === true;/);
  assert.match(background, /api\.tabs\.create\(\{ url: message\.url, active: foreground \}\)/);
  assert.match(background, /api\.tabs\.update\(known, \{ active: true \}\)/);
});

test('a stop detaches the copy and leaves the tab open', () => {
  const start = background.indexOf("if (message.type === 'brosr:tab-leave-local')");
  assert.ok(start > 0, 'the leave handler is missing');
  const end = background.indexOf("if (message.type === 'brosr:tab-close-local')", start);
  assert.ok(end > start, 'the leave handler has no end');
  const leave = background.slice(start, end);
  assert.match(leave, /remoteKeys\.delete\(key\)/);
  assert.match(leave, /remoteOrigins\.delete\(id\)/);
  assert.match(leave, /detachedTabs\.add\(id\)/);
  assert.match(leave, /mediaTabs\.delete\(id\)/);
  // Closing is the other control, and this path must not reach for it.
  assert.doesNotMatch(leave, /tabs\.remove/);
  assert.doesNotMatch(leave, /tab-close-local/);
  // A detached copy stays private after a navigation.
  assert.match(background, /if \(detachedTabs\.has\(tab\.id\)\) return;/);
  assert.match(background, /if \(detachedTabs\.has\(from\)\) return \{ ok: false, reason: 'detached' \}/);
});

test('the page asks to stop and the core drops the key', () => {
  assert.match(page, /type: 'leave-tab', key: key/);
  assert.match(page, /stopTab\(tab\.key\)/);
  const start = source.indexOf("if (message.type === 'leave-tab')");
  assert.ok(start > 0, 'the leave branch is missing');
  const end = source.indexOf("if (message.type !== 'send') return;", start);
  const leave = source.slice(start, end);
  assert.match(leave, /joinedTabs\.delete\(key\)/);
  assert.match(leave, /type: 'brosr:tab-leave-local', key/);
  assert.doesNotMatch(leave, /tab-close-local/);
});

test('a stopped copy comes back from the panel', () => {
  // The panel lists a stopped copy and offers one button to put it back.
  assert.match(panel, /id="stopped-section"/);
  assert.match(panel, /id="stopped-list"/);
  // The header carries the count, so the Cursor pane shows it too.
  assert.match(panel, /id="stopped-count"/);
  assert.match(ui, /\$\('stopped-count'\)/);
  assert.match(ui, /badge\.hidden = !stopped\.length/);
  assert.match(ui, /type: 'brosr:tab-resume', key: entry\.key/);
  assert.match(ui, /className = 'tab-resume'/);
  // The background takes the key back and tells the room tab to follow it.
  assert.match(background, /remoteKeys\.set\(key, entry\.tabId\)/);
  assert.match(background, /type: 'brosr:tabs-resumed', key/);
  // The room tab rejoins the offer and points the same tab at it.
  assert.match(source, /if \(message\.type === 'brosr:tabs-resumed'\)/);
  assert.match(source, /joinedTabs\.add\(key\)/);
  assert.match(source, /foreground: false,/);
});

test('a playback report updates an offer in place', () => {
  // The row says playing or paused without re-sending the URL.
  assert.match(background, /action: 'media',/);
  assert.match(background, /playing: next,/);
  assert.match(background, /if \(publishedPlaying\.get\(id\) === next\) return false;/);
  assert.match(background, /if \(announced\.has\(from\)\) \{/);
  assert.match(source, /const media = tabMedia\(message\.data\);/);
  assert.match(source, /sharedTabs = noteSharedMedia\(sharedTabs, media\);/);
  assert.match(page, /tab\.playing \? 'Playing' : 'Paused'/);
});

test('Live Tabs provides inline controller media controls, focus jump, and live title updates without forcing opens', () => {
  const css = fs.readFileSync(path.join(here, '..', '..', 'landing', 'landing.css'), 'utf8');
  // Wider landing real estate while keeping monochrome tokens
  assert.match(css, /\.page\s*\{[\s\S]*?max-width:\s*1760px/);
  assert.match(css, /\.live-media-controls\s*\{/);
  // Landing page inline controls + Focus button, guarded by event.isTrusted
  assert.match(page, /type:\s*'tab-media-control'/);
  assert.match(page, /type:\s*'focus-tab'/);
  assert.match(page, /controlMedia\(tab\.key,\s*'skip',\s*-10\)/);
  assert.match(page, /controlMedia\(tab\.key,\s*'toggle',\s*0\)/);
  assert.match(page, /controlMedia\(tab\.key,\s*'skip',\s*10\)/);
  // Transport is open to every peer that holds the tab, so the row does not
  // gate its controls on a role.
  assert.match(source, /canControl:\s*true,/);
  assert.match(source, /if \(message\.type === 'tab-media-control'\)/);
  assert.match(source, /tabMediaControlDecision\(\{/);
  assert.match(source, /if \(message\.type === 'brosr:media-control'\)/);
  // Background handles focus, media-control, and live title refreshes without creating new tabs
  const focusStart = background.indexOf("if (message.type === 'brosr:tab-focus')");
  const stateStart = background.indexOf("if (message.type === 'brosr:tab-media-state')", focusStart);
  assert.ok(focusStart > 0 && stateStart > focusStart);
  const block = background.slice(focusStart, stateStart);
  assert.match(block, /brosr:tab-media-control/);
  assert.match(block, /brosr:media-control/);
  assert.doesNotMatch(block, /tabs\.create/);
  assert.match(background, /announcedTitles\.set\(id,\s*info\.title\)/);
});

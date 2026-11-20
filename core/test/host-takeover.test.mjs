import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The relay names a host by the role its socket joined with, and a room whose
// host page closed keeps its peers and its relay. The landing page therefore
// offers the host role as a navigation and never claims the role itself. Any
// peer holding the room link could already open it with role=host, so the offer
// reads a state that already existed instead of granting a new one.
const here = path.dirname(fileURLToPath(import.meta.url));
const landing = fs.readFileSync(path.join(here, '..', '..', 'landing', 'index.html'), 'utf8');
const styles = fs.readFileSync(
  path.join(here, '..', '..', 'landing', 'landing.css'),
  'utf8'
);
const entry = fs.readFileSync(path.join(here, '..', 'browser-entry.mjs'), 'utf8');

function slice(startText, endText) {
  const start = landing.indexOf(startText);
  const end = landing.indexOf(endText, start + 1);
  assert.ok(start > 0, `the block starting with ${startText} is missing`);
  assert.ok(end > start, `the block starting with ${startText} has no end marker`);
  return landing.slice(start, end);
}

function gateBlock() {
  return slice(
    "var takeover = document.getElementById('host-takeover');",
    'function read()'
  );
}

function clickBlock() {
  return slice("takeover.addEventListener('click'", 'read();\n      setInterval(read, 5000);');
}

test('the room bar carries one takeover control that starts hidden', () => {
  assert.match(landing, /class="room-bar"/);
  assert.match(landing, /id="host-takeover" type="button" hidden/);
  assert.match(styles, /\.room-takeover\[hidden\] \{\n  display: none;/);
});

test('a host and a page with no room are never offered the role', () => {
  const block = gateBlock();
  assert.match(block, /var takeoverOffered = params\.has\('room'\) && params\.get\('role'\) !== 'host';/);
});

test('the offer appears only on a measured room with no host', () => {
  // A relay that sends no host count made no measurement. Missing must not
  // read as zero, or an older relay would accuse the host of leaving.
  const block = gateBlock();
  assert.match(
    block,
    /takeover\.hidden = !\(takeoverOffered && peers !== null && hosts === 0\);/
  );
});

test('the takeover navigates with both the host role and the host id', () => {
  // The core falls back to the id "host" for a host socket, and the relay
  // names the host by that id. One without the other joins as a second peer
  // and the room still reports no host.
  const block = clickBlock();
  assert.match(block, /next\.set\('role', 'host'\)/);
  assert.match(block, /next\.set\('peer', 'host'\)/);
});

test('a grant does not follow the tab into the host role', () => {
  const block = clickBlock();
  assert.match(block, /next\.delete\('grant'\)/);
});

test('the room, the name and the key survive the takeover', () => {
  // The rewrite reads the current search, so it keeps every other param, and
  // the fragment holds the sealed key.
  const block = clickBlock();
  assert.match(block, /var next = new URLSearchParams\(location\.search\);/);
  assert.match(block, /location\.replace\(location\.pathname \+ '\?' \+ next\.toString\(\) \+ location\.hash\)/);
});

test('the core reads the pair the takeover writes', () => {
  assert.match(
    entry,
    /peerId: params\.get\('peer'\) \|\| \(params\.get\('role'\) === 'host' \? 'host' : 'peer'\),/
  );
  assert.match(entry, /role: params\.get\('role'\) === 'host' \? 'host' : 'peer',/);
});

test('the takeover control sits beside the pill and can shrink the pill', () => {
  assert.match(styles, /\.room-bar \{\n  display: flex;/);
  assert.match(styles, /\.room-bar \{[^}]*min-width: 0;/s);
  assert.match(styles, /\.room-takeover \{[^}]*flex: none;/s);
  assert.match(styles, /\.room-takeover:focus-visible \{\n  outline: 2px solid var\(--ring\);/);
});

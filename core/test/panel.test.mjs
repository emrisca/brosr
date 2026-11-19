import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePanelArgs } from '../panel.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('the app field names parse into one panel request', () => {
  assert.deepEqual(
    parsePanelArgs(['--action=grant', '--peerId=guest-1', '--allowed=true']),
    { action: 'grant', values: { peerId: 'guest-1', allowed: true }, guest: false }
  );
  assert.deepEqual(
    parsePanelArgs(['--action=tab', '--tabId=42', '--shared=false']),
    { action: 'tab', values: { tabId: 42, shared: false }, guest: false }
  );
  assert.deepEqual(
    parsePanelArgs(['--action=scroll-site', '--site=https://example.com/watch', '--on=false']),
    {
      action: 'scroll-site',
      values: { site: 'https://example.com/watch', on: false },
      guest: false,
    }
  );
});

test('the old short names still normalize to the same fields', () => {
  assert.deepEqual(
    parsePanelArgs(['--action=grant', '--peer=guest-1', '--allow=false']).values,
    { peerId: 'guest-1', allowed: false }
  );
  assert.deepEqual(
    parsePanelArgs(['--action=tab', '--tab=7', '--shared=true']).values,
    { tabId: 7, shared: true }
  );
});

test('an unknown field or action is refused instead of ignored', () => {
  assert.throws(
    () => parsePanelArgs(['--action=grant', '--peerId=guest-1', '--allowed=true', '--colour=red']),
    /unknown panel field/
  );
  assert.throws(() => parsePanelArgs(['--action=shrug']), /unknown panel action/);
  assert.throws(
    () => parsePanelArgs(['--action=status', '--peerId=guest-1']),
    /not used by the status action/
  );
});

test('a required field is named in the error', () => {
  assert.throws(
    () => parsePanelArgs(['--action=grant', '--peerId=guest-1']),
    /needs --allowed/
  );
  assert.throws(() => parsePanelArgs(['--action=tab', '--tabId=4']), /needs --shared/);
  assert.throws(
    () => parsePanelArgs(['--action=tab', '--tabId=4.5', '--shared=true']),
    /whole tab number/
  );
});

test('the panel draws the room before it reads the film', () => {
  const source = fs.readFileSync(path.join(here, '..', '..', 'bridge', 'panel', 'room.js'), 'utf8');
  const firstRender = source.indexOf('render(reply);');
  const firstRead = source.indexOf('await readFilm(reply);');
  assert.ok(firstRender >= 0, 'the panel render call exists');
  assert.ok(firstRead >= 0, 'the film read call exists');
  assert.ok(firstRender < firstRead, 'the room render comes before the optional film read');
  assert.match(source, /function withDeadline/);
  assert.match(source, /withDeadline\(askStatus\(tab\), 1200\)/);
  assert.match(source, /withDeadline\(cachedStatus\(\), 1200\)/);
  assert.match(source, /requestId: filmRequestId/);
  assert.match(source, /1500/);
  assert.match(source, /filmReadingReply = \{ ok: false, reason: 'send-failed' \}/);
  assert.match(source, /reading\.ok && reading\.relay/);
  assert.match(source, /reason: 'no-relay'/);
  assert.match(source, /function renderBuildWarning/);
  assert.match(source, /function renderCursorDrops/);
});

test('the background reads one film owner and returns one answer', () => {
  const source = fs.readFileSync(
    path.join(here, '..', '..', 'bridge', 'background.js'),
    'utf8'
  );
  assert.match(source, /function filmOwner\(/);
  assert.match(source, /const owner = filmOwner\(filmKey\)/);
  assert.match(source, /const \[id\] = owner/);
  assert.equal(
    (source.match(/type: 'brosr:relay-reading'/g) || []).length,
    1,
    'the read goes to one owner, not every tab'
  );
  assert.match(source, /requestId/);
});

test('the host tab carries the readings the app log shows', () => {
  const source = fs.readFileSync(path.join(here, '..', 'browser-entry.mjs'), 'utf8');
  assert.match(source, /async function panelFilmReading/);
  assert.match(source, /type: 'brosr:film-reading'/);
  assert.match(source, /readingReply: film\.reply/);
  assert.match(source, /mediaDropHistory: live\.mediaDropHistory/);
  assert.match(source, /lastLocalMediaAction: live\.lastLocalMediaAction/);
  assert.match(source, /diagnostics,/);
});

test('a refused panel command carries a machine-readable reason', () => {
  const source = fs.readFileSync(path.join(here, '..', 'browser-entry.mjs'), 'utf8');
  assert.match(source, /const refusal = \(message, reason\)/);
  assert.match(source, /refuse\(error, error\.reason \|\| 'command'\)/);
  assert.match(source, /'not-in-room'/);
  const host = fs.readFileSync(path.join(here, '..', '..', 'host', 'panel.mjs'), 'utf8');
  assert.match(host, /error\.reason = String\(data\.reason\)/);
});

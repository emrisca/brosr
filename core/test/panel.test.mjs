import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPanelPayload, panelKey, parsePanelArgs, sealPanelPayload } from '../panel.mjs';

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
  assert.match(source, /let owner = filmOwner\(filmKey\)/);
  assert.match(source, /Promise\.race\(\[mediaRestored, mediaRestoreDeadline\]\)/);
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

test('panel payloads seal under panelToken and reject plaintext or wrong tokens', () => {
  const token = 'secret-panel-token-42';
  const derived = panelKey(token);
  assert.equal(derived instanceof Uint8Array, true);
  assert.equal(derived.length, 32);
  assert.throws(() => panelKey(''), /panel token is required/);

  const payload = {
    requestId: 'req-1',
    action: 'grant',
    peerId: 'guest-1',
    allowed: true,
    tabs: [{ id: 7, url: 'https://bank.private.example/account', title: 'Private Banking' }],
  };
  const envelope = sealPanelPayload(token, payload, { room: 'room-alpha' });
  assert.deepEqual(Object.keys(envelope), ['sealed']);
  assert.equal(typeof envelope.sealed, 'string');
  const wire = JSON.stringify(envelope);
  assert.equal(wire.includes(token), false, 'raw panelToken never appears on the wire');
  assert.equal(wire.includes('grant'), false, 'action never appears in plaintext');
  assert.equal(wire.includes('bank.private.example'), false, 'private tab URL never appears');
  assert.equal(wire.includes('Private Banking'), false, 'private tab title never appears');

  const opened = openPanelPayload(token, envelope, { room: 'room-alpha' });
  assert.equal(opened.ok, true);
  assert.equal(opened.reason, 'ok');
  assert.deepEqual(opened.payload, payload);

  // Unsealed plaintext frames with raw data.token are refused.
  const plaintext = openPanelPayload(
    token,
    { token, requestId: 'req-1', action: 'grant', peerId: 'guest-1', allowed: true },
    { room: 'room-alpha' }
  );
  assert.deepEqual(plaintext, { ok: false, payload: null, reason: 'unsealed' });

  // Wrong token, wrong room AAD, tampered ciphertext, bad encoding, and missing token fail cleanly.
  assert.deepEqual(
    openPanelPayload('wrong-token', envelope, { room: 'room-alpha' }),
    { ok: false, payload: null, reason: 'decrypt-failed' }
  );
  assert.deepEqual(
    openPanelPayload(token, envelope, { room: 'room-beta' }),
    { ok: false, payload: null, reason: 'decrypt-failed' }
  );
  const flipped = envelope.sealed.slice(0, -1) + (envelope.sealed.endsWith('A') ? 'B' : 'A');
  assert.deepEqual(
    openPanelPayload(token, { sealed: flipped }, { room: 'room-alpha' }),
    { ok: false, payload: null, reason: 'decrypt-failed' }
  );
  assert.deepEqual(
    openPanelPayload(token, { sealed: 'not valid base64url!!!' }, { room: 'room-alpha' }),
    { ok: false, payload: null, reason: 'bad-encoding' }
  );
  assert.deepEqual(
    openPanelPayload('', envelope, { room: 'room-alpha' }),
    { ok: false, payload: null, reason: 'no-token' }
  );
  assert.deepEqual(
    openPanelPayload(token, null, { room: 'room-alpha' }),
    { ok: false, payload: null, reason: 'bad-envelope' }
  );
});

test('browser-entry requires openPanelPayload and seals both panel answers and refusals', () => {
  const source = fs.readFileSync(path.join(here, '..', 'browser-entry.mjs'), 'utf8');
  const onPanel = source.slice(
    source.indexOf('if (message.name === PANEL_APP)'),
    source.indexOf('if (message.name === VIEWER_APP)')
  );
  assert.match(onPanel, /openPanelPayload\(panelToken, message\.data, \{ room \}\)/);
  assert.match(onPanel, /typeof opened\.payload\.action !== 'string'/);
  assert.doesNotMatch(onPanel, /data\.token/);

  const handle = source.slice(
    source.indexOf('async function handlePanel('),
    source.indexOf('const refusal = (message, reason)')
  );
  assert.equal(
    (handle.match(/sealPanelPayload\(/g) || []).length,
    2,
    'both answer() and refuse() seal their panel reply'
  );
});

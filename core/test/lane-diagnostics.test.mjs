import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBrowserLog, describeSilentRenderer } from '../../scripts/lane-diagnostics.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const running = { pid: 4321, exitCode: null, signalCode: null };

test('a silent renderer names the socket, the process, the wait and the browser words', () => {
  const browserLog = createBrowserLog();
  browserLog.push('DevTools listening on ws://127.0.0.1:9/devtools/browser/x\n\n');
  browserLog.push('[ERROR:gpu] the GPU process is gone');
  const said = describeSilentRenderer({
    url: 'http://127.0.0.1:9000/landing/',
    elapsedMs: 20000,
    socketOpen: true,
    child: running,
    browserLog,
  });
  assert.match(said, /the devtools socket is open/);
  assert.match(said, /still running as pid 4321/);
  assert.match(said, /after 20000 ms/);
  assert.match(said, /http:\/\/127\.0\.0\.1:9000\/landing\//);
  assert.match(said, /the GPU process is gone/);
  assert.match(said, /the browser last wrote:/);
});

test('a browser that exited reports its code instead of a pid', () => {
  const said = describeSilentRenderer({
    url: 'http://127.0.0.1:9000/landing/',
    elapsedMs: 5,
    socketOpen: false,
    child: { pid: 7, exitCode: 3, signalCode: null },
    browserLog: createBrowserLog(),
  });
  assert.match(said, /the devtools socket is closed/);
  assert.match(said, /exited with code 3/);
  assert.match(said, /wrote nothing/);
  assert.doesNotMatch(said, /still running/);
});

test('a killed browser reports the signal', () => {
  const said = describeSilentRenderer({
    url: 'http://127.0.0.1:9000/landing/',
    elapsedMs: 5,
    socketOpen: false,
    child: { pid: 7, exitCode: null, signalCode: 'SIGKILL' },
    browserLog: createBrowserLog(),
  });
  assert.match(said, /killed by SIGKILL/);
});

test('a missing browser log is reported as silence', () => {
  const said = describeSilentRenderer({
    url: 'about:blank',
    elapsedMs: 5,
    socketOpen: true,
    child: running,
    browserLog: null,
  });
  assert.match(said, /wrote nothing/);
});

test('the log keeps a bounded tail and joins a line split across chunks', () => {
  const browserLog = createBrowserLog(3);
  browserLog.push('one\ntwo\nthree\nfou');
  browserLog.push('r\n');
  assert.deepEqual(browserLog.lines(), ['two', 'three', 'four']);
});

test('every layout lane sends its browser stderr into the silent renderer report', () => {
  const lanes = [
    'check-canvas-layout.mjs',
    'check-landing-layout.mjs',
    'check-room-apps-layout.mjs',
    'check-chess-play.mjs',
    'check-notes-cotyping.mjs',
  ];
  for (const name of lanes) {
    const source = fs.readFileSync(path.join(root, 'scripts', name), 'utf8');
    assert.match(
      source,
      /import \{ createBrowserLog, describeSilentRenderer \} from '\.\/lane-diagnostics\.mjs';/,
      `${name} imports the diagnosis`
    );
    assert.match(source, /const browserLog = createBrowserLog\(\);/, `${name} keeps a browser log`);
    assert.match(source, /chrome\.stderr\.on\('data'/, `${name} reads the browser stderr`);
    assert.match(
      source,
      /describeSilentRenderer\(\{/,
      `${name} names the silent renderer state`
    );
    assert.match(
      source,
      /socketOpen: this\.ws\.readyState === 1/,
      `${name} reports the devtools socket state`
    );
  }
});

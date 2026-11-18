// A room window used to start with Marionette so the panel could dock, and
// Gecko then sets navigator.webdriver on every page. Google reads that flag and
// refuses a sign in with "this browser is not secure", and the flag cannot be
// taken back while the listener runs. These tests hold the launch command and
// the profile at that boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { roomArgs } from '../../zen/live.mjs';
import { writeProfile } from '../../zen/profile.mjs';

function written() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brosr-zen-profile-'));
  // The bridge is installed by the room setup and not by this test, so the
  // writer runs with it off and touches no runtime cache.
  const profile = writeProfile(dir, { bridge: false });
  return { dir, prefs: fs.readFileSync(path.join(profile, 'user.js'), 'utf8') };
}

test('a room window starts without Marionette unless the panel is docked', () => {
  const plain = roomArgs({ profile: '/tmp/room', port: 9335, dock: false });
  assert.ok(
    !plain.includes('--marionette'),
    'the room window would tell every page it is driven by a browser tool'
  );
  assert.ok(plain.includes('--remote-debugging-port'), 'the run still needs its own port');

  const docked = roomArgs({ profile: '/tmp/room', port: 9335, dock: true });
  assert.ok(docked.includes('--marionette'), 'the dock reaches chrome scope through Marionette');
});

test('the profile does not rely on a pref Gecko removed', () => {
  // dom.webdriver.enabled stopped controlling navigator.webdriver in Gecko 88.
  // A profile that writes it would look like a fix and change nothing.
  const made = written();
  try {
    assert.ok(!made.prefs.includes('dom.webdriver.enabled'));
  } finally {
    fs.rmSync(made.dir, { recursive: true, force: true });
  }
});

test('the room profile still keeps the prefs a room needs', () => {
  const made = written();
  try {
    for (const line of [
      'user_pref("browser.startup.page", 0);',
      'user_pref("extensions.autoDisableScopes", 0);',
      'user_pref("zen.view.sidebar-expanded", true);',
    ]) {
      assert.ok(made.prefs.includes(line), `the profile lost ${line}`);
    }
  } finally {
    fs.rmSync(made.dir, { recursive: true, force: true });
  }
});

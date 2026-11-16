// The profile bookmark/debloat helpers write plain files, so these tests use a
// temporary profile and never launch a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SITES, bookmarksHtml } from '../bookmarks.mjs';
import { pinChromeExtension, writeChromiumBookmarks } from '../browsers.mjs';
import { clearSessions } from '../../zen/profile.mjs';

function tempProfile() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brosr-profile-'));
}

test('the shared list writes no toolbar bookmarks for a Chromium profile', () => {
  const profile = tempProfile();
  try {
    const bookmarks = writeChromiumBookmarks(profile);
    const disk = JSON.parse(
      fs.readFileSync(path.join(profile, 'Default', 'Bookmarks'), 'utf8')
    );
    assert.equal(SITES.length, 0);
    assert.deepEqual(disk.roots.bookmark_bar.children, []);
    assert.match(disk.checksum, /^[0-9a-f]{32}$/);
    assert.ok(bookmarks.roots.other, 'the other bookmarks root is present');
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('Chromium prefs hide the storefront and keep the bookmark bar visible', () => {
  const profile = tempProfile();
  try {
    pinChromeExtension(profile, []);
    const prefs = JSON.parse(
      fs.readFileSync(path.join(profile, 'Default', 'Preferences'), 'utf8')
    );
    assert.equal(prefs.bookmark_bar.show_on_all_tabs, true);
    assert.equal(prefs.browser.newtabpage.enabled, false);
    assert.equal(prefs.browser['newtabpage']['activity-stream'].showSponsored, false);
    assert.equal(prefs.brave.ai_chat.show_ai_chat_button, false);
    assert.equal(prefs.edge.sidebar.enabled, false);
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('the Zen bookmarks file carries no sites', () => {
  const html = bookmarksHtml(0);
  assert.equal(SITES.length, 0);
  assert.equal((html.match(/<A HREF=/g) || []).length, 0);
});

test('clearing Zen sessions removes the welcome tab-group state', () => {
  const profile = tempProfile();
  try {
    for (const name of ['sessionstore.jsonlz4', 'zen-sessions.jsonlz4', 'sessionCheckpoints.json']) {
      fs.writeFileSync(path.join(profile, name), 'x');
    }
    fs.mkdirSync(path.join(profile, 'zen-sessions-backup'));
    fs.writeFileSync(path.join(profile, 'zen-sessions-backup', 'old.jsonlz4'), 'x');
    clearSessions(profile);
    for (const name of ['sessionstore.jsonlz4', 'zen-sessions.jsonlz4', 'sessionCheckpoints.json']) {
      assert.equal(fs.existsSync(path.join(profile, name)), false, `${name} remains`);
    }
    assert.equal(fs.existsSync(path.join(profile, 'zen-sessions-backup')), false);
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

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

test('a prepared profile loses a bar left by an earlier run', () => {
  const profile = tempProfile();
  try {
    const file = path.join(profile, 'Default', 'Bookmarks');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        roots: {
          bookmark_bar: {
            children: [{ type: 'url', id: '7', name: 'Old', url: 'https://example.test/' }],
          },
          other: { children: [] },
          synced: { children: [] },
        },
      })
    );
    const bookmarks = writeChromiumBookmarks(profile);
    assert.deepEqual(bookmarks.roots.bookmark_bar.children, []);
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(disk.roots.bookmark_bar.children, []);
    assert.match(disk.checksum, /^[0-9a-f]{32}$/);
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('a prepared profile pins only the folders it loads', () => {
  const profile = tempProfile();
  try {
    const file = path.join(profile, 'Default', 'Preferences');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ extensions: { pinned_extensions: ['aaaabbbbccccddddeeeeffffgggghhhh'] } })
    );
    const out = pinChromeExtension(profile, [profile]);
    const prefs = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(prefs.extensions.pinned_extensions, out.ids);
    assert.equal(prefs.extensions.pinned_extensions.includes('aaaabbbbccccddddeeeeffffgggghhhh'), false);
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

test('Chromium profile seeds Cloudflare DoH in Local State without overriding user settings', () => {
  const profile = tempProfile();
  try {
    pinChromeExtension(profile, []);
    const localStatePath = path.join(profile, 'Local State');
    const first = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
    assert.deepEqual(first.dns_over_https, {
      mode: 'secure',
      templates: 'https://cloudflare-dns.com/dns-query',
    });

    // Respect an explicit user override already written in Local State.
    fs.writeFileSync(
      localStatePath,
      JSON.stringify({ dns_over_https: { mode: 'off' } })
    );
    pinChromeExtension(profile, []);
    const second = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
    assert.deepEqual(second.dns_over_https, { mode: 'off' });
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

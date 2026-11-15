import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXTENSIONS,
  LISTS,
  cachedCopy,
  fetchListText,
  installExtensions,
  markerPath,
  readMarker,
} from './safe-browsing.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brosr-sb-'));
}

test('the set holds four signed extensions with unique ids and files', () => {
  assert.equal(EXTENSIONS.length, 4);
  const ids = EXTENSIONS.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of EXTENSIONS) {
    assert.match(entry.url, /^https:\/\//);
    assert.match(entry.file, /\.xpi$/);
    assert.ok(entry.minBytes > 0, `${entry.id} needs a floor`);
  }
  assert.deepEqual(
    EXTENSIONS.map((entry) => entry.name),
    ['uBlock Origin', 'SponsorBlock', 'AdGuard Extra', 'P-Stream extension']
  );
});

test('the list is the FMHY uBlock build and the media add-on comes from AMO', () => {
  assert.equal(LISTS[0].url, 'https://raw.githubusercontent.com/fmhy/FMHYFilterlist/main/filterlist.txt');
  const media = EXTENSIONS.find((entry) => entry.name === 'P-Stream extension');
  assert.equal(media.id, '{be961bb7-0f52-4600-a46a-3de5e8829f68}');
  assert.match(media.url, /^https:\/\/addons\.mozilla\.org\//);
});

test('a short cache file does not count as staged', () => {
  const dir = tempDir();
  const entry = { cache: 'small.xpi', minBytes: 100 };
  fs.writeFileSync(path.join(dir, entry.cache), 'x'.repeat(20));
  assert.equal(cachedCopy(entry, dir), null);
  assert.equal(cachedCopy(entry, path.join(dir, 'missing')), null);
  fs.writeFileSync(path.join(dir, entry.cache), 'x'.repeat(200));
  assert.equal(cachedCopy(entry, dir), path.join(dir, entry.cache));
});

test('install copies a staged file into the profile and skips a missing one', () => {
  const dir = tempDir();
  const profile = tempDir();
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Copy a real staged XPI when one is present, so the path exercise runs
  // against the same file names the profile uses.
  const real = EXTENSIONS.find((entry) => cachedCopy(entry, path.join(here, '.runtime')));
  const installed = installExtensions(profile, dir);
  assert.deepEqual(installed, []);
  assert.deepEqual(fs.readdirSync(path.join(profile, 'extensions')), []);
  if (real) {
    fs.copyFileSync(cachedCopy(real, path.join(here, '.runtime')), path.join(dir, real.cache));
    assert.deepEqual(installExtensions(profile, dir), [real.id]);
    assert.ok(fs.existsSync(path.join(profile, 'extensions', real.file)));
  }
});

test('the marker round trips and a clean profile reads null', () => {
  const profile = tempDir();
  assert.equal(readMarker(profile), null);
  const report = { when: '2026-11-14T00:00:00.000Z', lists: [{ key: 'fmhy' }] };
  fs.writeFileSync(markerPath(profile), JSON.stringify(report));
  assert.deepEqual(readMarker(profile), report);
});

test('a refresh takes the upstream list and a plain read takes the cache', async () => {
  const http = await import('node:http');
  const body = '! fresh list\n' + '||blocked.example^\n'.repeat(20);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const list = {
    key: 'fresh',
    url: `http://127.0.0.1:${server.address().port}/list.txt`,
    title: 'Fresh',
    page: '',
    minBytes: 50,
  };
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'fresh.txt'), '! cached\n'.padEnd(60, 'x'));
    assert.match(await fetchListText(list, dir), /^! cached/);
    assert.equal(await fetchListText(list, dir, { refresh: true }), body);
    assert.equal(fs.readFileSync(path.join(dir, 'fresh.txt'), 'utf8'), body);
    assert.equal(await fetchListText(list, dir), body);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

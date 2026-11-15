import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PAGE_KEY_PREFIX,
  filmUrl,
  isPageBoundSource,
  mediaKeyFor,
  pageKey,
} from '../media-relay.mjs';

function fakeVideo(src) {
  return { currentSrc: src, src, duration: 90 };
}

test('a page key keeps the origin and the path and drops the rest', () => {
  assert.equal(pageKey('https://stream.test/watch/abc?t=30#x'), 'page:https://stream.test/watch/abc');
  assert.equal(pageKey(''), '');
  assert.equal(pageKey('about:blank'), '');
});

test('a blob, a media source and an HLS manifest all take the page key', () => {
  const page = 'https://stream.test/watch/abc';
  assert.equal(isPageBoundSource('blob:https://stream.test/8f2c'), true);
  assert.equal(isPageBoundSource('https://cdn.test/hls/master.m3u8?token=1'), true);
  assert.equal(
    mediaKeyFor(fakeVideo('blob:https://stream.test/8f2c'), { pageUrl: page }),
    'page:https://stream.test/watch/abc'
  );
  assert.equal(
    mediaKeyFor(fakeVideo('https://cdn.test/hls/master.m3u8?token=1'), { pageUrl: page }),
    'page:https://stream.test/watch/abc'
  );
  assert.equal(
    mediaKeyFor(fakeVideo('https://cdn.test/dash/manifest.mpd'), { pageUrl: page }),
    'page:https://stream.test/watch/abc'
  );
});

test('a quality switch keeps one key', () => {
  const page = 'https://stream.test/watch/abc';
  const low = mediaKeyFor(fakeVideo('https://cdn.test/hls/low.m3u8'), { pageUrl: page });
  const high = mediaKeyFor(fakeVideo('https://cdn.test/hls/high.m3u8'), { pageUrl: page });
  assert.equal(low, high);
});

test('a plain file URL still names its own film', () => {
  assert.equal(
    mediaKeyFor(fakeVideo('https://cdn.test/clip.webm'), { pageUrl: 'https://stream.test/watch' }),
    'https://cdn.test/clip.webm'
  );
});

test('an element with no source yet reads the page', () => {
  assert.equal(
    mediaKeyFor(fakeVideo(''), { pageUrl: 'https://stream.test/watch/abc' }),
    'page:https://stream.test/watch/abc'
  );
});

test('a page key turns back into the page the panel opens', () => {
  assert.equal(
    filmUrl(`${PAGE_KEY_PREFIX}https://stream.test/watch/abc`),
    'https://stream.test/watch/abc'
  );
  assert.equal(filmUrl('https://stream.test/watch/abc'), 'https://stream.test/watch/abc');
  assert.equal(filmUrl('youtube:abc123'), 'https://www.youtube.com/watch?v=abc123');
  assert.equal(filmUrl(`${PAGE_KEY_PREFIX}not a url`), '');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { shareable, tabClose, tabOpen } from '../tabs.mjs';

test('a plain web page is shareable and a browser page is not', () => {
  assert.equal(shareable('https://example.com/article'), true);
  assert.equal(shareable('http://127.0.0.1:8788/room-b.html'), true);
  assert.equal(shareable('chrome://settings'), false);
  assert.equal(shareable('chrome-extension://abc/panel/room.html'), false);
  assert.equal(shareable('about:blank'), false);
  assert.equal(shareable('file:///Users/me/notes.html'), false);
  assert.equal(shareable('javascript:alert(1)'), false);
  assert.equal(shareable(''), false);
  assert.equal(shareable(null), false);
});

test('an open message needs an action and a shareable url', () => {
  assert.deepEqual(tabOpen({ action: 'open', url: 'https://example.com/' }), {
    url: 'https://example.com/',
    key: null,
  });
  assert.equal(tabOpen({ action: 'open', url: 'chrome://settings' }), null);
  assert.equal(tabOpen({ action: 'close', url: 'https://example.com/' }), null);
  assert.equal(tabOpen(null), null);
});

test('a close needs a key and never carries a URL', () => {
  assert.deepEqual(tabClose({ action: 'close', key: 42 }), { key: '42' });
  assert.deepEqual(tabClose({ action: 'close', key: '42', url: 'https://example.com/' }), {
    key: '42',
  });
  assert.equal(tabClose({ action: 'close' }), null);
  assert.equal(tabClose({ action: 'open', key: '42' }), null);
  assert.equal(tabClose(null), null);
});

test('the host tab rides along as a key', () => {
  assert.deepEqual(tabOpen({ action: 'open', url: 'https://example.com/watch', key: 42 }), {
    url: 'https://example.com/watch',
    key: '42',
  });
  assert.deepEqual(tabOpen({ action: 'open', url: 'https://example.com/next', key: '42' }), {
    url: 'https://example.com/next',
    key: '42',
  });
});

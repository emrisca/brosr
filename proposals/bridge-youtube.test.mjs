// The page-scope hand-in, run in a fake page. The script is a classic browser
// script with no exports, so the test reads it and evaluates it in a context
// with a window, a document and controllable timers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('./bridge-youtube.js', import.meta.url), 'utf8');

function player(tag) {
  return { tag, time: 0, getCurrentTime: () => 0, seekTo() {} };
}

function runPage({ existing = null, api = null, search = '' } = {}) {
  const timers = [];
  const listeners = new Map();
  const nodes = new Map();
  if (existing) nodes.set('#movie_player', existing);
  const document = {
    querySelector: (want) => nodes.get(want) || null,
    addEventListener: (name, fn) => listeners.set(name, fn),
  };
  const ctx = {
    document,
    location: { search },
    URLSearchParams,
    YT: api,
    setInterval: (fn, ms) => {
      timers.push({ fn, ms, cleared: false });
      return timers.length;
    },
    clearInterval: (id) => {
      if (timers[id - 1]) timers[id - 1].cleared = true;
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx);
  return { ctx, timers, listeners, nodes };
}

test('a player already on the page is published at once', () => {
  const ready = player('movie_player');
  const { ctx, timers } = runPage({ existing: ready });
  assert.equal(ctx.__brosrYouTubePlayer, ready);
  assert.equal(timers.length, 0, 'a found player needs no poll');
});

test('a player that arrives later is published on a poll', () => {
  const { ctx, timers, nodes } = runPage();
  assert.equal(ctx.__brosrYouTubePlayer, undefined);

  const late = player('movie_player');
  nodes.set('#movie_player', late);
  timers[0].fn();

  assert.equal(ctx.__brosrYouTubePlayer, late);
  assert.equal(timers[0].cleared, true, 'the poll stops once the player is found');
});

test('the poll gives up after two minutes and stops', () => {
  const { ctx, timers } = runPage();
  for (let i = 0; i < 120; i += 1) timers[0].fn();
  assert.equal(ctx.__brosrYouTubePlayer, undefined);
  assert.equal(timers[0].cleared, true, 'no timer runs for the life of the page');
});

test('an embed player comes from the IFrame API by video id', () => {
  const embed = player('embed');
  const api = { get: (id) => (id === 'abc123' ? embed : null) };
  const { ctx } = runPage({ api, search: '?v=abc123' });
  assert.equal(ctx.__brosrYouTubePlayer, embed);
});

test('a navigation republishes the player the page swaps in', () => {
  const first = player('first');
  const { ctx, listeners, nodes } = runPage({ existing: first });
  assert.equal(ctx.__brosrYouTubePlayer, first);

  const second = player('second');
  nodes.set('#movie_player', second);
  listeners.get('yt-navigate-finish')();

  assert.equal(ctx.__brosrYouTubePlayer, second);
});

test('a node without the player methods is not published', () => {
  const box = { tag: 'movie_player' };
  const { ctx } = runPage({ existing: box });
  assert.equal(ctx.__brosrYouTubePlayer, undefined);
});

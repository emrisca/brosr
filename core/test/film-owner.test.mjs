import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseFilmOwner } from '../media-relay.mjs';

test('the focused film tab owns the read', () => {
  const entries = [
    [11, { key: 'film', at: 100 }],
    [12, { key: 'film', at: 200 }],
  ];
  assert.deepEqual(chooseFilmOwner(entries, 'film', 11), [11, { key: 'film', at: 100 }]);
});

test('the most recently active copy wins when no tab is focused', () => {
  const entries = [
    [11, { key: 'film', at: 100 }],
    [12, { key: 'film', at: 300 }],
    [13, { key: 'other', at: 400 }],
  ];
  assert.equal(chooseFilmOwner(entries, 'film')[0], 12);
});

test('a film with no tab has no owner', () => {
  assert.equal(chooseFilmOwner([[11, { key: 'other', at: 100 }]], 'film'), null);
  assert.equal(chooseFilmOwner([], 'film'), null);
});

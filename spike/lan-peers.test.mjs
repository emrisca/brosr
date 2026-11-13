// The launcher builds one peer.mjs command per id. The plan is pure, so this
// test checks the commands and the journal paths without starting a peer.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { planPeers } from './lan-peers.mjs';

const base = {
  room: 'lan1',
  relay: '192.168.8.161',
  port: 8787,
  seconds: 4200,
  outPrefix: '.runtime/lan1',
};

test('each peer gets its own command, journal and id', () => {
  const plan = planPeers({ ...base, peers: 'mac1,mac2' });
  assert.equal(plan.length, 2);
  assert.deepEqual(plan.map((item) => item.id), ['mac1', 'mac2']);
  assert.deepEqual(plan.map((item) => item.out), [
    '.runtime/lan1-mac1.json',
    '.runtime/lan1-mac2.json',
  ]);

  for (const item of plan) {
    const arg = (name) => item.argv.find((value) => value.startsWith(`--${name}=`));
    assert.equal(arg('relay'), '--relay=192.168.8.161');
    assert.equal(arg('port'), '--port=8787');
    assert.equal(arg('room'), '--room=lan1');
    assert.equal(arg('seconds'), '--seconds=4200');
    assert.equal(arg('peer'), `--peer=${item.id}`);
    assert.ok(item.argv[0].endsWith(path.join('spike', 'peer.mjs')), 'the command runs peer.mjs');
  }
});

test('a peer list needs ids, no repeats and a positive duration', () => {
  assert.throws(() => planPeers({ ...base, peers: '' }), /at least one id/);
  assert.throws(() => planPeers({ ...base, peers: 'mac1, mac1' }), /twice/);
  assert.throws(() => planPeers({ ...base, peers: 'mac1', seconds: 0 }), /positive number/);
  assert.throws(() => planPeers({ ...base, peers: 'mac1', outPrefix: '' }), /out-prefix/);
});

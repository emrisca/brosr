// The bus moves files between two machines, so the test runs the real CLI
// against a temporary root. No Syncthing and no network take part.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, 'handoff.mjs');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-'));
}

function run(root, ...args) {
  const out = execFileSync(process.execPath, [cli, ...args, `--root=${root}`], {
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}

function failing(root, ...args) {
  try {
    run(root, ...args);
  } catch (error) {
    return error;
  }
  return null;
}

test('a request is claimed, answered and archived', () => {
  const root = tempRoot();
  try {
    const sent = run(root, 'send', '--from=win', '--to=mac', '--type=request', '--payload={"n":1}');
    assert.equal(sent.event, 'sent');
    assert.equal(sent.to, 'mac');
    const pending = path.join(root, 'inbox', 'mac', `${sent.id}.json`);
    assert.ok(fs.existsSync(pending), 'the request waits in the target inbox');
    assert.deepEqual(
      fs.readdirSync(path.join(root, 'inbox', 'mac')).filter((name) => name.endsWith('.tmp')),
      [],
      'an atomic write leaves no temp file behind'
    );

    const listed = run(root, 'list', '--side=mac');
    assert.equal(listed.count, 1);

    const claimed = run(root, 'claim', '--side=mac');
    assert.equal(claimed.id, sent.id);
    assert.equal(fs.existsSync(pending), false, 'a claimed message leaves the inbox');
    assert.ok(fs.existsSync(path.join(root, 'processing', 'mac', `${sent.id}.json`)));

    const replied = run(
      root,
      'reply',
      '--side=mac',
      `--id=${sent.id}`,
      '--type=result',
      '--payload={"ok":true}'
    );
    const body = JSON.parse(fs.readFileSync(path.join(root, 'inbox', 'win', `${replied.reply}.json`), 'utf8'));
    assert.equal(body.in_reply_to, sent.id);
    assert.equal(body.type, 'result');
    assert.equal(body.from, 'mac');
    assert.equal(body.to, 'win');
    assert.deepEqual(body.payload, { ok: true });

    assert.ok(fs.existsSync(path.join(root, 'done', 'mac', `${sent.id}.json`)));
    assert.equal(
      fs.existsSync(path.join(root, 'processing', 'mac', `${sent.id}.json`)),
      false,
      'the original leaves processing once it is answered'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a second message gets a new sequence, and ids never repeat', () => {
  const root = tempRoot();
  try {
    const first = run(root, 'send', '--from=win', '--to=mac', '--type=status', '--payload={}');
    const second = run(root, 'send', '--from=win', '--to=mac', '--type=status', '--payload={}');
    assert.notEqual(first.id, second.id);
    assert.match(first.id, /-win-\d{4}$/);
    assert.match(second.id, /-win-\d{4}$/);
    assert.equal(run(root, 'list', '--side=mac').count, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('check reports a waiting message and exits 3 without claiming it', () => {
  const root = tempRoot();
  try {
    assert.equal(run(root, 'check', '--side=mac').count, 0);
    const sent = run(root, 'send', '--from=win', '--to=mac', '--type=request', '--payload={}');

    const waiting = failing(root, 'check', '--side=mac');
    assert.ok(waiting, 'check exits non-zero while a message waits');
    assert.equal(waiting.status, 3);
    assert.match(String(waiting.stdout), /"count":1/);
    assert.ok(
      fs.existsSync(path.join(root, 'inbox', 'mac', `${sent.id}.json`)),
      'check leaves the message in the inbox'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an empty inbox reports empty and exits 2', () => {
  const root = tempRoot();
  try {
    const error = failing(root, 'claim', '--side=mac');
    assert.ok(error, 'claim fails on an empty inbox');
    assert.equal(error.status, 2);
    assert.match(String(error.stdout), /"event":"empty"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('status shows waiting and claimed work, with an age', () => {
  const root = tempRoot();
  try {
    const sent = run(root, 'send', '--from=win', '--to=mac', '--type=request', '--payload={}');

    const before = run(root, 'status');
    assert.equal(before.event, 'status');
    assert.equal(before.waiting, 1);
    assert.equal(before.claimed, 0);
    assert.equal(before.rows[0].id, sent.id);
    assert.equal(before.rows[0].state, 'waiting');
    assert.equal(typeof before.rows[0].ageMinutes, 'number');
    assert.ok(before.rows[0].ageMinutes >= 0, 'an age counts from the message stamp');

    run(root, 'claim', '--side=mac');
    const after = run(root, 'status');
    assert.equal(after.waiting, 0);
    assert.equal(after.claimed, 1);
    assert.equal(after.rows[0].id, sent.id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tidy removes a stale Syncthing temp and keeps a fresh one', () => {
  const root = tempRoot();
  try {
    const stale = path.join(root, '.syncthing.HANDOFF.md.tmp');
    const fresh = path.join(root, '.syncthing.plan.md.tmp');
    const tracked = path.join(root, 'plan.md');
    fs.writeFileSync(stale, 'half a file');
    fs.writeFileSync(fresh, 'half a file');
    fs.writeFileSync(tracked, 'a real file');
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);

    const dry = run(root, 'tidy', '--dry-run');
    assert.deepEqual(dry.removed, ['.syncthing.HANDOFF.md.tmp']);
    assert.ok(fs.existsSync(stale), 'a dry run removes nothing');

    const done = run(root, 'tidy');
    assert.deepEqual(done.removed, ['.syncthing.HANDOFF.md.tmp']);
    assert.equal(fs.existsSync(stale), false, 'a stale temp goes');
    assert.ok(fs.existsSync(fresh), 'a recent temp may belong to a live transfer');
    assert.ok(fs.existsSync(tracked), 'a real file never goes');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a message cannot name the same side twice', () => {
  const root = tempRoot();
  try {
    const error = failing(root, 'send', '--from=mac', '--to=mac', '--type=request', '--payload={}');
    assert.ok(error, 'a same-side send fails');
    assert.equal(error.status, 1);
    assert.match(String(error.stderr), /different side/);
    assert.equal(run(root, 'list', '--side=mac').count, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

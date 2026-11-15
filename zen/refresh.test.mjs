import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendRun, statusLine, statusRun } from './refresh.mjs';

const marker = (blocked, want) => ({
  verified: {
    blocked,
    wantFilters: 8919,
    filters: 8919,
    control: { state: 'resolved' },
    probes: new Array(want).fill({}),
    scripts: ['Bypass All Shortlinks'],
  },
});

test('a run is ok only when every probe blocked and the control loaded', () => {
  assert.equal(statusRun(marker(2, 2), 0, 30).ok, true);
  assert.equal(statusRun(marker(1, 2), 0, 30).ok, false);
  assert.equal(statusRun(marker(2, 2), 1, 30).ok, false);
  assert.equal(statusRun(null, 1, 30).ok, false);
  assert.equal(statusRun(null, 1, 30).control, 'none');
});

test('the status line carries the counters', () => {
  const line = statusLine(statusRun(marker(2, 2), 0, 31));
  assert.match(line, /ok blocked=2\/2 control=resolved list=8919\/8919/);
  assert.match(line, /script=Bypass All Shortlinks took=31s/);
});

test('appendRun keeps the newest runs and rewrites the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brosr-refresh-'));
  const file = path.join(dir, 'refresh-status.json');
  for (let index = 0; index < 25; index += 1) {
    appendRun(file, { ...statusRun(marker(2, 2), 0, index), when: `run-${index}` });
  }
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.runs.length, 20);
  assert.equal(doc.runs[0].when, 'run-5');
  assert.equal(doc.updated, 'run-24');
  fs.rmSync(dir, { recursive: true, force: true });
});

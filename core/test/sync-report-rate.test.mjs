import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const { buildSyncReport } = require(path.join(root, 'bridge', 'panel', 'sync-report.js'));

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

test('the report names the rate corrections a film tab ran', () => {
  const text = buildSyncReport(
    {
      data: {
        roomName: 'Room',
        media: { key: 'youtube:abc', position: 1, playing: true, open: true },
      },
    },
    {
      ok: true,
      relay: {
        applies: 10,
        stats: { applied: 10 },
        rate: {
          roomRate: 1,
          changes: 2,
          trace: [
            { at: NOW, kind: 'nudge', roomRate: 1, elementRate: 0.95, drift: -0.4 },
            { at: NOW, kind: 'seek-reset', roomRate: 1, elementRate: 1, drift: -40 },
          ],
        },
      },
    },
    { now: NOW }
  );
  assert.match(text, /Room rate: 1\.00 \(2 corrections\)/);
  assert.match(text, /Rate trace: nudge 1\.00 -> 0\.95, -0\.40 s/);
  assert.match(text, /seek-reset 1\.00 -> 1\.00, -40\.00 s/);
});

test('the report leaves the rate block out when nothing corrected a rate', () => {
  const text = buildSyncReport(
    {
      data: {
        roomName: 'Room',
        media: { key: 'youtube:abc', position: 1, playing: true, open: true },
      },
    },
    { ok: true, relay: { applies: 2, stats: { applied: 2 }, rate: { roomRate: 1, changes: 0, trace: [] } } },
    { now: NOW }
  );
  assert.doesNotMatch(text, /Room rate:/);
  assert.doesNotMatch(text, /Rate trace:/);
});

test('the report names the file the rate log lands in', () => {
  const text = buildSyncReport(
    { data: { roomName: 'Room', media: { key: 'youtube:abc', position: 1, playing: false, open: false } } },
    null,
    { now: NOW, logFile: '/tmp/brosr/media-sync.jsonl' }
  );
  assert.match(text, /^Log file: \/tmp\/brosr\/media-sync\.jsonl$/m);
});

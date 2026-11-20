// The app stages host/ and bridge/ under app/, whose package.json marks .js
// files as module type. This test rebuilds that small tree so the loader meets
// the same Node rule the installed app meets.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');

test('the host reads the sync report under an app package type', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brosr-report-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
    fs.mkdirSync(path.join(dir, 'bridge', 'panel'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'host'), { recursive: true });
    const report = path.join(dir, 'bridge', 'panel', 'sync-report.js');
    fs.copyFileSync(path.join(root, 'bridge', 'panel', 'sync-report.js'), report);
    const loader = path.join(dir, 'host', 'report.mjs');
    fs.copyFileSync(path.join(root, 'host', 'report.mjs'), loader);

    // The bare require is the fault: under module type the UMD file loads as
    // ES, so module.exports never runs and the export is missing.
    const bare = createRequire(loader)(report);
    assert.equal(bare.buildSyncReport, undefined);

    const { buildSyncReport } = await import(pathToFileURL(loader).href);
    assert.equal(typeof buildSyncReport, 'function');
    const text = buildSyncReport(
      {
        data: {
          roomName: 'Room',
          room: 'room-x',
          role: 'host',
          name: 'Ada',
          peerId: 'host-1',
          peers: 1,
          peerList: [],
        },
      },
      null,
      { now: 0 }
    );
    assert.match(text, /^Room: Room$/m);
    assert.match(text, /^Peers: 1$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

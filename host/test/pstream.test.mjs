import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { makeZip } from '../../spike/zip.mjs';
import { crxPayload, grantHostAccess, pstreamCopy, stagePStream, unpackCrx } from '../pstream.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brosr-pstream-'));
}

function crx3(payload, header = Buffer.from([0x0a, 0x00])) {
  const out = Buffer.alloc(12 + header.length + payload.length);
  out.write('Cr24', 0, 'ascii');
  out.writeUInt32LE(3, 4);
  out.writeUInt32LE(header.length, 8);
  header.copy(out, 12);
  payload.copy(out, 12 + header.length);
  return out;
}

test('a CRX3 header is stripped to the ZIP payload', () => {
  const zip = makeZip([{ name: 'manifest.json', data: '{}' }]);
  assert.deepEqual(crxPayload(crx3(zip)), zip);
});

test('a CRX2 header removes both length fields', () => {
  const zip = Buffer.from('PK payload');
  const header = Buffer.alloc(16);
  header.write('Cr24', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(3, 8);
  header.writeUInt32LE(4, 12);
  const crx = Buffer.concat([header, Buffer.from('key'), Buffer.from('sig!'), zip]);
  assert.deepEqual(crxPayload(crx), zip);
});

test('a non-CRX file and an empty CRX are refused', () => {
  assert.throws(() => crxPayload(Buffer.from('PK zip')), /not a CRX file/);
  assert.throws(() => crxPayload(Buffer.from('Cr24')), /not a CRX file/);
  const crx = crx3(Buffer.alloc(0));
  assert.throws(() => crxPayload(crx), /holds no payload/);
});

test('an unpacked CRX loses store metadata and keeps its folder', () => {
  const dir = tempDir();
  const crx = crx3(
    makeZip([
      { name: 'manifest.json', data: JSON.stringify({ manifest_version: 3, version: '1.2.3' }) },
      { name: '_metadata/verified_contents.json', data: '{}' },
      { name: 'static/background/index.js', data: 'export {};' },
    ])
  );
  const file = path.join(dir, 'p-stream.crx');
  fs.writeFileSync(file, crx);
  const out = unpackCrx(file, dir);
  assert.equal(out.version, '1.2.3');
  assert.equal(pstreamCopy(dir), path.join(dir, 'p-stream-chrome'));
  assert.ok(fs.existsSync(path.join(out.dir, 'static', 'background', 'index.js')));
  assert.equal(fs.existsSync(path.join(out.dir, '_metadata')), false);
});

test('a staged copy requires host access instead of asking on a page', async () => {
  const dir = tempDir();
  const folder = path.join(dir, 'p-stream-chrome');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      version: '1.0.0',
      permissions: ['storage'],
      optional_host_permissions: ['<all_urls>'],
    })
  );
  const hit = await stagePStream(dir);
  assert.equal(hit.staged, false);
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  assert.equal('optional_host_permissions' in manifest, false);
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.equal(grantHostAccess(folder).changed, false);
});

test('an unpacked copy with no optional host access is left as it is', () => {
  const dir = tempDir();
  const folder = path.join(dir, 'p-stream-chrome');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'manifest.json');
  const original = JSON.stringify({ manifest_version: 3, version: '9.9.9' });
  fs.writeFileSync(file, original);
  assert.equal(grantHostAccess(folder).changed, false);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

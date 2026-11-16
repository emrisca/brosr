// The devtools pipe is the only way a branded Chrome takes an unpacked
// add-on. These tests cover the framing, the reply matching and the per folder
// load, so a change to the wire never needs a running browser to catch.
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { PipeClient, loadExtensions } from '../chrome-pipe.mjs';
import { chromeExtensionId } from '../browsers.mjs';

// The write side collects whole frames. The read side is pushed by the test.
function pair() {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames = [];
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    for (const text of chunk.split('\0')) if (text) frames.push(text);
  });
  return { input, output, frames };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a request is one NUL framed message and its reply resolves the call', async () => {
  const { input, output, frames } = pair();
  const client = new PipeClient(input, output);
  const pending = client.send('Extensions.loadUnpacked', { path: '/tmp/addon' });
  await settle();

  assert.equal(frames.length, 1);
  const sent = JSON.parse(frames[0]);
  assert.equal(sent.method, 'Extensions.loadUnpacked');
  assert.equal(sent.params.path, '/tmp/addon');

  // A reply can arrive in pieces, and the tail waits for its NUL.
  const reply = `${JSON.stringify({ id: sent.id, result: { id: 'abc' } })}\0`;
  output.write(reply.slice(0, 9));
  await settle();
  output.write(reply.slice(9));

  assert.deepEqual(await pending, { id: 'abc' });
  client.close();
});

test('two replies in one chunk both land, and an error rejects its own call', async () => {
  const { input, output, frames } = pair();
  const client = new PipeClient(input, output);
  const first = client.send('Browser.getVersion');
  const second = client.send('Target.getTargets');
  await settle();
  assert.equal(frames.length, 2);

  const a = JSON.parse(frames[0]).id;
  const b = JSON.parse(frames[1]).id;
  output.write(
    `${JSON.stringify({ id: a, result: { product: 'Chrome/157' } })}\0` +
      `${JSON.stringify({ id: b, error: { code: -32601, message: 'no such method' } })}\0`
  );

  assert.deepEqual(await first, { product: 'Chrome/157' });
  await assert.rejects(second, /no such method/);
  client.close();
});

test('a pipe that closes fails every waiting call instead of hanging', async () => {
  const { input, output } = pair();
  const client = new PipeClient(input, output);
  const pending = client.send('Browser.getVersion');
  await settle();
  output.end();
  output.destroy();
  await assert.rejects(pending, /pipe closed/);
  await assert.rejects(client.send('Browser.getVersion'), /pipe closed/);
});

test('each folder loads in turn and one failure does not stop the rest', async () => {
  const calls = [];
  const stub = {
    async loadUnpacked(dir) {
      calls.push(dir);
      if (dir === '/tmp/broken') throw new Error('manifest is missing');
      return `id-${calls.length}`;
    },
  };
  const loaded = await loadExtensions(stub, ['/tmp/one', '/tmp/broken', '/tmp/three']);
  assert.deepEqual(calls, ['/tmp/one', '/tmp/broken', '/tmp/three']);
  assert.deepEqual(loaded.ids, ['id-1', null, 'id-3']);
  assert.equal(loaded.errors.length, 1);
  assert.match(loaded.errors[0].error, /manifest is missing/);
});

test('the pinned id is the shape Chrome derives from the folder path', () => {
  // Chrome turns a SHA-256 of the path into a 32 character a to p id. The room
  // pins the same id before the window opens, so a mismatch hides the toolbar.
  const id = chromeExtensionId('/tmp/room/bridge-chrome');
  assert.equal(id.length, 32);
  assert.match(id, /^[a-p]{32}$/);
  assert.equal(chromeExtensionId('/tmp/room/bridge-chrome'), id, 'the same folder keeps one id');
  assert.notEqual(chromeExtensionId('/tmp/room/other'), id);
});

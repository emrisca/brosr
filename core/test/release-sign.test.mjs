// The bridge signer may only replace the signed XPI with a file AMO has
// actually signed. AMO lists a version row before it signs the package, so an
// unreviewed row still carries a URL, but that file is the received package.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function source() {
  return fs.readFileSync(path.join(root, 'scripts', 'release-bridge.mjs'), 'utf8');
}

function grab(text, name) {
  const start = text.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  let depth = 0;
  for (let i = text.indexOf('{', start); i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (!depth) return text.slice(start, i + 1);
    }
  }
  assert.fail(`unclosed ${name}`);
}

test('only a public AMO file counts as signed', () => {
  const build = new Function(`${grab(source(), 'amoFileSigned')}\nreturn amoFileSigned;`)();
  assert.equal(build({ file: { status: 'public', url: 'https://example.com/0.4.11.xpi' } }), true);
  // The exact shape AMO returned for 0.4.11 before it signed: a URL is present.
  assert.equal(build({ file: { status: 'unreviewed', url: 'https://example.com/0.4.11.xpi' } }), false);
  assert.equal(build({ file: { status: 'disabled', url: 'https://example.com/0.4.11.xpi' } }), false);
  assert.equal(build({ file: { status: 'public' } }), false);
  assert.equal(build({}), false);
  assert.equal(build(null), false);
});

test('the fallback waits for a signed file before it writes one', () => {
  const text = source();
  assert.match(text, /if \(amoFileSigned\(row\)\)/);
  assert.match(text, /BROSR_SIGN_WAIT_MS/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePanelArgs } from '../../core/panel.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.join(here, '..', '..', 'app', 'src');

test('the app sends the field names the CLI schema accepts', () => {
  const controls = fs.readFileSync(path.join(app, 'screens', 'controls.tsx'), 'utf8');
  assert.match(controls, /act\('tab', \{ tabId: tab\.id, shared: !tab\.shared \}\)/);
  assert.doesNotMatch(controls, /act\('grant'/);

  assert.deepEqual(
    parsePanelArgs(['--action=tab', '--tabId=9', '--shared=false']).values,
    { tabId: 9, shared: false }
  );
});

test('the app argument builder keeps the schema key names', () => {
  const host = fs.readFileSync(path.join(app, 'lib', 'host.ts'), 'utf8');
  assert.match(host, /export type PanelAction/);
  assert.match(host, /export type PanelValues/);
  assert.match(host, /`--\$\{key\}=\$\{String\(value\)\}`/);
});

test('the first screen picks the browser for both paths', () => {
  const welcome = fs.readFileSync(path.join(app, 'screens', 'welcome.tsx'), 'utf8');
  const join = fs.readFileSync(path.join(app, 'screens', 'join.tsx'), 'utf8');
  const screen = fs.readFileSync(path.join(app, 'App.tsx'), 'utf8');
  const link = fs.readFileSync(path.join(app, 'lib', 'host.ts'), 'utf8');
  const cli = fs.readFileSync(path.join(here, '..', 'cli.mjs'), 'utf8');

  // The choice lives on the first screen. Discovery and a pasted link both use
  // it instead of detecting a second time and taking the first build.
  assert.match(welcome, /id="start-browser"/);
  assert.match(welcome, /browsers\.map/);
  assert.match(screen, /joinRoom\(room\.url, browser\.id, name\)/);
  assert.doesNotMatch(screen, /step === 'browsers'/);
  assert.doesNotMatch(join, /id="join-browser"/);
  assert.match(join, /browserId/);

  // The backend receives that id, so a discovery join can open Zen when Zen
  // is chosen even when Firefox comes first in the scan.
  assert.match(link, /--browser=\$\{browser\}/);
  assert.match(cli, /browser: arg\('browser'\) \|\| undefined/);
});

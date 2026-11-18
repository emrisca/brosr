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
  assert.match(controls, /act\('grant', \{ peerId: peer\.id, allowed: !peer\.granted \}\)/);
  assert.match(controls, /act\('tab', \{ tabId: tab\.id, shared: !tab\.shared \}\)/);

  assert.deepEqual(
    parsePanelArgs(['--action=grant', '--peerId=guest-1', '--allowed=true']).values,
    { peerId: 'guest-1', allowed: true }
  );
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

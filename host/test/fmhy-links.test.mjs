import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare, parseFmhy, parseLanding } from '../../scripts/check-fmhy-links.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('FMHY link checker accepts official numeric mirrors while flagging dead or changed domains', () => {
  const markdown = [
    '## ▷ Stream Aggregators',
    '* ⭐ **[CorsFlix](https://watch.corsflix.net)**, [2](https://watch.corsflix.dpdns.org) - 1080p',
    '## ▷ P-Stream Forks',
    '* ⭐ **[Aether](https://aether.st/)**, [2](https://aether.cx/) - 4K',
    '## ▷ Anime Streaming',
    '* ⭐ **[AniXo](https://anixo.live/)**, [2](https://anixo.cfd/) - Sub',
  ].join('\n');

  const expected = parseFmhy(markdown);
  const aether = expected.find((row) => row.name === 'Aether');
  assert.deepEqual(aether.mirrors, ['https://aether.cx/']);

  const okActual = [
    { group: 'Stream Aggregators', name: 'CorsFlix', url: 'https://watch.corsflix.dpdns.org/', key: 'corsflix', urlKey: 'https://watch.corsflix.dpdns.org/' },
    { group: 'Stream Aggregators', name: 'Aether', url: 'https://aether.cx/', key: 'aether', urlKey: 'https://aether.cx/' },
    { group: 'Anime Streaming', name: 'AniXo', url: 'https://anixo.live/', key: 'anixo', urlKey: 'https://anixo.live/' },
  ];
  assert.deepEqual(compare(expected, okActual).problems, []);

  const badActual = okActual.map((row) =>
    row.name === 'AniXo'
      ? { ...row, url: 'https://anixo.online/home', urlKey: 'https://anixo.online/home' }
      : row
  );
  const problems = compare(expected, badActual).problems;
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'changed');
  assert.equal(problems[0].name, 'AniXo');
});

test('landing Watch directory uses updated FMHY links and fmhy-links workflow runs from repo root', () => {
  const html = fs.readFileSync(path.join(root, 'landing', 'index.html'), 'utf8');
  const rows = parseLanding(html);
  assert.ok(rows.length >= 40, 'Watch directory should list FMHY sites');
  const byName = new Map(rows.map((row) => [row.name, row.url]));
  assert.equal(byName.get('AniXo'), 'https://anixo.live/');
  assert.equal(byName.get('Vivarium'), 'https://vivarium.st/');
  assert.equal(byName.get('Aether'), 'https://aether.cx/');
  assert.equal(byName.get('CorsFlix'), 'https://watch.corsflix.dpdns.org/');
  assert.ok(!html.includes('anixo.online'), 'dead anixo.online domain must not remain');
  assert.ok(!html.includes('vivarium.su'), 'outdated vivarium.su domain must not remain');

  const workflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'fmhy-links.yml'),
    'utf8'
  );
  assert.doesNotMatch(workflow, /working-directory:\s*apps\/brosr/);
});

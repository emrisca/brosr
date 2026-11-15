import assert from 'node:assert/strict';
import test from 'node:test';
import { compare, parseOptions, parseRules, probesFor } from './audit.mjs';

const LIST = [
  '! comment',
  '[Adblock Plus 2.0]',
  '||igg-games.com^',
  '||igg-games.com^',
  '||ipcgames.com/ocean-of-games/*',
  '||massgrave.*^$all,domain=~massgrave.dev|~massgrave.pages.dev',
  '||github.com/*/*KMS*pico*$all',
  'thepiratebay.org##p',
  'thepiratebay.org#?#li:-abp-has(> .item-type:-abp-contains(/Games/))',
  'thepiratebay.org##main::before:style(content: "a $ sign";)',
].join('\n');

test('parseRules keeps every shape apart', () => {
  const rules = parseRules(LIST);
  assert.deepEqual(rules.whole, [{ host: 'igg-games.com', count: 2 }]);
  assert.deepEqual(rules.url.map((rule) => rule.host), ['ipcgames.com']);
  assert.equal(rules.options.length, 2);
  assert.deepEqual(rules.options[0].options.domains, [
    '~massgrave.dev',
    '~massgrave.pages.dev',
  ]);
  assert.equal(rules.cosmetic.length, 3);
  assert.deepEqual(
    rules.cosmetic.map((rule) => rule.kind),
    ['##', '#?#', '##']
  );
  assert.deepEqual(rules.other, []);
});

test('a dollar inside a cosmetic rule is not an option', () => {
  const rules = parseRules(LIST);
  const style = rules.cosmetic.find((rule) => rule.rule.includes('$ sign'));
  assert.ok(style, 'the style rule should stay cosmetic');
  assert.equal(rules.options.length, 2);
});

test('parseOptions splits names from domain exclusions', () => {
  const options = parseOptions('all,domain=~a.dev|~b.dev');
  assert.deepEqual(options.names, ['all']);
  assert.deepEqual(options.domains, ['~a.dev', '~b.dev']);
});

test('probesFor skips wildcard hosts and builds star paths', () => {
  const rules = parseRules(LIST);
  const { probes, skipped } = probesFor(rules);
  const urls = probes.map((probe) => probe.url);
  assert.ok(urls.includes('https://igg-games.com/'));
  assert.ok(urls.includes('https://ipcgames.com/ocean-of-games/x'));
  assert.ok(urls.includes('https://github.com/x/xKMSxpicox'));
  assert.equal(urls.filter((url) => url.includes('massgrave')).length, 0);
  assert.ok(skipped.some((row) => row.why === 'wildcard host'));
});

test('a rule with a request type the page cannot send gets no probe', () => {
  const rules = parseRules('||example.com^$script,third-party');
  const { probes, skipped } = probesFor(rules);
  assert.equal(probes.length, 0);
  assert.match(skipped[0].why, /request type/);
});

test('compare separates a default list block from a dead address', () => {
  const probes = [
    { id: 'a', rule: { host: 'alpha.test' } },
    { id: 'b', rule: { host: 'beta.test' } },
    { id: 'c', rule: { host: 'gamma.test' } },
    { id: 'd', rule: { host: 'delta.test' } },
    { id: 'e', rule: { host: 'echo.test' } },
  ];
  const list = { a: 'failed', b: 'failed', c: 'failed', d: 'resolved', e: 'timeout' };
  const bare = { a: 'resolved', b: 'failed', c: 'failed', d: 'resolved', e: 'resolved' };
  const hosts = {
    'beta.test': { state: 'alive', why: 'tcp 443 open' },
    'gamma.test': { state: 'dead', why: 'dns ENOTFOUND' },
  };
  const out = compare(list, bare, probes, hosts);
  assert.deepEqual(out.matched.map((row) => row.id), ['a']);
  assert.deepEqual(out.defaultList.map((row) => row.id), ['b']);
  assert.deepEqual(out.dead.map((row) => row.id), ['c']);
  assert.deepEqual(out.noMatch.map((row) => row.id), ['d']);
  assert.deepEqual(out.unknown.map((row) => row.id), ['e']);
});

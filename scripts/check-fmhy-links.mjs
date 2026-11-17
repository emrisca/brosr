// Compares the Watch directory in landing/index.html with the starred sites in
// FMHY's Stream Aggregators, P-Stream Forks and Anime Streaming sections. The
// landing page carries every named site from a starred bullet, including the
// alternatives joined by "or"; numeric mirror links are not separate entries.
//
//   node scripts/check-fmhy-links.mjs
//   node scripts/check-fmhy-links.mjs --source=.runtime/fmhy-video.md
//   node scripts/check-fmhy-links.mjs --json
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GROUPS = ['Stream Aggregators', 'P-Stream Forks', 'Anime Streaming'];
const SOURCE =
  'https://raw.githubusercontent.com/fmhy/edit/main/docs/video.md';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const cleanName = (value) =>
  String(value || '')
    .replace(/\p{Cf}/gu, '')
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '');
const nameKey = (value) => cleanName(value).toLowerCase();

export function normalizeUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    return `${url.origin.toLowerCase()}${pathname}`;
  } catch {
    return '';
  }
}

function section(markdown, title) {
  const start = new RegExp(`^## ▷ ${title}\\s*$`, 'm').exec(markdown);
  if (!start) throw new Error(`FMHY source has no "${title}" section`);
  const after = markdown.slice(start.index + start[0].length);
  const next = after.search(/^## /m);
  return next < 0 ? after : after.slice(0, next);
}

// A starred bullet names its sites before the first description separator. The
// links labelled 2, 3 or 4 are mirrors of the preceding site, so they are not a
// second name. The "P-Stream Forks" entry points at the section itself.
export function parseFmhy(markdown) {
  const rows = [];
  for (const group of GROUPS) {
    for (const line of section(markdown, group).split(/\r?\n/)) {
      if (!/^\*\s+[🌟⭐]/u.test(line)) continue;
      const sitePart = line.split(' - ')[0];
      for (const hit of sitePart.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
        const name = cleanName(hit[1]);
        const url = hit[2];
        if (!name || /^\d+$/.test(name) || name === 'P-Stream Forks') continue;
        rows.push({ group, name, url, key: nameKey(name), urlKey: normalizeUrl(url) });
      }
    }
  }
  return rows;
}

export function parseLanding(html) {
  const rows = [];
  const sections = html.matchAll(
    /<section class="site-group[^"]*"[^>]*aria-labelledby="[^"]+"[^>]*>([\s\S]*?)<\/section>/g
  );
  for (const sectionHit of sections) {
    const block = sectionHit[1];
    const title =
      (/<h3[^>]*class="site-group-title"[^>]*>([\s\S]*?)<\/h3>/.exec(block) || [])[1] || '';
    const group = cleanName(title.replace(/<[^>]+>/g, ''));
    for (const part of block.split('<a class="site"').slice(1)) {
      const href = /href="([^"]+)"/.exec(part);
      const name = /<span class="site-name">([^<]+)<\/span>/.exec(part);
      if (!href || !name) continue;
      rows.push({
        group,
        name: cleanName(name[1]),
        url: href[1],
        key: nameKey(name[1]),
        urlKey: normalizeUrl(href[1]),
      });
    }
  }
  return rows;
}

export function compare(expected, actual) {
  const problems = [];
  const byGroup = (rows, group) => rows.filter((row) => row.group === group);
  for (const group of GROUPS) {
    const want = byGroup(expected, group);
    const have = byGroup(actual, group);
    const seen = new Set(have.map((row) => row.key));
    const wanted = new Set(want.map((row) => row.key));
    for (const row of want) {
      if (!seen.has(row.key)) problems.push({ kind: 'missing', ...row });
    }
    for (const row of have) {
      if (!wanted.has(row.key)) problems.push({ kind: 'extra', ...row });
    }
    for (const row of want) {
      const found = have.find((entry) => entry.key === row.key);
      if (found && found.urlKey !== row.urlKey) {
        problems.push({ kind: 'changed', ...row, landing: found.url });
      }
    }
  }
  return { problems, counts: GROUPS.map((group) => ({ group, want: byGroup(expected, group).length, have: byGroup(actual, group).length })) };
}

async function load(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`FMHY source returned ${response.status}`);
    return response.text();
  }
  return fs.readFile(path.resolve(source), 'utf8');
}

function option(name, fallback) {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length) || fallback;
  const at = process.argv.indexOf(name);
  if (at < 0) return fallback;
  const value = process.argv[at + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

export async function main() {
  if (process.argv.includes('--help')) {
    console.log('usage: node scripts/check-fmhy-links.mjs [--source=<url-or-file>] [--landing=<file>] [--json]');
    return 0;
  }
  const source = option('--source', SOURCE);
  const landingFile = option('--landing', path.join(root, 'landing', 'index.html'));
  const [markdown, html] = await Promise.all([load(source), fs.readFile(landingFile, 'utf8')]);
  const expected = parseFmhy(markdown);
  const actual = parseLanding(html);
  const { problems, counts } = compare(expected, actual);
  const result = { ok: problems.length === 0, expected: expected.length, actual: actual.length, counts, problems };
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`FMHY links: ${expected.length} expected, ${actual.length} in the landing page`);
    for (const count of counts) console.log(`  ${count.group}: ${count.have}/${count.want}`);
    for (const problem of problems) {
      if (problem.kind === 'changed') {
        console.log(`  changed: ${problem.group} / ${problem.name}: ${problem.url} -> ${problem.landing}`);
      } else {
        console.log(`  ${problem.kind}: ${problem.group} / ${problem.name} ${problem.url}`);
      }
    }
    if (problems.length === 0) console.log('PASS: every starred FMHY link is present.');
  }
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`FMHY check failed: ${error.message}`);
      process.exit(2);
    });
}

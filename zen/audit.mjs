// Audits every rule the list holds, not only the whole host ones. A blocked
// request and a dead address both fail, so each probe runs twice: once on a
// profile that holds the list and once on a bare profile. A host that fails on
// both profiles is then asked from Node, which has no filter list, so a default
// list block and a dead address do not look the same.
import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LISTS, RUNTIME, fetchListText, withBrowser } from './safe-browsing.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Rules fall into five shapes. The parser keeps the shape, because a cosmetic
// rule and a host rule need different evidence.
export function parseRules(text) {
  const whole = new Map();
  const url = [];
  const options = [];
  const cosmetic = [];
  const other = [];
  for (const line of text.split('\n')) {
    const rule = line.trim();
    if (!rule || rule.startsWith('!') || rule.startsWith('[')) continue;
    const cosmeticHit = rule.match(/^([a-z0-9.*_-]+)(#@#|#\?#|#\$#|##)(.+)$/i);
    if (cosmeticHit) {
      cosmetic.push({ host: cosmeticHit[1].toLowerCase(), kind: cosmeticHit[2], rule });
      continue;
    }
    const dollar = rule.indexOf('$');
    const body = dollar === -1 ? rule : rule.slice(0, dollar);
    const tail = dollar === -1 ? '' : rule.slice(dollar + 1);
    const scheme = body.match(/^\|(https?:\/\/[^$]+)$/i);
    if (scheme) {
      let parsed;
      try {
        parsed = new URL(scheme[1]);
      } catch {
        other.push(rule);
        continue;
      }
      const host = parsed.hostname.toLowerCase();
      if (!tail) url.push({ host, path: parsed.pathname + parsed.search, rule });
      else options.push({ host, path: parsed.pathname, options: parseOptions(tail), rule });
      continue;
    }
    const hostHit = body.match(/^\|\|([a-z0-9.*_-]+)(.*)$/i);
    if (!hostHit) {
      other.push(rule);
      continue;
    }
    const host = hostHit[1].toLowerCase();
    const rest = hostHit[2].replace(/^\^/, '');
    if (!tail && !rest) {
      whole.set(host, (whole.get(host) || 0) + 1);
      continue;
    }
    if (!tail) {
      url.push({ host, path: rest, rule });
      continue;
    }
    options.push({ host, path: rest, options: parseOptions(tail), rule });
  }
  return {
    whole: [...whole.entries()].map(([host, count]) => ({ host, count })),
    url,
    options,
    cosmetic,
    other,
  };
}

export function parseOptions(text) {
  const names = [];
  const domains = [];
  for (const part of text.split(',')) {
    const item = part.trim();
    if (!item) continue;
    if (item.toLowerCase().startsWith('domain=')) {
      domains.push(...item.slice(7).split('|'));
      continue;
    }
    names.push(item);
  }
  return { names, domains };
}

// A wildcard host names no address, so a probe cannot stand in for the rule.
// A wildcard in the path keeps its literal text, and each star becomes one
// character, which any star matches.
function concreteUrl(host, pathPart) {
  if (!host || host.includes('*')) return null;
  const clean = pathPart && pathPart !== '^' ? pathPart : '/';
  const lead = clean.startsWith('/') ? '' : '/';
  return `https://${host}${lead}${clean.replace(/\*/g, 'x')}`;
}

// Only request types the page can send are exercised. The page sends fetch
// requests, which count as xhr and as first party from the loopback origin.
const PROBE_OPTIONS = ['all', 'xhr', 'xmlhttprequest', 'document'];

export function probesFor(rules) {
  const probes = [];
  const skipped = [];
  for (const rule of rules.whole) {
    probes.push({ id: `host:${rule.host}`, kind: 'whole', rule, url: `https://${rule.host}/` });
  }
  for (const rule of rules.url) {
    const built = concreteUrl(rule.host, rule.path);
    if (!built) {
      skipped.push({ kind: 'url', rule: rule.rule, why: 'wildcard host' });
      continue;
    }
    probes.push({ id: `url:${probes.length}`, kind: 'url', rule, url: built });
  }
  for (const rule of rules.options) {
    const names = rule.options.names.map((name) => name.toLowerCase());
    if (!names.some((name) => PROBE_OPTIONS.includes(name))) {
      skipped.push({
        kind: 'option',
        rule: rule.rule,
        why: `options ${names.join(',')} need a request type the page does not send`,
      });
      continue;
    }
    const built = concreteUrl(rule.host, rule.path);
    if (!built) {
      skipped.push({ kind: 'option', rule: rule.rule, why: 'wildcard host' });
      continue;
    }
    probes.push({ id: `opt:${probes.length}`, kind: 'option', rule, url: built });
  }
  return { probes, skipped };
}

function auditPage(probes, timeout, workers) {
  const rows = probes.map((probe) => ({ id: probe.id, url: probe.url }));
  return `<!doctype html>
<meta charset="utf-8">
<title>audit</title>
<script>
(async () => {
  const rows = ${JSON.stringify(rows)};
  const out = {};
  let next = 0;
  const one = async (row) => {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), ${timeout});
    try {
      await fetch(row.url, { mode: 'no-cors', cache: 'no-store', signal: stop.signal });
      out[row.id] = 'resolved';
    } catch (error) {
      out[row.id] = error.name === 'AbortError' ? 'timeout' : 'failed';
    } finally {
      clearTimeout(timer);
    }
  };
  const worker = async () => {
    while (next < rows.length) await one(rows[next++]);
  };
  await Promise.all(Array.from({ length: ${workers} }, worker));
  window.__audit = JSON.stringify(out);
})();
</script>
`;
}

async function serve(html) {
  const server = http.createServer((req, res) => {
    if (req.url === '/ok.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('control');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function evaluate(bidi, context, expression) {
  try {
    const res = await bidi.cmd('script.evaluate', {
      expression,
      target: { context },
      awaitPromise: true,
      resultOwnership: 'none',
    });
    if (res.type === 'exception') return undefined;
    return res.result ? res.result.value : undefined;
  } catch {
    return undefined;
  }
}

// The loopback control resolves on both profiles, so a pass that blocks every
// request, or a machine with no network, fails here instead of counting as a
// block for every rule.
export async function auditProfile(profile, probes, options = {}) {
  const timeout = Number(options.timeout || 4000);
  const workers = Number(options.workers || 12);
  const all = [...probes, { id: 'control', url: '/ok.txt' }];
  const site = await serve(auditPage(all, timeout, workers));
  try {
    return await withBrowser(profile, options, async (bidi) => {
      const context = (await bidi.cmd('browsingContext.getTree', {})).contexts[0].context;
      // The engine compiles its lists after start, so the page waits.
      await sleep(Number(options.settle || 12000));
      await bidi.cmd('browsingContext.navigate', { context, url: site.url, wait: 'complete' });
      const end = Date.now() + Number(options.wait || 300000);
      while (Date.now() < end) {
        const raw = await evaluate(bidi, context, 'window.__audit ? window.__audit : ""');
        if (raw) {
          const seen = JSON.parse(raw);
          if (seen.control !== 'resolved') {
            throw new Error(`the control request read ${seen.control}, so the page has no network`);
          }
          return seen;
        }
        await sleep(1000);
      }
      throw new Error('the audit page never finished');
    });
  } finally {
    await site.close();
  }
}

// Node has no filter list. A lookup that fails or a port that refuses leaves
// the address dead, and anything else is a live host that a default list
// blocked.
export async function hostState(host, options = {}) {
  const timeout = Number(options.timeout || 5000);
  let lookup;
  try {
    lookup = await Promise.race([
      dns.lookup(host).then(() => 'ok'),
      sleep(timeout).then(() => 'dns timeout'),
    ]);
  } catch (error) {
    lookup = `dns ${error.code || error.message}`;
  }
  if (lookup !== 'ok') return { host, state: 'dead', why: lookup };
  const tcp = await new Promise((resolve) => {
    const socket = net.connect({ host, port: 443 });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish('open'));
    socket.once('timeout', () => finish('tcp timeout'));
    socket.once('error', (error) => finish(`tcp ${error.code || error.message}`));
  });
  return tcp === 'open'
    ? { host, state: 'alive', why: 'tcp 443 open' }
    : { host, state: 'dead', why: tcp };
}

export async function checkHosts(hosts, options = {}) {
  const workers = Number(options.workers || 8);
  const out = {};
  const list = [...new Set(hosts)];
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const host = list[next++];
      out[host] = await hostState(host, options);
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, list.length) }, worker));
  return out;
}

// A row that failed on both profiles needs the host check before it earns a
// label. `alive` means a default list blocked it, and `dead` means the address
// explains the failure.
export function compare(list, bare, probes, hosts = {}) {
  const out = { matched: [], defaultList: [], dead: [], noMatch: [], unknown: [] };
  for (const probe of probes) {
    const one = list[probe.id];
    const two = bare[probe.id];
    if (one === 'failed' && two !== 'failed') {
      out.matched.push(probe);
      continue;
    }
    if (one === 'resolved' && two === 'resolved') {
      out.noMatch.push(probe);
      continue;
    }
    if (one === 'failed' && two === 'failed') {
      const seen = hosts[probe.rule.host] || hosts[probe.host];
      if (seen && seen.state === 'alive') out.defaultList.push({ ...probe, why: seen.why });
      else if (seen && seen.state === 'dead') out.dead.push({ ...probe, why: seen.why });
      else out.unknown.push({ ...probe, list: one, bare: two, why: 'no host check' });
      continue;
    }
    out.unknown.push({ ...probe, list: one, bare: two });
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => {
    const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : fallback;
  };
  const listProfile = arg('list', '');
  const bareProfile = arg('bare', '');
  if (!listProfile || !bareProfile) {
    console.log('[audit] pass --list=<dir> and --bare=<dir>');
    process.exit(1);
  }
  const text = await fetchListText(LISTS[0], RUNTIME);
  const rules = parseRules(text);
  const built = probesFor(rules);
  const limit = Number(arg('max', '0'));
  const probes = limit > 0 ? built.probes.slice(0, limit) : built.probes;
  console.log(
    `[audit] rules whole ${rules.whole.length}, path ${rules.url.length}, ` +
      `option ${rules.options.length}, cosmetic ${rules.cosmetic.length}, other ${rules.other.length}`
  );
  console.log(`[audit] ${probes.length} probes, ${built.skipped.length} rules without a probe`);
  const one = await auditProfile(path.resolve(listProfile), probes, {
    port: Number(arg('port', '9431')),
    timeout: Number(arg('timeout', '4000')),
  });
  const two = await auditProfile(path.resolve(bareProfile), probes, {
    port: Number(arg('port', '9431')) + 1,
    timeout: Number(arg('timeout', '4000')),
  });
  const both = probes.filter((probe) => one[probe.id] === 'failed' && two[probe.id] === 'failed');
  const hosts = await checkHosts(
    both.map((probe) => probe.rule.host),
    { timeout: Number(arg('check', '5000')) }
  );
  const result = compare(one, two, probes, hosts);
  console.log(`[audit] blocked by the list ${result.matched.length}`);
  console.log(`[audit] blocked by a default list ${result.defaultList.length}`);
  console.log(`[audit] dead address ${result.dead.length}`);
  console.log(`[audit] no match either way ${result.noMatch.length}`);
  console.log(`[audit] uncertain ${result.unknown.length}`);
  for (const row of result.noMatch.slice(0, 20)) console.log(`[audit] no match ${row.url}`);
  for (const row of result.unknown.slice(0, 20)) {
    console.log(`[audit] uncertain ${row.url} list=${row.list} bare=${row.bare}`);
  }
  for (const row of built.skipped) console.log(`[audit] no probe ${row.why}: ${row.rule}`);
  const cosmeticHosts = new Set(rules.cosmetic.map((rule) => rule.host));
  console.log(
    `[audit] cosmetic ${rules.cosmetic.length} on ${cosmeticHosts.size} hosts, ` +
      'a network probe cannot see them'
  );
  const file = path.join(RUNTIME, 'audit.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ when: new Date().toISOString(), rules, probes, hosts, ...result }, null, 2) + '\n'
  );
  console.log(`[audit] wrote ${file}`);
}

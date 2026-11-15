// The room profile ships with a safe browsing set: uBlock Origin, SponsorBlock,
// AdGuard Extra and P-Stream. Each one is a signed XPI, so each one goes in as a
// file under the profile's extensions folder. One headless pass then writes the
// FMHY list into uBlock Origin's storage. A second pass proves what survived.
// The pass writes a marker, so a later start opens no window.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BiDi } from '../spike/bidi.mjs';
import { findZen } from './binary.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const RUNTIME = process.env.BROSR_ZEN_RUNTIME || path.join(here, '.runtime');

// Full uBlock Origin is the reason this build is Firefox based. The other three
// complete the set: SponsorBlock skips sponsor segments, AdGuard Extra fights
// anti adblock scripts, and P-Stream carries the media site controls.
export const EXTENSIONS = [
  {
    id: 'uBlock0@raymondhill.net',
    name: 'uBlock Origin',
    file: 'uBlock0@raymondhill.net.xpi',
    cache: 'ubo.xpi',
    url: 'https://addons.mozilla.org/firefox/downloads/latest/ublock-origin/latest.xpi',
    minBytes: 100000,
  },
  {
    id: 'sponsorBlocker@ajay.app',
    name: 'SponsorBlock',
    file: 'sponsorBlocker@ajay.app.xpi',
    cache: 'sponsorblock.xpi',
    url: 'https://addons.mozilla.org/firefox/downloads/latest/sponsorblock/latest.xpi',
    minBytes: 200000,
  },
  {
    id: 'adguard-extra@adguard.com',
    name: 'AdGuard Extra',
    file: 'adguard-extra@adguard.com.xpi',
    cache: 'adguard-extra.xpi',
    url: 'https://static.adtidy.org/extensions/adguardextra/release/firefox.xpi',
    minBytes: 200000,
  },
  {
    id: '{be961bb7-0f52-4600-a46a-3de5e8829f68}',
    name: 'P-Stream extension',
    // The profile scan reads this name, so it carries the add-on id.
    file: '{be961bb7-0f52-4600-a46a-3de5e8829f68}.xpi',
    cache: 'p-stream.xpi',
    // AMO serves the signed Gecko build, and a profile with signature checking
    // on takes only that one. The Chrome Web Store build does not install here.
    url: 'https://addons.mozilla.org/firefox/downloads/latest/p-stream-extension-v1/latest.xpi',
    minBytes: 200000,
  },
];

// The FMHY documentation names filterlist.txt as the uBlock Origin build. That
// build blocks the unsafe sites and the not recommended ones, which is the set
// this profile wants. The text lands in uBlock's own filters, so a room filters
// with no network.
export const LISTS = [
  {
    key: 'fmhy',
    title: 'FMHY Filterlist',
    url: 'https://raw.githubusercontent.com/fmhy/FMHYFilterlist/main/filterlist.txt',
    page: 'https://github.com/fmhy/FMHYFilterlist',
    minBytes: 2000,
  },
];

export const MARKER = 'brosr-safe-browsing.json';

export function cachePath(entry, dir = RUNTIME) {
  return path.join(dir, entry.cache);
}

export function cachedCopy(entry, dir = RUNTIME) {
  try {
    const size = fs.statSync(cachePath(entry, dir)).size;
    return size >= entry.minBytes ? cachePath(entry, dir) : null;
  } catch {
    return null;
  }
}

// The XPI is fetched at setup, not shipped in the repository. A machine without
// network access keeps its old copy, and a room still starts.
async function download(entry, dir) {
  const hit = cachedCopy(entry, dir);
  if (hit) return hit;
  fs.mkdirSync(dir, { recursive: true });
  const res = await fetch(entry.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length < entry.minBytes) throw new Error(`${body.length} bytes is too small`);
  fs.writeFileSync(cachePath(entry, dir), body);
  return cachePath(entry, dir);
}

export async function stageExtensions(dir = RUNTIME) {
  const ready = [];
  const missing = [];
  for (const entry of EXTENSIONS) {
    try {
      await download(entry, dir);
      ready.push(entry.id);
    } catch (error) {
      missing.push({ id: entry.id, name: entry.name, why: error.message });
    }
  }
  return { ready, missing };
}

export function installExtensions(profile, dir = RUNTIME) {
  const dest = path.join(profile, 'extensions');
  fs.mkdirSync(dest, { recursive: true });
  const installed = [];
  for (const entry of EXTENSIONS) {
    const source = cachedCopy(entry, dir);
    if (!source) continue;
    fs.copyFileSync(source, path.join(dest, entry.file));
    installed.push(entry.id);
  }
  return installed;
}

// The filter text is cached beside the XPIs, so a rerun needs no network. A
// refresh option skips the cache and takes the upstream text.
export async function fetchListText(list, dir = RUNTIME, options = {}) {
  const file = path.join(dir, `${list.key}.txt`);
  if (!options.refresh) {
    try {
      const hit = fs.readFileSync(file, 'utf8');
      if (hit.length >= list.minBytes) return hit;
    } catch {
      // No cached copy yet.
    }
  }
  const res = await fetch(list.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length < list.minBytes) throw new Error(`${text.length} bytes is too small`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, text);
  return text;
}

export function markerPath(profile) {
  return path.join(profile, MARKER);
}

export function readMarker(profile) {
  try {
    return JSON.parse(fs.readFileSync(markerPath(profile), 'utf8'));
  } catch {
    return null;
  }
}

// Firefox keeps the add-on id to uuid map in one pref. A profile that has run
// once holds it, and the pref file lands on disk a moment after startup.
export function prefUuids(profile) {
  try {
    const text = fs.readFileSync(path.join(profile, 'prefs.js'), 'utf8');
    const hit = text.match(/user_pref\("extensions\.webextensions\.uuids",\s*"((?:[^"\\]|\\.)*)"\)/);
    if (!hit) return {};
    const inner = JSON.parse(`"${hit[1]}"`);
    return typeof inner === 'string' ? JSON.parse(inner) : inner;
  } catch {
    return {};
  }
}

// Firefox writes one entry per installed extension here at startup.
export function readExtensions(profile) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(path.join(profile, 'extensions.json'), 'utf8'));
  } catch {
    return {};
  }
  const map = {};
  for (const addon of doc.addons || []) {
    map[addon.id] = {
      version: addon.version,
      active: Boolean(addon.active),
      uuid: addon.uuid || null,
      signed: addon.signedState,
    };
  }
  return map;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // The window already left.
  }
}

async function waitFor(check, timeoutMs, stepMs, label) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    try {
      const hit = await check();
      if (hit) return hit;
    } catch (error) {
      last = error;
    }
    await sleep(stepMs);
  }
  throw new Error(`${label} timed out${last ? `: ${last.message}` : ''}`);
}

async function evaluate(bidi, context, expression) {
  const res = await bidi.cmd('script.evaluate', {
    expression,
    target: { context },
    awaitPromise: true,
    resultOwnership: 'none',
  });
  if (res.type === 'exception') {
    throw new Error('page exception: ' + JSON.stringify(res.exceptionDetails).slice(0, 300));
  }
  return res.result ? res.result.value : undefined;
}

// uBlock Origin loads each dashboard pane in its own frame. BiDi lists that
// frame beside the tab, so the pane is found by its URL.
async function allContexts(bidi) {
  const tree = await bidi.cmd('browsingContext.getTree', {});
  const flat = [];
  const walk = (nodes) => {
    for (const node of nodes || []) {
      flat.push(node);
      if (node.children) walk(node.children);
    }
  };
  walk(tree.contexts);
  return flat;
}

async function openPane(bidi, context, uuid, pane) {
  await bidi.cmd('browsingContext.navigate', {
    context,
    url: `moz-extension://${uuid}/dashboard.html#${pane}.html`,
    wait: 'complete',
  });
  const frame = await waitFor(async () => {
    const nodes = await allContexts(bidi);
    return (
      nodes.find((node) => node.context !== context && String(node.url).includes(`/${pane}.html`)) ||
      null
    );
  }, 20000, 400, `the ${pane} pane`).catch(() => null);
  if (!frame) throw new Error(`the ${pane} pane opened no frame`);
  return frame;
}

// The dashboard page runs inside uBlock, so it can write the same storage the
// blocker reads at startup. That skips the dashboard widgets, which throw when
// a script drives them.
// uBlock keeps My filters in its own store and compiles a copy beside it, so a
// storage write alone leaves the engine on the old copy. The dashboard message
// pair below is the path its own Apply button uses: writeUserFilters saves and
// reloadAllFilters rebuilds the engine. The storage keys stay as a fallback for
// a build without the message channel.
const writeFilters = (text) => `(async () => {
  try {
    const api = typeof browser !== 'undefined' ? browser : chrome;
    const all = await api.storage.local.get();
    const selected = new Set(all.selectedFilterLists || []);
    selected.add('user-filters');
    const stale = Object.keys(all).filter(
      (key) => key === 'cache/compiled/user-filters' || key.startsWith('cache/selfie/')
    );
    if (stale.length) await api.storage.local.remove(stale);
    // The asset key carries the rules for the current build, and the legacy
    // setting stays for a build that still reads it.
    await api.storage.local.set({
      userFilters: ${JSON.stringify(text)},
      'user-filters': ${JSON.stringify(text)},
      selectedFilterLists: [...selected],
    });
    let via = 'settings write';
    if (typeof vAPI !== 'undefined' && vAPI.messaging) {
      const details = await vAPI.messaging.send('dashboard', { what: 'readUserFilters' });
      const enabled = details && details.enabled === false ? false : true;
      const saved = await vAPI.messaging.send('dashboard', {
        what: 'writeUserFilters',
        content: ${JSON.stringify(text)},
        enabled,
        trusted: false,
      });
      if (saved && saved.error) throw new Error(saved.error);
      await vAPI.messaging.send('dashboard', { what: 'reloadAllFilters' });
      via = 'dashboard message, engine reloaded';
    }
    const after = await api.storage.local.get(['userFilters', 'user-filters', 'selectedFilterLists']);
    return JSON.stringify({
      filters: (after['user-filters'] || after.userFilters || '').length,
      selected: (after.selectedFilterLists || []).length,
      removed: stale.length,
      via,
    });
  } catch (error) {
    return JSON.stringify({ error: error.message });
  }
})()`;

const readStoredFilters = `(async () => {
  const api = typeof browser !== 'undefined' ? browser : chrome;
  const all = await api.storage.local.get(['userFilters', 'user-filters', 'selectedFilterLists']);
  return JSON.stringify({
    filters: (all['user-filters'] || all.userFilters || '').length,
    legacy: (all.userFilters || '').length,
    selected: (all.selectedFilterLists || []).length,
  });
})()`;

const readPaneFilters = `(() => {
  const wrapper = document.querySelector('.CodeMirror');
  if (wrapper && wrapper.CodeMirror) return wrapper.CodeMirror.getValue().length;
  const area = document.querySelector('#userFilters');
  return area ? area.value.length : -1;
})()`;

// The filter box is a CodeMirror editor. The text goes through the editor
// instance, because writing the textarea by hand leaves the editor out of step.
const typeFilters = (text) => `(() => {
  try {
    const wrapper = document.querySelector('.CodeMirror');
    if (wrapper && wrapper.CodeMirror && typeof wrapper.CodeMirror.setValue === 'function') {
      wrapper.CodeMirror.setValue(${JSON.stringify(text)});
      // The editor exposes no save(), so the textarea takes the text by hand.
      // No input event, because the editor throws when one arrives.
      const area = document.querySelector('#userFilters');
      if (area) area.value = ${JSON.stringify(text)};
    } else {
      const area = document.querySelector('#userFilters');
      if (!area) return 'no filter box';
      area.value = ${JSON.stringify(text)};
      area.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const apply = document.querySelector('#userFiltersApply') || document.querySelector('#buttonApply');
    if (!apply) return 'no apply button';
    // The pane enables the button on a change. A build that misses the event
    // still takes the click, so the attribute goes first.
    if (apply.disabled) apply.removeAttribute('disabled');
    apply.click();
    return 'applied ' + (document.querySelector('#userFilters').value.length);
  } catch (error) {
    return 'error: ' + error.message;
  }
})()`;

// The list names hosts, so a plain request to one of them answers whether the
// engine holds the list. Both hosts sit in the FMHY text and in no default list.
export const PROBES = ['igg-games.com', 'igg-games.cc'];

function probePage(probes) {
  const urls = probes.map((host) => `https://${host}/probe.png`);
  return `<!doctype html>
<meta charset="utf-8">
<title>probe</title>
<script>
(async () => {
  const rows = [];
  for (const url of ${JSON.stringify(urls)}) {
    try {
      const res = await fetch(url, { mode: 'no-cors', cache: 'no-store' });
      rows.push({ url, state: 'resolved', detail: res.type });
    } catch (error) {
      rows.push({ url, state: 'rejected', detail: error.name });
    }
  }
  let control;
  try {
    const res = await fetch('/ok.txt', { mode: 'no-cors', cache: 'no-store' });
    control = { state: 'resolved', detail: res.type };
  } catch (error) {
    control = { state: 'rejected', detail: error.name };
  }
  window.__probe = { rows, control };
})();
</script>
`;
}

async function probeServer(probes) {
  const html = probePage(probes);
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

// A blocked request rejects, and the loopback control still resolves. The rows
// are the counter, so a marker holds a measurement and not a guess. A fresh
// profile compiles its lists for a while, so the page reloads until the engine
// answers or the attempts run out.
export async function runProbes(bidi, context, options = {}) {
  const tries = Number(options.tries || 6);
  const gap = Number(options.gap || 5000);
  const site = await probeServer(PROBES);
  let last = null;
  try {
    for (let attempt = 0; attempt < tries; attempt += 1) {
      await bidi.cmd('browsingContext.navigate', { context, url: site.url, wait: 'complete' });
      const end = Date.now() + 30000;
      let seen = null;
      while (Date.now() < end && !seen) {
        const raw = await evaluate(
          bidi,
          context,
          'window.__probe ? JSON.stringify(window.__probe) : ""'
        );
        if (raw) seen = JSON.parse(raw);
        else await sleep(500);
      }
      if (seen) {
        const rows = seen.rows.map((row) => ({
          url: row.url,
          blocked: row.state === 'rejected',
          detail: row.detail,
        }));
        last = {
          rows,
          blocked: rows.filter((row) => row.blocked).length,
          want: rows.length,
          control: seen.control,
        };
        if (last.blocked === last.want) return last;
      }
      if (attempt < tries - 1) await sleep(gap);
    }
    if (!last) throw new Error('the probe page never finished');
    return last;
  } finally {
    await site.close();
  }
}

async function addList(bidi, context, uuid, list, text) {
  await bidi.cmd('browsingContext.navigate', {
    context,
    url: `moz-extension://${uuid}/dashboard.html`,
    wait: 'complete',
  });
  const raw = await evaluate(bidi, context, writeFilters(text));
  const out = JSON.parse(raw);
  if (out.error) throw new Error(out.error);
  if (out.filters !== text.length) {
    throw new Error(`uBlock stored ${out.filters} of ${text.length} characters`);
  }
  return {
    key: list.key,
    title: list.title,
    url: list.url,
    page: list.page,
    characters: out.filters,
    lines: text.split('\n').length,
    via: `${out.via}, ${out.selected} lists selected, ${out.removed} caches dropped`,
  };
}

async function connect(port, timeoutMs = 60000) {
  let last = null;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      return await new BiDi(`ws://127.0.0.1:${port}/session`).connect();
    } catch (error) {
      last = error;
      await sleep(400);
    }
  }
  throw new Error(`no BiDi on ${port}: ${last ? last.message : 'unknown'}`);
}

// A fresh headless window on the profile. The caller gets the BiDi session and
// the window closes on the way out, whatever the work does.
export async function withBrowser(profile, options, work) {
  const zen = options.zen || findZen();
  if (!zen) throw new Error('no Zen binary found');
  const port = Number(options.port || 9341);
  const child = spawn(
    zen,
    [
      '--profile', profile,
      '--headless',
      '--no-remote',
      '--new-instance',
      '--remote-debugging-port', String(port),
      'about:blank',
    ],
    {
      stdio: 'ignore',
      env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
    }
  );
  let bidi = null;
  try {
    bidi = await connect(port);
    return await work(bidi);
  } finally {
    // A graceful close lets each extension flush its stored settings to disk.
    // A write pass skips it, because uBlock would flush its own older copy of
    // the same settings back over the new one.
    if (bidi) {
      if (!options.hardClose) await bidi.cmd('browser.close').catch(() => {});
      bidi.close();
      await sleep(options.hardClose ? 800 : 3000);
    }
    killTree(child.pid);
  }
}

async function activeExtensions(bidi, profile, log) {
  const state = await waitFor(() => {
    const map = readExtensions(profile);
    return EXTENSIONS.every((entry) => map[entry.id] && map[entry.id].active) ? map : null;
  }, 60000, 700, 'the extension list');
  log(`extensions active: ${EXTENSIONS.map((entry) => entry.name).join(', ')}`);
  const tree = await bidi.cmd('browsingContext.getTree', {});
  const context = tree.contexts[0] && tree.contexts[0].context;
  if (!context) throw new Error('no browsing context');
  return { state, context };
}

// One call for the start path: stage what is missing, install the files, then run
// the headless pass unless a marker says the work is done.
export async function prepareSafeBrowsing(profile, options = {}) {
  // The setup screen follows these steps. Each number is the stage the work is
  // about to do, so a long fetch still shows movement.
  const stage = typeof options.report === 'function' ? options.report : () => {};
  stage(2, 'Fetching the add-ons');
  const staged = await stageExtensions();
  stage(3, 'Installing the add-ons');
  const installed = installExtensions(profile);
  const report = { staged, installed, configured: false, marker: readMarker(profile) };
  if (!options.configure) return report;
  if (staged.missing.length) return report;
  if (report.marker && !options.force && !options.refresh) {
    report.configured = true;
    return report;
  }
  try {
    report.marker = await configure(profile, options);
    report.configured = true;
  } catch (error) {
    report.error = error.message;
  }
  return report;
}

export async function configure(profile, options = {}) {
  const log = options.log || (() => {});
  const port = Number(options.port || 9341);
  const result = {
    when: new Date().toISOString(),
    profile,
    extensions: [],
    lists: [],
    scripts: [],
    verified: null,
  };

  // The write window closes hard, because uBlock would flush its own older
  // settings over the new ones on a graceful close.
  await withBrowser(profile, { ...options, port, hardClose: true }, async (bidi) => {
    log(`browser started on ${port}`);
    const { state, context } = await activeExtensions(bidi, profile, log);
    result.extensions = EXTENSIONS.map((entry) => ({
      id: entry.id,
      name: entry.name,
      version: state[entry.id].version,
      active: state[entry.id].active,
      signed: state[entry.id].signed,
    }));

    const map = await waitFor(() => {
      const seen = prefUuids(profile);
      return seen[EXTENSIONS[0].id] ? seen : null;
    }, 45000, 1000, 'the extension ids');

    const text = await fetchListText(LISTS[0], RUNTIME, { refresh: options.refresh });
    log(`uBlock list ${LISTS[0].key} fetched, ${text.length} characters`);
    const report = await addList(bidi, context, map[EXTENSIONS[0].id], LISTS[0], text);
    result.lists.push(report);
    log(`uBlock pane said: ${report.via}`);
    log(`uBlock list ${LISTS[0].key} written`);
  });

  // A new window reads the stored settings, so this proves the write landed.
  const verifyPort = port + 1;
  result.verified = await withBrowser(profile, { ...options, port: verifyPort }, async (bidi) => {
    log(`verifying on ${verifyPort}`);
    await activeExtensions(bidi, profile, log);
    const map = prefUuids(profile);
    const text = await fetchListText(LISTS[0], RUNTIME, { refresh: options.refresh });
    const context = (await bidi.cmd('browsingContext.getTree', {})).contexts[0].context;
    await bidi.cmd('browsingContext.navigate', {
      context,
      url: `moz-extension://${map[EXTENSIONS[0].id]}/dashboard.html`,
      wait: 'complete',
    });
    let stored = null;
    const characters = await waitFor(async () => {
      stored = JSON.parse(await evaluate(bidi, context, readStoredFilters));
      return stored.filters >= text.length - 5 ? stored.filters : null;
    }, 30000, 700, 'the stored filters').catch(() => (stored ? stored.filters : 0));
    if (!(characters >= text.length - 5)) {
      throw new Error(`the stored filters read ${characters} of ${text.length} characters`);
    }
    // The engine needs a moment after start, so the probe waits for it.
    await sleep(Number(options.settle || 12000));
    const probe = await runProbes(bidi, context);
    log(`probes blocked ${probe.blocked} of ${probe.want}, control ${probe.control.state}`);
    return {
      filters: characters,
      wantFilters: text.length,
      selected: stored ? stored.selected : null,
      blocked: probe.blocked,
      probes: probe.rows,
      control: probe.control,
      scripts: [],
    };
  });

  if (result.verified.filters < result.verified.wantFilters - 50) {
    throw new Error(
      `the filters did not persist: ${result.verified.filters} of ${result.verified.wantFilters} characters`
    );
  }
  // Stored text is not enough. The engine must block a request, or the pass
  // reports a failure instead of a quiet success.
  if (!result.verified.blocked) {
    throw new Error('the list is stored but no probe was blocked');
  }
  // The install page is the only path a signed build offers, so a missing list
  // entry is reported and does not throw away the rest of the pass.
  result.scriptsVerified = result.verified.scripts.length;

  fs.writeFileSync(markerPath(profile), JSON.stringify(result, null, 2) + '\n');
  return result;
}

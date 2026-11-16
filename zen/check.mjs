// Headless proof that a room runs inside Zen. Starts the spike relay, builds
// the bridge with the room panel, installs it over WebDriver BiDi, reads the
// dataset and then checks the panel's own render report and grant action.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BiDi } from '../spike/bidi.mjs';
import { buildXpi } from './package.mjs';
import { findZen, writeProfile } from './profile.mjs';
import { dockPanel } from './chrome.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const spike = path.join(here, '..', 'spike');
const bridge = path.join(here, '..', 'bridge');
const runtime = path.join(here, '.runtime');
const PORT = Number(process.env.BROSR_ZEN_BIDI || 9334);
const MARIONETTE = Number(process.env.BROSR_ZEN_MARIONETTE || 2834);
const RELAY = 8787;
const PEER = 'p2';
const PEER_NAME = 'Peer Two';

const arg = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log(...args);

// Zen starts child processes that outlive the parent. taskkill /T takes the
// whole tree, so a headless run leaves no browser behind.
function killTree(child) {
  if (!child) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  if (child.exitCode === null) child.kill('SIGKILL');
}

// The panel must keep its text readable against its own surface, whatever the
// browser theme supplies. The page reports both colours, and this reads them.
function contrastRatio(bg, fg) {
  // A computed token can be `rgb(...)` or the wide `color(srgb ...)` form. Both
  // reach this reader, so a missing parse can never hide a pale pair.
  const channels = (value) => {
    const text = String(value).trim();
    const hit = text.match(/rgba?\(([^)]+)\)/);
    if (hit) {
      const parts = hit[1]
        .split(/[,/ ]+/)
        .filter(Boolean)
        .map(Number);
      return parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)
        ? parts.slice(0, 3)
        : null;
    }
    const wide = text.match(/^color\(\s*[a-z0-9-]+\s+([^)]+)\)$/i);
    if (!wide) return null;
    const parts = wide[1]
      .split(/[\s/]+/)
      .filter(Boolean)
      .map(Number);
    return parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)
      ? parts.slice(0, 3).map((part) => Math.round(Math.min(1, Math.max(0, part)) * 255))
      : null;
  };
  const luminance = (rgb) => {
    const [r, g, b] = rgb.map((value) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = channels(bg);
  const b = channels(fg);
  if (!a || !b) return null;
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The lane installs the same file set as the release. One list, so a module
// added to the package can never be missing from this run.
const XPI = path.join(runtime, 'bridge-zen.xpi');

function readIni(zen) {
  for (const base of [path.dirname(zen), path.join(path.dirname(zen), '..')]) {
    const file = path.join(base, 'application.ini');
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const grab = (key) => (text.match(new RegExp(`^${key}=(.*)$`, 'm')) || [])[1] || null;
    return {
      version: grab('Version'),
      buildId: grab('BuildID'),
      source: grab('SourceStamp'),
      engine: grab('MinVersion'),
    };
  }
  return { version: null, buildId: null, source: null, engine: null };
}

async function waitHealth() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${RELAY}/health`);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await sleep(100);
  }
  throw new Error('relay did not answer on 8787');
}

async function connect(timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      return await new BiDi(`ws://127.0.0.1:${PORT}/session`).connect();
    } catch (error) {
      last = error;
      await sleep(400);
    }
  }
  throw new Error(`no BiDi on ${PORT}: ${last ? last.message : 'unknown'}`);
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

async function readDataset(bidi, context) {
  const raw = await evaluate(
    bidi,
    context,
    'JSON.stringify({ data: document.documentElement.dataset.brosr || "", error: document.documentElement.dataset.brosrError || "" })'
  );
  const parsed = JSON.parse(raw);
  if (parsed.error) throw new Error('core error: ' + parsed.error);
  return parsed.data ? JSON.parse(parsed.data) : null;
}

async function waitForDataset(bidi, context, predicate, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    last = await readDataset(bidi, context).catch(() => null);
    if (last && predicate(last)) return last;
    await sleep(300);
  }
  return last;
}

// The panel reports itself through the background page, and the content
// script copies that report into the dataset. The grant arrives last, so that
// is the condition to wait for.
async function readPanel(bidi, panelContext) {
  const raw = await evaluate(
    bidi,
    panelContext,
    "JSON.stringify({ notice: document.getElementById('notice').textContent, control: !document.getElementById('control').hidden, names: [...document.querySelectorAll('#peers .name')].map((node) => node.textContent), grantedPeers: [...document.querySelectorAll('#peers li')].filter((node) => node.dataset.granted === '1').map((node) => node.dataset.peer), history: [...document.querySelectorAll('#history li')].map((node) => node.textContent), state: document.getElementById('dot').dataset.state, room: document.getElementById('room').textContent, invite: document.getElementById('invite').value, count: document.getElementById('count').textContent, playback: document.getElementById('playback').textContent, relay: document.getElementById('relay').textContent, inviteCopy: document.getElementById('invite-copy').textContent, inviteRow: (() => { const a = document.getElementById('invite').getBoundingClientRect(); const b = document.getElementById('invite-copy').getBoundingClientRect(); return Math.abs(a.top - b.top) < 6 && b.left >= a.right; })(), watchState: document.getElementById('watch-state').textContent, watchLabel: document.getElementById('watch-toggle').textContent.trim(), watchDisabled: document.getElementById('watch-toggle').disabled, watchCopy: document.getElementById('watch-copy').textContent.trim(), syncMedia: (() => { const box = document.getElementById('sync-media'); const label = box && box.closest('label'); return { label: label ? label.textContent.trim() : '', checked: Boolean(box && box.checked), disabled: Boolean(box && box.disabled) }; })(), viewH: innerHeight, watchBottom: Math.round(document.getElementById('watch-toggle').getBoundingClientRect().bottom), title: document.title, bg: getComputedStyle(document.body).backgroundColor, fg: getComputedStyle(document.body).color })"
  );
  return raw ? JSON.parse(raw) : null;
}

// A host alone must state its size. This reads the panel before a second peer
// joins, so a blank count or a missing empty list fails the lane.
async function waitPanelAlone(bidi, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const tree = await bidi.cmd('browsingContext.getTree', {}).catch(() => null);
    const panel =
      tree && tree.contexts.find((item) => String(item.url || '').includes('/panel/room.html'));
    if (panel) {
      const raw = await evaluate(
        bidi,
        panel.context,
        `JSON.stringify({
          count: document.getElementById('count').textContent,
          title: document.title,
          empty: (document.querySelector('#peers .empty') || { textContent: '' }).textContent,
        })`
      ).catch(() => null);
      const state = raw ? JSON.parse(raw) : null;
      if (state && state.count === '0') {
        // The engine resolves the manifest popup, so this proves a toolbar
        // click reaches the panel page instead of a URL the build refused.
        const popup = await evaluate(
          bidi,
          panel.context,
          '(async () => { try { return await browser.browserAction.getPopup({}); } catch (error) { return String((error && error.message) || error); } })()'
        ).catch(() => null);
        return { ...state, popup };
      }
    }
    await sleep(300);
  }
  return null;
}

async function waitPanelReady(bidi, timeoutMs = 40000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const tree = await bidi.cmd('browsingContext.getTree', {}).catch(() => null);
    const panel =
      tree && tree.contexts.find((item) => String(item.url || '').includes('/panel/room.html'));
    if (panel) {
      await bidi.cmd('browsingContext.activate', { context: panel.context }).catch(() => {});
      await evaluate(bidi, panel.context, "document.getElementById('refresh').click(); true").catch(
        () => {}
      );
      const state = await readPanel(bidi, panel.context).catch(() => null);
      if (state && state.control && state.names.some((name) => String(name).includes(PEER_NAME))) {
        return panel.context;
      }
    }
    await sleep(400);
  }
  return null;
}

// The cached route test leaves the panel painted from the copy the room
// published, and that copy carries no host buttons. One refresh repaints them,
// so this waits for the row instead of clicking a render that is not there yet.
async function clickPeerControl(bidi, panelContext, peer) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const clicked = await evaluate(
      bidi,
      panelContext,
      `(() => {
        const node = document.querySelector('#peers li[data-peer="${peer}"] .peer-control');
        if (!node) return false;
        node.click();
        return true;
      })()`
    ).catch(() => false);
    if (clicked) return true;
    await evaluate(
      bidi,
      panelContext,
      "document.getElementById('refresh').click(); true"
    ).catch(() => {});
    await sleep(400);
  }
  return false;
}

async function waitPanelNotice(bidi, panelContext, phrase, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    last = await readPanel(bidi, panelContext).catch(() => null);
    if (last && String(last.notice).includes(phrase)) return last;
    await sleep(300);
  }
  return null;
}

// The dock runs in chrome scope. This build stops BiDi from reading tab
// content while the Marionette listener runs, so the dock gets a window of its
// own. The stock bookmarks sidebar fills the same box as the room panel, and
// the BiDi run above proves the panel content.
async function probeDock(zen) {
  const dir = path.join(runtime, 'dock-profile');
  fs.rmSync(dir, { recursive: true, force: true });
  // This lane installs its own unsigned build over BiDi, so the profile keeps
  // signature checking off and takes no bridge file.
  const profile = writeProfile(dir, { bridge: false });
  fs.appendFileSync(
    path.join(profile, 'user.js'),
    `user_pref("marionette.port", ${MARIONETTE});\n`
  );
  const browser = spawn(
    zen,
    [
      '--profile',
      profile,
      '--no-remote',
      '--new-instance',
      '--headless',
      '--marionette',
      '--width',
      '1280',
      '--height',
      '900',
      'about:blank',
    ],
    {
      stdio: 'ignore',
      env: { ...process.env, MOZ_HEADLESS: '1', MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
    }
  );
  const dock = {
    injected: false,
    geometry: null,
    sidebar: 'viewBookmarksSidebar',
    hidden: null,
    restored: null,
    error: null,
  };
  try {
    const probe = await dockPanel({
      port: MARIONETTE,
      open: true,
      sidebarId: 'viewBookmarksSidebar',
      // The chip shows only while the panel is shut, so the probe shuts the
      // sidebar and clicks the chip in the same session.
      after: [
        { script: 'return (window.__brosrHidePanel ? window.__brosrHidePanel() : "")', wait: 0 },
        { script: 'return (window.__brosrDock ? window.__brosrDock() : null)', wait: 800 },
        {
          script: 'return (window.__brosrClickToggle ? window.__brosrClickToggle() : false)',
          wait: 0,
        },
        { script: 'return (window.__brosrDock ? window.__brosrDock() : null)', wait: 1200 },
        // A customize run hides the column. The card must park, not cover the page.
        {
          script:
            'return (() => { const c = document.getElementById("navigator-toolbox"); if (c) c.style.display = "none"; return window.__brosrDock ? window.__brosrDock() : null; })()',
          wait: 600,
        },
        {
          script:
            'return (() => { const c = document.getElementById("navigator-toolbox"); if (c) c.style.display = ""; return window.__brosrDock ? window.__brosrDock() : null; })()',
          wait: 600,
        },
        // A narrow window must keep the bar, the column and the panel together.
        {
          script: 'return (() => { window.resizeTo(900, 820); return window.innerWidth; })()',
          wait: 900,
        },
        { script: 'return (window.__brosrDock ? window.__brosrDock() : null)', wait: 200 },
        // A drop inside the panel hands the page over, and a drop off the bar
        // removes it. The pair comes back through the same script.
        {
          script:
            'return (() => { const g = window.__brosrDock(); window.__brosrSites.drop(1, g.x + 10, g.y + 10); return window.__brosrSites.list(); })()',
          wait: 100,
        },
        {
          script:
            'return (() => { const g = window.__brosrDock(); window.__brosrSites.drop(0, g.windowWidth - 40, 40); return { list: window.__brosrSites.list(), state: window.__brosrDock() }; })()',
          wait: 200,
        },
        { script: 'return (window.__brosrSites ? window.__brosrSites.reset() : null)', wait: 100 },
        { script: 'return (window.__brosrDock ? window.__brosrDock() : null)', wait: 100 },
        // The add form takes a bare host, and a remove drops it again.
        {
          script: 'return (window.__brosrSites ? window.__brosrSites.add("example.com") : null)',
          wait: 100,
        },
        { script: 'return (window.__brosrSites ? window.__brosrSites.remove(2) : null)', wait: 100 },
        { script: 'return (window.__brosrDock ? window.__brosrDock() : null)', wait: 100 },
        // The chord opens the add form with the caret in it, and Escape closes
        // it again.
        {
          script:
            'return (() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, altKey: true, bubbles: true, cancelable: true })); return window.__brosrDock(); })()',
          wait: 200,
        },
        {
          script:
            'return (() => { const input = document.querySelector("#brosr-sites .brosr-site-form input"); if (input) input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); return window.__brosrDock(); })()',
          wait: 100,
        },
        // A tile selects the tab that already holds its site, so a second click
        // never stacks a copy. The loopback page keeps this off the network.
        {
          script:
            'return (() => { window.__brosrSites.add("127.0.0.1:8787/room-a.html"); return { first: window.__brosrSites.open(2), list: window.__brosrSites.list() }; })()',
          wait: 100,
        },
        {
          script:
            'return (() => { const second = window.__brosrSites.open(2); const tab = window.gBrowser.selectedTab; const state = window.__brosrDock ? window.__brosrDock() : null; return { second, active: tab ? tab.linkedBrowser.currentURI.spec : "", tabs: window.gBrowser.tabs.length, mark: state ? state.currentTiles : null }; })()',
          wait: 1800,
        },
        // The column floor must keep the last tile and the add tile whole.
        {
          script:
            'return (() => { const c = document.getElementById("navigator-toolbox"); if (c) { c.dataset.brosrWidth = c.style.width || ""; c.style.width = "315px"; } return window.__brosrDock ? window.__brosrDock() : null; })()',
          wait: 600,
        },
        {
          script:
            'return (() => { const c = document.getElementById("navigator-toolbox"); if (c) { c.style.width = c.dataset.brosrWidth || ""; delete c.dataset.brosrWidth; } return window.__brosrDock ? window.__brosrDock() : null; })()',
          wait: 400,
        },
        // A right click opens the tile menu, and Remove drops the tile.
        {
          script:
            'return (() => { const tile = document.querySelector("#brosr-sites .brosr-site"); if (tile) tile.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 220 })); return window.__brosrDock ? window.__brosrDock() : null; })()',
          wait: 200,
        },
        {
          script:
            'return (() => { const menu = document.getElementById("brosr-site-menu"); const btn = menu && menu.querySelector("[data-act=remove]"); if (btn) btn.click(); return { list: window.__brosrSites.list(), menu: window.__brosrDock ? window.__brosrDock().menu : null }; })()',
          wait: 200,
        },
        // The star adds the page in the selected tab and takes it away again.
        {
          script:
            'return (() => { window.__brosrSites.reset(); const before = window.__brosrStar.state(); window.__brosrStar.toggle(); const on = window.__brosrDock(); const added = window.__brosrSites.list(); window.__brosrStar.toggle(); return { before, on, added, back: window.__brosrSites.list() }; })()',
          wait: 300,
        },
      ],
    });
    if (!probe.ok) {
      dock.error = probe.error || 'the dock script did not run';
      return dock;
    }
    dock.injected = true;
    dock.geometry = probe.result || null;
    const g = dock.geometry;
    if (!g || typeof g !== 'object') dock.error = 'the dock script returned no state';
    else if (!g.docked) dock.error = 'the panel is not docked';
    else if (!g.open) dock.error = 'the sidebar did not open';
    else if (!(g.inset > 0)) dock.error = 'the dock reports no inset';
    else if (Math.abs(g.x - (g.columnLeft + g.inset)) > 2) {
      dock.error = `the panel starts at x=${g.x}, not at the column edge`;
    } else if (g.parked) dock.error = 'the panel parked in a visible column';
    else if (!String(g.radius || '').startsWith('8')) dock.error = `the panel corner is ${g.radius}`;
    else if (g.surface !== 'rgba(0, 0, 0, 0)') dock.error = `the box paints over the card: ${g.surface}`;
    else if (g.toolbar !== false) dock.error = 'the single toolbar is still on';
    else if (Math.abs(g.columnLeft) > 1) dock.error = `the column starts at ${g.columnLeft}`;
    else if (g.columnTop > 1) dock.error = `the column starts at ${g.columnTop}, below the window edge`;
    else if (g.columnMin < 315) dock.error = `the column floor is ${g.columnMin}`;
    else if (String(g.barClip) !== 'none') {
      dock.error = `the column clip is ${g.barClip}`;
    } else if (!g.controls || g.controls.count < 1 || g.controls.display === 'none') {
      dock.error = `the window controls are ${g.controls ? g.controls.display : 'missing'}`;
    } else if (!(g.controls.top < g.sitesTop)) {
      dock.error = `the controls sit at ${g.controls.top}, over the tiles at ${g.sitesTop}`;
    } else if (!g.compact || !g.compact.found) {
      dock.error = 'the compact mode button is missing';
    } else if (!g.compact.inBar) {
      dock.error = 'the compact mode button is not in the top bar';
    } else if (g.compact.display === 'none' || g.compact.width < 16) {
      dock.error = `the compact mode button is ${g.compact.display} at ${g.compact.width}`;
    } else if (g.compact.left < g.barLeft) {
      dock.error = `the compact button sits at ${g.compact.left}, left of ${g.barLeft}`;
    } else if (g.compact.top > g.barHeight) {
      dock.error = `the compact button sits at ${g.compact.top}, below the bar`;
    } else if (g.barRow.left > 1 || g.barRow.right < g.windowWidth - 1) {
      dock.error = `the top bar spans ${g.barRow.left} to ${g.barRow.right} in a ${g.windowWidth} window`;
    } else if (
      g.controlsBox.count > 0 &&
      g.controlsBox.left < g.controlsBox.backLeft &&
      g.controlsBox.right > g.controlsBox.backLeft
    ) {
      dock.error = `the window controls run from ${g.controlsBox.left} to ${g.controlsBox.right}, over the back button at ${g.controlsBox.backLeft}`;
    } else if (!g.bookmarks || g.bookmarks.text !== 'Essentials') {
      dock.error = `the essentials heading reads ${g.bookmarks ? g.bookmarks.text : 'missing'}`;
    } else if (g.bookmarks.top < g.barTop + 1) {
      dock.error = `the essentials heading starts at ${g.bookmarks.top}`;
    } else if (g.bookmarks.top + 8 > g.sitesTop) {
      dock.error = 'the essentials heading sits under the tiles';
    } else if (String(g.splitter) === 'none') dock.error = 'the column splitter is hidden';
    // The profile seeds a 320 pixel column, and Zen can restore a smaller one.
    // A column past that seed means the dock widened it.
    else if (g.column > 340) dock.error = `the column is ${g.column} wide`;
    else if (g.x + g.panelWidth + g.inset > g.column) {
      dock.error = `the panel runs ${g.x + g.panelWidth + g.inset - g.column} past the column`;
    } else if (g.x + g.panelWidth > g.pageEdge) {
      dock.error = `the panel runs ${g.x + g.panelWidth - g.pageEdge} onto the page`;
    }
    else if (g.panelWidth < 240) dock.error = `the panel is ${g.panelWidth} wide`;
    else if (g.panelHeight < 120) dock.error = `the panel is ${g.panelHeight} tall`;
    else if (!g.bar) dock.error = 'the drag bar is missing';
    else if (g.toggleText !== 'Brosr room') dock.error = `the show chip reads ${g.toggleText}`;
    else if (g.reduced ? g.motion !== 'none' : !String(g.motion).includes('brosr-rise')) {
      dock.error = `the card motion is ${g.motion}`;
    } else if (!g.reduced && !(g.motionMs >= 100 && g.motionMs <= 300)) {
      dock.error = `the card motion runs ${g.motionMs} ms`;
    } else if (!g.clear) dock.error = 'the window surface stayed solid';
    else if (!(g.alpha > 0.8 && g.alpha < 1)) dock.error = `the surface alpha is ${g.alpha}`;
    else if (g.layer < 1) dock.error = 'the window paints no background layer';
    else if (g.sites !== 2) dock.error = `the sites bar holds ${g.sites} pages`;
    else if (
      !Array.isArray(g.siteLabels) ||
      g.siteLabels[0] !== 'youtube.com' ||
      g.siteLabels[1] !== 'fmhy.net'
    ) {
      dock.error = `the sites bar reads ${JSON.stringify(g.siteLabels)}`;
    } else if (g.sitesTop < g.barTop + g.barHeight - 1) {
      dock.error = `the sites bar starts at ${g.sitesTop}, under the bar that ends at ${
        g.barTop + g.barHeight
      }`;
    } else if (g.sitesRight > g.column + 1) {
      dock.error = `the bookmarks end at ${g.sitesRight}, past the column at ${g.column}`;
    } else if (g.sitesTop + g.sitesHeight > g.tabsTop + 1) {
      dock.error = `the sites bar ends at ${g.sitesTop + g.sitesHeight}, over the tabs at ${
        g.tabsTop
      }`;
    } else if (g.siteWidth < 80 || g.siteHeight < 28 || g.siteHeight > 44) {
      dock.error = `the site tab is ${g.siteWidth} by ${g.siteHeight}`;
    } else if (!g.star || !g.star.found) {
      dock.error = 'the bookmark star is missing';
    } else if (!g.star.inBar) {
      dock.error = 'the bookmark star is not in the urlbar';
    } else if (!g.menu || !g.menu.found) {
      dock.error = 'the tile menu is missing';
    } else if (g.menu.open || g.menu.items.length > 0) {
      dock.error = 'the tile menu opened on its own';
    } else if (!(g.footHeight > 0)) {
      dock.error = 'the column foot row is missing';
    } else if (g.footDots < 1) {
      dock.error = 'the space dots are hidden';
    } else if (g.footBottom > g.y) {
      dock.error = `the foot row ends at ${g.footBottom}, under the panel at ${g.y}`;
    } else if (g.spaces !== 'none') {
      dock.error = `the space name shows as ${g.spaces}`;
    } else if (g.fieldWidth < 300) {
      dock.error = `the address field is ${g.fieldWidth} wide`;
    } else if (g.windowWidth - g.fieldRight > 260) {
      dock.error = `the address field ends ${g.windowWidth - g.fieldRight} from the edge`;
    }
    const steps = Array.isArray(probe.steps) ? probe.steps : [];
    dock.hidden = steps[1] || null;
    dock.restored = steps[3] || null;
    dock.parked = steps[4] || null;
    dock.back = steps[5] || null;
    dock.narrowWidth = steps[6] || null;
    dock.narrow = steps[7] || null;
    dock.sitesAfter = steps[8] || null;
    dock.deletedList = steps[9] && steps[9].list ? steps[9].list : null;
    dock.deletedState = steps[9] && steps[9].state ? steps[9].state : null;
    dock.resetList = steps[10] || null;
    dock.afterReset = steps[11] || null;
    dock.addedList = steps[12] || null;
    dock.removedList = steps[13] || null;
    dock.afterAdd = steps[14] || null;
    dock.chordOpen = steps[15] || null;
    dock.chordClosed = steps[16] || null;
    dock.tabs = steps[17] || null;
    dock.tabsAgain = steps[18] || null;
    dock.floor = steps[19] || null;
    dock.floorBack = steps[20] || null;
    dock.menuOpen = steps[21] || null;
    dock.menuRemove = steps[22] || null;
    dock.star = steps[23] || null;
    if (!dock.error && dock.hidden) {
      if (dock.hidden.open) dock.error = 'the sidebar did not hide';
      else if (!dock.hidden.toggle) dock.error = 'the show chip stayed hidden';
      else if (!String(dock.hidden.toggleText).startsWith('Brosr room')) {
        dock.error = `the show chip reads ${dock.hidden.toggleText}`;
      }
    }
    if (!dock.error && !dock.restored) dock.error = 'the show chip did not answer';
    else if (!dock.error && !dock.restored.open) {
      dock.error = 'the show chip did not open the sidebar';
    }
    if (!dock.error) {
      if (!dock.parked || !dock.parked.parked) dock.error = 'the panel stayed out with no column';
      else if (dock.parked.panelVisible) dock.error = 'the panel stayed visible without a column';
      else if (dock.parked.bar) dock.error = 'the resize bar stayed over the page';
      else if (dock.parked.toggle) dock.error = 'the show chip stayed over the page';
      else if (!dock.back || !dock.back.docked) dock.error = 'the panel did not return to the column';
    }
    const narrow = dock.narrow;
    if (!dock.error && !narrow) dock.error = 'the narrow pass did not run';
    else if (!dock.error) {
      if (narrow.windowWidth > 960) dock.error = `the window stayed ${narrow.windowWidth} wide`;
      else if (narrow.barRow.left > 1 || narrow.barRow.right < narrow.windowWidth - 1) {
        dock.error = `the narrow bar spans ${narrow.barRow.left} to ${narrow.barRow.right} in a ${narrow.windowWidth} window`;
      } else if (narrow.column > 440) dock.error = `the narrow column is ${narrow.column}`;
      else if (narrow.width < 160) dock.error = `the narrow panel is ${narrow.width} wide`;
      else if (narrow.x + narrow.panelWidth + narrow.inset > narrow.column) {
        dock.error = 'the narrow panel runs past the column';
      } else if (narrow.parked) dock.error = 'the narrow panel parked in a visible column';
      else if (narrow.sites !== 2) dock.error = `the narrow bar holds ${narrow.sites} pages`;
      else if (narrow.sitesRight > narrow.column + 1) {
        dock.error = `the narrow bookmarks end at ${narrow.sitesRight} of ${narrow.column}`;
      } else if (!narrow.compact || !narrow.compact.inBar) {
        dock.error = 'the narrow window lost the compact button';
      } else if (narrow.spaces !== 'none') {
        dock.error = 'the narrow window shows the space name';
      }
    }
    const floor = dock.floor;
    if (!dock.error && !floor) dock.error = 'the floor pass did not run';
    else if (!dock.error) {
      if (floor.column > 316) dock.error = `the floor pass left a ${floor.column} column`;
      else if (floor.sitesRight > floor.column + 1) {
        dock.error = `the floor bookmarks end at ${floor.sitesRight} of ${floor.column}`;
      } else if (floor.siteWidth < 56) dock.error = `the floor tile is ${floor.siteWidth} wide`;
    }
    if (!dock.error && (!dock.floorBack || dock.floorBack.column < 316)) {
      dock.error = 'the column width did not come back';
    }
    if (!dock.error) {
      if (!Array.isArray(dock.sitesAfter) || dock.sitesAfter.length !== 1) {
        dock.error = 'the panel drop kept the tile';
      } else if (!Array.isArray(dock.deletedList) || dock.deletedList.length !== 0) {
        dock.error = 'the tile did not leave the bar';
      } else if (!dock.deletedState || dock.deletedState.sites !== 0) {
        dock.error = 'the empty sites bar still lists a page';
      } else if (dock.deletedState.siteWidth !== 0) {
        dock.error = 'the empty sites bar kept a tile';
      } else if (!Array.isArray(dock.resetList) || dock.resetList.length !== 2) {
        dock.error = 'the sites bar did not restore its pair';
      } else if (
        !Array.isArray(dock.addedList) ||
        dock.addedList.length !== 3 ||
        !dock.addedList.some((url) => String(url).includes('example.com'))
      ) {
        dock.error = 'the add form did not save the link';
      } else if (!Array.isArray(dock.removedList) || dock.removedList.length !== 2) {
        dock.error = 'the remove button did not drop the link';
      } else if (!dock.afterAdd || dock.afterAdd.sites !== 2) {
        dock.error = 'the sites bar did not return to the shipped pair';
      }
    }
    if (!dock.error) {
      if (!dock.chordOpen) dock.error = 'the add chord did not run';
      else if (!dock.chordOpen.siteForm) dock.error = 'Ctrl+Alt+A did not open the add form';
      else if (!dock.chordOpen.formFocus) dock.error = 'the add form opened without the caret';
    }
    if (!dock.error && dock.chordClosed && dock.chordClosed.siteForm) {
      dock.error = 'Escape did not close the add form';
    }
    const tabs = dock.tabs;
    const again = dock.tabsAgain;
    if (!dock.error) {
      if (!tabs || !tabs.first) dock.error = 'the tile tab pass did not run';
      else if (!tabs.first.ok) dock.error = 'a tile did not open its page';
      else if (tabs.first.tabsAfter !== tabs.first.tabsBefore + 1) {
        dock.error = 'a tile click opened no tab';
      } else if (!again || !again.second) dock.error = 'the second tile click did not run';
      else if (!again.second.reused) dock.error = 'a second click opened a copy of the tab';
      else if (again.second.tabsAfter !== tabs.first.tabsAfter) {
        dock.error = 'the second click changed the tab count';
      } else if (!String(again.active).includes('127.0.0.1:8787/room-a.html')) {
        dock.error = `the tile tab reads ${again.active}`;
      } else if (again.mark !== 1) {
        dock.error = `the open site marks ${again.mark} tiles as current`;
      }
    }

    const menu = dock.menuOpen;
    if (!dock.error && !menu) dock.error = 'the right click pass did not run';
    else if (!dock.error) {
      if (!menu.menu || !menu.menu.open) dock.error = 'a right click opened no menu';
      else if (menu.menu.items.join('|') !== 'Open|Open in New Tab|Edit|Remove') {
        dock.error = `the tile menu reads ${menu.menu.items.join('|')}`;
      }
    }
    const removed = dock.menuRemove;
    if (!dock.error && removed) {
      if (!Array.isArray(removed.list) || removed.list.length !== 2) {
        dock.error = 'the menu remove kept the tile';
      } else if (removed.list.some((url) => String(url).includes('youtube.com'))) {
        dock.error = 'the menu remove kept the first tile';
      } else if (removed.menu && removed.menu.open) {
        dock.error = 'the tile menu stayed open after remove';
      }
    }
    const star = dock.star;
    if (!dock.error && !star) dock.error = 'the star pass did not run';
    else if (!dock.error) {
      if (!star.before || !star.before.live) dock.error = 'the star pass had no page to bookmark';
      else if (star.before.on) dock.error = 'the star started on for a page outside the row';
      else if (!star.on || !star.on.star || !star.on.star.on) {
        dock.error = 'the star did not mark the added page';
      } else if (!Array.isArray(star.added) || star.added.length !== 3) {
        dock.error = 'the star did not add the page';
      } else if (!Array.isArray(star.back) || star.back.length !== 2) {
        dock.error = 'the star did not remove the page';
      } else if (star.on.star.width < 12) {
        dock.error = `the star is ${star.on.star.width} wide`;
      } else if (star.on.star.right > star.on.star.settingsLeft + 1) {
        dock.error = 'the star sits right of the settings icon';
      } else if (star.on.star.top < star.on.barTop - 1) {
        dock.error = 'the star sits above the bar';
      } else if (star.on.star.bottom > star.on.barTop + star.on.barHeight + 2) {
        dock.error = 'the star sits below the bar';
      }
    }
    return dock;
  } finally {
    killTree(browser);
  }
}

async function main() {
  const zen = findZen() || arg('zen', '');
  if (!zen || !fs.existsSync(zen)) throw new Error('no Zen binary. Pass --zen=<path>.');
  const info = readIni(zen);
  // A reused profile restores the room and panel tabs from the last run, and
  // their panels drive control too. The default profile is disposable.
  const givenProfile = arg('profile', '');
  if (!givenProfile) fs.rmSync(path.join(runtime, 'profile'), { recursive: true, force: true });
  const profile = writeProfile(givenProfile || path.join(runtime, 'profile'), { bridge: false });
  const xpi = buildXpi(XPI).out;
  const manifest = JSON.parse(
    fs.readFileSync(path.join(bridge, 'manifest.json'), 'utf8')
  );
  // The panel is an anchored popup inside the browser window. The manifest
  // declares no sidebar, and no code opens a window of its own.
  if (manifest.sidebar_action) {
    throw new Error('the manifest declares a sidebar the panel does not use');
  }
  if (!manifest.browser_action) throw new Error('the manifest declares no toolbar action');
  // The toolbar opens the panel as an anchored popup, so one click reaches it.
  if (String(manifest.browser_action.default_popup || '') !== 'panel/room.html?surface=popup') {
    throw new Error(
      `the toolbar popup points at ${manifest.browser_action.default_popup || 'nothing'}`
    );
  }
  // The toolbar button is pinned by default, so a new room shows it without a
  // trip to the extensions panel.
  if (manifest.browser_action.default_area !== 'navbar') {
    throw new Error('the toolbar action is not pinned to the navbar by default');
  }
  if (!manifest.icons || !manifest.icons['128']) throw new Error('the manifest declares no icons');
  if (!manifest.browser_action || !manifest.browser_action.default_icon) {
    throw new Error('the toolbar action has no icon');
  }
  for (const size of [16, 32, 48, 96, 128]) {
    const icon = path.join(here, '..', 'assets', `icon-${size}.png`);
    if (!fs.existsSync(icon)) throw new Error(`the ${size} pixel icon is missing`);
  }
  if (!String(manifest.browser_action.default_icon['32'] || '').includes('action-32.png')) {
    throw new Error('the toolbar action still uses the app icon');
  }
  for (const size of [16, 32, 48]) {
    const icon = path.join(here, '..', 'assets', `action-${size}.png`);
    if (!fs.existsSync(icon)) throw new Error(`the ${size} pixel action icon is missing`);
  }
  const background = fs.readFileSync(path.join(bridge, 'background.js'), 'utf8');
  // The toolbar is browserAction on manifest version 2 and action on version 3,
  // so the test names the listener and the shared opener, not one engine name.
  if (/toolbar\.onClicked\.addListener/.test(background)) {
    throw new Error('the background still answers a toolbar click that the popup owns');
  }
  // The panel is a popup inside the browser window. A window of its own is the
  // one surface this build never opens.
  if (/windows\.create/.test(background)) {
    throw new Error('the background still opens a window outside the browser');
  }
  if (!/commands\.onCommand\.addListener\([\s\S]{0,800}?openPanel\(/.test(background)) {
    throw new Error('the shortcut does not ask for the panel popup');
  }
  if (!manifest.commands || !manifest.commands['open-room-panel']) {
    throw new Error('the manifest does not declare the panel shortcut');
  }
  if (!/commands\.onCommand\.addListener\(/.test(background)) {
    throw new Error('the background page does not handle the shortcut');
  }
  const roomCss = fs.readFileSync(path.join(bridge, 'panel', 'room.css'), 'utf8');
  if (!roomCss.includes('@keyframes room-in') || !roomCss.includes('prefers-reduced-motion')) {
    throw new Error('the panel has no entrance motion or no reduced motion guard');
  }
  log('[zen] binary', zen, `(${info.version || 'unknown'})`);

  const relay = spawn(process.execPath, ['relay.js'], { cwd: spike, stdio: 'ignore' });
  const browser = spawn(
    zen,
    [
      '--profile',
      profile,
      '--no-remote',
      '--new-instance',
      '--headless',
      '--remote-debugging-port',
      String(PORT),
      '--width',
      '1280',
      '--height',
      '900',
      'about:blank',
    ],
    {
      stdio: 'ignore',
      env: { ...process.env, MOZ_HEADLESS: '1', MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
    }
  );

  let result = { zen: info, check: { ok: false, error: 'not run' }, dataset: null, panel: null };
  try {
    await waitHealth();
    const bidi = await connect();
    const installed = await bidi.cmd('webExtension.install', {
      extensionData: { type: 'archivePath', path: xpi },
    });
    log('[zen] installed', installed.extension);

    // The first context is not always a real tab, and the extension cannot see
    // a windowless one. Create a tab so sender.tab exists for the panel.
    const created = await bidi.cmd('browsingContext.create', { type: 'tab' });
    const context = created.context;
    const room = arg('room', 'zen');
    const url = `http://127.0.0.1:${RELAY}/room-b.html?role=host&room=${room}&peer=host&name=Host`;
    await bidi.cmd('browsingContext.navigate', { context, url, wait: 'complete' });

    const data = await waitForDataset(bidi, context, (d) => d.socket === 1);
    if (!data) throw new Error('no dataset from the content script');
    if (data.source !== 'content-script') throw new Error(`source was ${data.source}`);
    if (data.socket !== 1) throw new Error(`socket was ${data.socket}`);
    if (!data.panelUrl) throw new Error('the content script did not publish a panel URL');

    // A headless engine draws no toolbar popup, so the lane opens the same
    // document in a tab. The page under test is the panel either way.
    const panelTab = (await bidi.cmd('browsingContext.create', { type: 'tab' })).context;
    const panelUrl = `${data.panelUrl}${data.panelUrl.includes('?') ? '&' : '?'}surface=tab`;
    await bidi.cmd('browsingContext.navigate', {
      context: panelTab,
      url: panelUrl,
      wait: 'complete',
    });
    log('[zen] panel tab', panelTab);

    // A host alone must read zero, so a blank cell never looks like a panel
    // that has not answered yet.
    const alone = await waitPanelAlone(bidi);
    if (!alone) throw new Error('the panel never stated zero peers for a host alone');
    if (alone.count !== '0') throw new Error(`the panel count reads ${alone.count} while alone`);
    if (alone.title !== 'Brosr room \u00b7 0') {
      throw new Error(`the panel title reads ${alone.title} while alone`);
    }
    if (!String(alone.empty).includes('No peers in this room yet.')) {
      throw new Error(`the empty list reads ${alone.empty}`);
    }
    if (!String(alone.popup || '').endsWith('panel/room.html?surface=popup')) {
      throw new Error(`the toolbar popup resolves to ${alone.popup}`);
    }


    // A real second peer joins the room, so the grant has a receiver.
    const peerContext = (await bidi.cmd('browsingContext.create', { type: 'tab' })).context;
    log('[zen] tabs', JSON.stringify({ host: context, peer: peerContext }));
    const peerUrl = `http://127.0.0.1:${RELAY}/room-b.html?role=peer&room=${room}&peer=${PEER}&name=${encodeURIComponent(PEER_NAME)}`;
    await bidi.cmd('browsingContext.navigate', {
      context: peerContext,
      url: peerUrl,
      wait: 'complete',
    });
    const joined = await waitForDataset(
      bidi,
      context,
      (d) =>
        Number(d.peers) >= 2 &&
        Array.isArray(d.peerList) &&
        d.peerList.some((peer) => peer.id === PEER),
      30000
    );
    if (!joined || !Array.isArray(joined.peerList)) {
      const peerState = await readDataset(bidi, peerContext).catch(() => null);
      throw new Error(
        'the host never saw the second peer. peer=' +
          JSON.stringify(peerState && { socket: peerState.socket, error: peerState.error })
      );
    }

    const panelContext = await waitPanelReady(bidi);
    if (!panelContext) throw new Error('the panel did not render the peer list');

    // A sidebar cannot always reach the tab channel, so the room tab also
    // publishes its status. This case breaks the tab call and the relay on
    // purpose, then reads the same panel through that published copy.
    const cachedRaw = await evaluate(
      bidi,
      panelContext,
      `(async () => {
        const tabs = browser.tabs.sendMessage;
        const runtime = browser.runtime.sendMessage;
        browser.tabs.sendMessage = () => Promise.reject(new Error('refused for the test'));
        browser.runtime.sendMessage = (message) =>
          message && message.type === 'brosr:tab-status'
            ? Promise.resolve({ ok: false, reason: 'refused for the test' })
            : runtime.call(browser.runtime, message);
        document.getElementById('refresh').click();
        await new Promise((resolve) => setTimeout(resolve, 1400));
        const state = document.getElementById('dot').dataset.state;
        const names = [...document.querySelectorAll('#peers .name')].map((node) => node.textContent);
        const route = document.documentElement.dataset.brosrRoute || null;
        browser.tabs.sendMessage = tabs;
        browser.runtime.sendMessage = runtime;
        return JSON.stringify({ state, names, route });
      })()`
    ).catch((error) =>
      JSON.stringify({ state: 'error', names: [], route: null, error: error.message })
    );
    const cachedState = JSON.parse(cachedRaw || '{}');
    if (cachedState.state !== 'live') {
      throw new Error('the published status did not render: ' + cachedRaw);
    }
    if (!cachedState.names.some((name) => String(name).includes(PEER_NAME))) {
      throw new Error('the published status lost the peer list: ' + cachedRaw);
    }
    if (cachedState.route !== 'cached') {
      throw new Error('the panel did not report the cached route: ' + cachedRaw);
    }

    if (!(await clickPeerControl(bidi, panelContext, PEER))) {
      throw new Error(`the panel offered no control for ${PEER}`);
    }
    const grantedPanel = await waitPanelNotice(bidi, panelContext, 'Control granted');
    if (!grantedPanel) throw new Error('the panel did not report a grant');
    if (!grantedPanel.control) throw new Error('the host controls are hidden');
    if (!grantedPanel.names.some((name) => String(name).includes(PEER_NAME))) {
      throw new Error(`the panel did not list ${PEER_NAME}`);
    }
    if (!Array.isArray(grantedPanel.grantedPeers) || !grantedPanel.grantedPeers.includes(PEER)) {
      throw new Error(`the panel did not mark ${PEER} as controlled`);
    }
    if (
      !Array.isArray(grantedPanel.history) ||
      !grantedPanel.history.some((row) => row.includes(PEER) && row.includes('granted'))
    ) {
      throw new Error('the panel history did not record the grant');
    }
    if (!String(grantedPanel.invite).includes('role=peer')) {
      throw new Error(`the panel offers no join link: ${grantedPanel.invite}`);
    }
    if (!String(grantedPanel.invite).includes('room=' + room)) {
      throw new Error('the join link drops the room id');
    }
    const ratio = contrastRatio(grantedPanel.bg, grantedPanel.fg);
    if (ratio === null) throw new Error('the panel reports no colours');
    if (ratio < 4) throw new Error(`the panel text contrast is ${ratio.toFixed(2)}`);
    if (!grantedPanel.count) throw new Error('the panel shows no peer count');
    if (!grantedPanel.playback) throw new Error('the panel shows no playback state');
    if (!grantedPanel.relay) throw new Error('the panel shows no relay state');
    if (grantedPanel.inviteCopy !== 'Copy') {
      throw new Error(`the join row copy button reads ${grantedPanel.inviteCopy}`);
    }
    if (!grantedPanel.inviteRow) throw new Error('the copy button does not sit beside the join link');
    if (!['No media', 'Playing', 'Paused'].includes(grantedPanel.watchState)) {
      throw new Error(`the watch card reads ${grantedPanel.watchState}`);
    }
    if (grantedPanel.watchLabel !== 'Open the film') {
      throw new Error(`the watch button reads ${grantedPanel.watchLabel}`);
    }
    if (!grantedPanel.syncMedia || grantedPanel.syncMedia.label !== 'Sync playback') {
      throw new Error(
        `the playback toggle reads ${grantedPanel.syncMedia && grantedPanel.syncMedia.label}`
      );
    }
    if (!grantedPanel.watchDisabled) {
      throw new Error('the sync button looks live while the media bridge is off');
    }
    if (!grantedPanel.watchCopy) throw new Error('the watch card explains nothing');
    // A short panel must show the whole card without a scroll, so a person
    // reads the state and the button without hunting for them.
    if (grantedPanel.viewH <= 320 && grantedPanel.watchBottom > grantedPanel.viewH + 1) {
      throw new Error(
        `the watch card ends at ${grantedPanel.watchBottom} in a ${grantedPanel.viewH} panel`
      );
    }
    if (grantedPanel.title !== `Brosr room \u00b7 ${grantedPanel.count}`) {
      throw new Error(`the panel title is ${grantedPanel.title}`);
    }

    const peerGranted = await waitForDataset(bidi, peerContext, (d) => d.granted === true, 20000);
    if (!peerGranted || peerGranted.granted !== true) {
      throw new Error('the peer did not receive control');
    }
    const hostGranted = await waitForDataset(
      bidi,
      context,
      (d) =>
        Array.isArray(d.peerList) &&
        d.peerList.some((peer) => peer.id === PEER && peer.granted === true),
      20000
    );
    if (!hostGranted) throw new Error('the host did not record the grant');

    if (!(await clickPeerControl(bidi, panelContext, PEER))) {
      throw new Error(`the panel offered no revoke control for ${PEER}`);
    }
    const revokedPanel = await waitPanelNotice(bidi, panelContext, 'Control revoked');
    if (!revokedPanel) throw new Error('the panel did not report a revoke');
    if (!Array.isArray(revokedPanel.grantedPeers) || revokedPanel.grantedPeers.includes(PEER)) {
      throw new Error(`the panel still marks ${PEER} as controlled`);
    }
    if (
      !Array.isArray(revokedPanel.history) ||
      !revokedPanel.history.some((row) => row.includes(PEER) && row.includes('revoked'))
    ) {
      throw new Error('the panel history did not record the revoke');
    }
    const peerRevoked = await waitForDataset(bidi, peerContext, (d) => d.granted === false, 20000);
    if (!peerRevoked || peerRevoked.granted !== false) {
      throw new Error('the peer kept control after the revoke');
    }

    // The copy button beside the join link must answer in place, so the row
    // never looks dead when the clipboard write lands.
    await evaluate(bidi, panelContext, "document.getElementById('invite-copy').click(); true");
    await sleep(500);
    const copiedRaw = await evaluate(
      bidi,
      panelContext,
      "JSON.stringify({ label: document.getElementById('invite-copy').textContent, notice: document.getElementById('notice').textContent })"
    );
    const copied = copiedRaw ? JSON.parse(copiedRaw) : {};
    if (copied.label !== 'Copied' && !/copy/i.test(String(copied.notice || ''))) {
      throw new Error(`the copy button did nothing: ${copiedRaw}`);
    }
    if (copied.label === 'Copied') {
      await sleep(1500);
      const reverted = await evaluate(
        bidi,
        panelContext,
        "document.getElementById('invite-copy').textContent"
      );
      if (reverted !== 'Copy') throw new Error(`the copy button stayed at ${reverted}`);
    }

    // A tile dropped on the panel is handed to the page as a URL parameter, so
    // that render is testable without chrome scope.
    await evaluate(
      bidi,
      panelContext,
      `(() => {
        const url = new URL(location.href);
        url.searchParams.set('panelSites', JSON.stringify(['https://www.youtube.com/']));
        location.replace(url.href);
        return true;
      })()`
    ).catch(() => {});
    await sleep(1800);
    const droppedRaw = await evaluate(
      bidi,
      panelContext,
      "JSON.stringify([...document.querySelectorAll('#panel-sites a')].map((node) => node.textContent))"
    ).catch(() => null);
    const dropped = droppedRaw ? JSON.parse(droppedRaw) : [];
    if (dropped.length !== 1 || !String(dropped[0]).includes('youtube')) {
      throw new Error(`the panel dropped list reads ${droppedRaw}`);
    }

    const shortcut = { key: 'Ctrl+Alt+B', proven: false, reason: 'headless run' };

    result = {
      zen: info,
      check: { ok: true, error: null },
      dataset: {
        socket: data.socket,
        source: data.source,
        elapsed: data.elapsed,
        location: data.location,
        peers: Number.isFinite(data.peers)
          ? data.peers
          : Array.isArray(data.peers)
            ? data.peers.length
            : null,
      },
      peer: {
        id: PEER,
        name: PEER_NAME,
        joined: joined.peerList.some((peer) => peer.id === PEER),
        granted: peerGranted.granted,
        revoked: peerRevoked.granted,
        controls: peerRevoked.controls,
      },
      shortcut,
      dock: null,
      panel: {
        state: grantedPanel.state,
        room: grantedPanel.room,
        control: grantedPanel.control,
        peers: revokedPanel.names,
        grantedPeers: revokedPanel.grantedPeers,
        invite: grantedPanel.invite,
        count: grantedPanel.count,
        playback: grantedPanel.playback,
        relay: grantedPanel.relay,
        contrast: Number(contrastRatio(grantedPanel.bg, grantedPanel.fg).toFixed(2)),
        grantedNotice: grantedPanel.notice,
        notice: revokedPanel.notice,
        inviteCopy: copied.label,
        watch: {
          state: grantedPanel.watchState,
          label: grantedPanel.watchLabel,
          disabled: grantedPanel.watchDisabled,
          viewH: grantedPanel.viewH,
          bottom: grantedPanel.watchBottom,
        },
        dropped,
        cached: {
          state: cachedState.state,
          route: cachedState.route,
          peers: cachedState.names,
        },
      },
    };
    log('[zen] room live:', JSON.stringify(result.dataset));
    log('[zen] panel:', JSON.stringify(result.panel));
  } catch (error) {
    result.check.error = error.message;
    log('[zen] failed:', error.message);
  } finally {
    killTree(browser);
    await sleep(300);
  }

  try {
    if (result.check.ok) {
      result.dock = await probeDock(zen);
      if (result.dock.error) {
        result.check.ok = false;
        result.check.error = 'dock: ' + result.dock.error;
      }
      log('[zen] dock', JSON.stringify(result.dock));
    }
  } finally {
    // The dock opens a loopback page, so its relay must outlive the main
    // window. Keep it until the tile pass has read that page.
    killTree(relay);
  }

  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(
    path.join(runtime, 'results.json'),
    JSON.stringify({ when: new Date().toISOString(), ...result }, null, 2) + '\n'
  );
  process.exit(result.check.ok ? 0 : 1);
}

main().catch((error) => {
  console.error('[zen]', error.message);
  process.exit(1);
});

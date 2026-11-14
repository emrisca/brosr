// Docks the extension panel under the tab column in the browser window. The
// layout lives in chrome scope, so this runs over Marionette after Zen starts.
// The drag bar, the per-room height and the show chip survive a reload through
// browser prefs.
import net from 'node:net';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connect(port, timeoutMs) {
  const end = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => resolve(socket));
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > end) reject(new Error(`no Marionette on ${port}`));
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

function rpc(socket, id, name, params = {}) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const colon = buffer.indexOf(':');
      if (colon < 0) return;
      const length = Number(buffer.subarray(0, colon).toString());
      if (buffer.length < colon + 1 + length) return;
      const text = buffer.subarray(colon + 1, colon + 1 + length).toString();
      socket.off('data', onData);
      const message = JSON.parse(text);
      if (message[2]) reject(new Error(String(message[2].message || message[2])));
      else resolve(message[3]);
    };
    socket.on('data', onData);
    const payload = JSON.stringify([0, id, name, params]);
    socket.write(`${Buffer.byteLength(payload)}:${payload}`);
  });
}

// The editor inserts the panel as a column between the tabs and the page. This
// script turns that column into a docked bottom section, adds the bar and adds
// the show chip. The tab box carries a translate, so a fixed child resolves
// against the tab box instead of the window. Moving the box under the document
// body puts the fixed edge back on the window edge.
const INJECT = `(() => {
  const doc = document;
  const root = doc.documentElement;
  const box = doc.getElementById('sidebar-box');
  if (!box) return 'no-sidebar-box';
  const body = doc.body || root;
  const column =
    (doc.getElementById('sidebar-container') &&
      doc.getElementById('sidebar-container').getBoundingClientRect().width > 0 &&
      doc.getElementById('sidebar-container')) ||
    doc.getElementById('navigator-toolbox');
  if (!column) return 'no-column';

  if (box.parentElement !== body) body.appendChild(box);

  const STYLE_ID = 'brosr-split-style';
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '#sidebar-box.brosr-docked {',
      '  position: fixed !important;',
      '  left: 0 !important;',
      '  bottom: 0 !important;',
      '  inset-inline-start: 0 !important;',
      '  translate: 0 !important;',
      '  width: var(--brosr-panel-width, 480px) !important;',
      '  height: var(--brosr-panel-height, 320px) !important;',
      '  min-width: 0 !important;',
      '  max-width: none !important;',
      '  z-index: 12 !important;',
      '  border-top: 1px solid var(--zen-colors-border, rgba(128, 128, 128, 0.35)) !important;',
      '  background: var(--zen-main-browser-background, #1c1b22) !important;',
      '}',
      'html[data-brosr-docked] #sidebar-splitter { display: none !important; }',
      '#brosr-panel-bar {',
      '  position: fixed; left: 0; height: 8px; z-index: 13;',
      '  cursor: row-resize; background: transparent;',
      '}',
      '#brosr-panel-bar::after {',
      '  content: ""; position: absolute; left: 8px; right: 8px; top: 3px;',
      '  height: 2px; border-radius: 1px;',
      '  background: var(--zen-colors-border, rgba(128, 128, 128, 0.4));',
      '}',
      '#brosr-panel-bar:hover::after, #brosr-panel-bar[data-drag="1"]::after {',
      '  background: var(--zen-primary-color, #b98b6a);',
      '}',
      '#brosr-panel-toggle {',
      '  position: fixed; left: 10px; bottom: 10px; z-index: 12;',
      '  padding: 6px 10px; border-radius: 8px; cursor: pointer;',
      '  border: 1px solid var(--zen-colors-border, rgba(128, 128, 128, 0.4));',
      '  background: var(--zen-main-browser-background, #1c1b22);',
      '  color: var(--zen-colors-primary, inherit);',
      '  font: 11px/1.2 system-ui, sans-serif;',
      '}',
      '#brosr-panel-toggle:hover {',
      '  background: var(--zen-colors-hover-bg, rgba(128, 128, 128, 0.18));',
      '}',
      '#brosr-panel-toggle:focus-visible { outline: 2px solid var(--zen-primary-color, #b98b6a); }',
      '#vertical-tabs, #tabbrowser-tabs {',
      '  padding-bottom: var(--brosr-panel-space, 0px) !important;',
      '}',
    ].join(String.fromCharCode(10));
    doc.head.appendChild(style);
  }

  let bar = doc.getElementById('brosr-panel-bar');
  if (!bar) {
    bar = doc.createElementNS('http://www.w3.org/1999/xhtml', 'div');
    bar.id = 'brosr-panel-bar';
    bar.hidden = true;
    body.appendChild(bar);
  }

  let toggle = doc.getElementById('brosr-panel-toggle');
  if (!toggle) {
    toggle = doc.createElementNS('http://www.w3.org/1999/xhtml', 'button');
    toggle.id = 'brosr-panel-toggle';
    toggle.type = 'button';
    toggle.textContent = 'Room panel';
    toggle.setAttribute('aria-label', 'Show the Brosr room panel');
    body.appendChild(toggle);
  }

  const prefInt = (key, fallback) => {
    try {
      return Services.prefs.getIntPref(key, fallback);
    } catch (error) {
      return fallback;
    }
  };
  const prefHas = (key) => {
    try {
      return Services.prefs.prefHasUserValue(key);
    } catch (error) {
      return false;
    }
  };
  const prefString = (key) => {
    try {
      return Services.prefs.getStringPref(key, '');
    } catch (error) {
      return '';
    }
  };

  // The panel rewrites its own URL with the room id, so the dock can key the
  // height by room without asking the panel page.
  const roomId = () => {
    try {
      const browser = doc.getElementById('sidebar');
      const spec = browser && browser.currentURI ? browser.currentURI.spec : '';
      return new URL(spec).searchParams.get('room') || '';
    } catch (error) {
      return '';
    }
  };
  const heightPref = (room) => (room ? 'brosr.panel.height.' + room : 'brosr.panel.height');

  // The sidebar command id looks like \\\`<extension>-sidebar-action\\\`. The pref
  // remembers the exact id the first time the panel opens.
  const sidebarId = () => {
    const saved = prefString('brosr.panel.sidebar-id');
    if (saved) return saved;
    const controller = window.SidebarController;
    if (!controller || !controller.sidebars) return '';
    for (const id of controller.sidebars.keys()) {
      if (String(id).endsWith('-sidebar-action')) return String(id);
    }
    return '';
  };

  window.__brosrShowPanel = (wanted) => {
    const id = wanted || sidebarId();
    if (!id) return '';
    try {
      window.SidebarController.show(id);
    } catch (error) {
      return '';
    }
    return id;
  };

  window.__brosrHidePanel = () => {
    try {
      window.SidebarController.hide();
    } catch (error) {
      return '';
    }
    return String(window.SidebarController.currentID || 'hidden');
  };
  window.__brosrClickToggle = () => {
    toggle.click();
    return !toggle.hidden;
  };

  const readHeight = () => {
    const room = roomId();
    let height = 320;
    if (room && prefHas(heightPref(room))) height = prefInt(heightPref(room), 320);
    else height = prefInt('brosr.panel.height', 320);
    const max = Math.max(160, window.innerHeight - 220);
    return Math.max(120, Math.min(height, max));
  };

  const toolbox = doc.getElementById('navigator-toolbox');
  const wantColumn = () => Math.max(300, Math.min(500, prefInt('brosr.column.width', 480)));

  const apply = () => {
    const open = !box.hidden && box.getBoundingClientRect().width > 0;
    let columnWidth = Math.round(column.getBoundingClientRect().width);
    // A restored window can come back as the thin rail. Set the width Zen
    // itself uses when the column is below the panel minimum.
    if (open && columnWidth < 300 && toolbox) {
      const wanted = wantColumn() + 'px';
      toolbox.style.width = wanted;
      toolbox.style.setProperty('--zen-sidebar-width', wanted);
      toolbox.setAttribute('width', wanted);
      columnWidth = Math.round(column.getBoundingClientRect().width);
    }
    const width = columnWidth > 200 ? columnWidth : wantColumn();
    const height = readHeight();
    const room = roomId();
    root.style.setProperty('--brosr-panel-width', width + 'px');
    root.style.setProperty('--brosr-panel-height', height + 'px');
    root.style.setProperty('--brosr-panel-space', open ? height + 8 + 'px' : '0px');
    if (open) {
      root.setAttribute('data-brosr-docked', '1');
      box.classList.add('brosr-docked');
      const id = window.SidebarController && window.SidebarController.currentID;
      if (id) {
        try {
          Services.prefs.setStringPref('brosr.panel.sidebar-id', String(id));
        } catch (error) {
          // A read-only pref store keeps the id for this session only.
        }
      }
    } else {
      root.removeAttribute('data-brosr-docked');
      box.classList.remove('brosr-docked');
    }
    bar.hidden = !open;
    bar.style.left = '0px';
    bar.style.width = width + 'px';
    bar.style.bottom = height + 'px';
    toggle.hidden = open;
    const rect = box.getBoundingClientRect();
    return {
      docked: box.classList.contains('brosr-docked'),
      open,
      width,
      height,
      room,
      sidebar: sidebarId(),
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      panelWidth: Math.round(rect.width),
      panelHeight: Math.round(rect.height),
      bar: !bar.hidden,
      toggle: !toggle.hidden,
    };
  };
  window.__brosrDock = apply;

  if (!bar.__brosrWired) {
    bar.__brosrWired = true;
    let drag = null;
    bar.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      drag = { y: event.clientY, height: readHeight() };
      bar.setAttribute('data-drag', '1');
      try {
        bar.setPointerCapture(event.pointerId);
      } catch (error) {
        // Capture is a nicety, not a requirement.
      }
    });
    const move = (event) => {
      if (!drag) return;
      const max = Math.max(160, window.innerHeight - 220);
      const height = Math.max(120, Math.min(max, drag.height + (drag.y - event.clientY)));
      root.style.setProperty('--brosr-panel-height', height + 'px');
      root.style.setProperty('--brosr-panel-space', height + 8 + 'px');
      bar.style.bottom = height + 'px';
    };
    const end = () => {
      if (!drag) return;
      drag = null;
      bar.removeAttribute('data-drag');
      const height = Math.round(
        parseFloat(root.style.getPropertyValue('--brosr-panel-height')) || 320
      );
      const room = roomId();
      try {
        Services.prefs.setIntPref('brosr.panel.height', height);
        if (room) Services.prefs.setIntPref(heightPref(room), height);
      } catch (error) {
        // A read-only pref store leaves the height for this session only.
      }
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
    toggle.addEventListener('click', () => {
      if (!window.__brosrShowPanel()) {
        toggle.textContent = 'No room panel';
      }
    });
  }

  if (!window.__brosrPanelTimer) {
    window.__brosrPanelTimer = setInterval(apply, 500);
    window.addEventListener('resize', apply);
  }
  return apply();
})()`;
const SCRIPT = `return ${INJECT}`;
const SHOW = 'return (window.__brosrShowPanel ? window.__brosrShowPanel() : "")';
const showScript = (id) =>
  `return (window.__brosrShowPanel ? window.__brosrShowPanel(${JSON.stringify(id)}) : "")`;
const READ = 'return (window.__brosrDock ? window.__brosrDock() : null)';

// A fresh session can land while the window restores, and Marionette then
// reports a discarded context. A retry after the window settles succeeds.
// open=true shows the panel and then reads the geometry, because a new session
// replaces the window and any browsing context from before.
export async function dockPanel({
  port = 2828,
  timeoutMs = 20000,
  attempts = 4,
  open = false,
  sidebarId = '',
  after = [],
} = {}) {
  let last = 'not started';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let socket;
    try {
      socket = await connect(port, timeoutMs);
    } catch (error) {
      return { ok: false, error: error.message };
    }
    try {
      await rpc(socket, 1, 'WebDriver:NewSession', { capabilities: {} });
      await sleep(1200);
      await rpc(socket, 2, 'Marionette:SetContext', { value: 'chrome' });
      await sleep(200);
      const injected = await rpc(socket, 3, 'WebDriver:ExecuteScript', {
        script: SCRIPT,
        args: [],
      });
      let state = injected && injected.value;
      if (typeof state === 'string') return { ok: false, error: state };
      if (!open) return { ok: true, attempt, result: state };
      let shown = null;
      if (open) {
        const result = await rpc(socket, 4, 'WebDriver:ExecuteScript', {
          script: sidebarId ? showScript(sidebarId) : SHOW,
          args: [],
        });
        shown = result && result.value;
        await sleep(1500);
        const read = await rpc(socket, 5, 'WebDriver:ExecuteScript', { script: READ, args: [] });
        if (read && read.value) state = read.value;
      }
      // Later steps share this session, because a new session replaces the
      // window and its sidebar.
      const steps = [];
      let id = 6;
      for (const step of after) {
        if (step.wait) await sleep(step.wait);
        const out = await rpc(socket, id++, 'WebDriver:ExecuteScript', {
          script: step.script,
          args: [],
        });
        steps.push(out && out.value);
      }
      return { ok: true, attempt, result: state, shown, steps };
    } catch (error) {
      last = error.message;
      await sleep(900);
    } finally {
      socket.end();
    }
  }
  return { ok: false, error: last };
}

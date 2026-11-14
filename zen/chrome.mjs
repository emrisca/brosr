// Docks the extension panel under the tab column in the browser window. The
// layout lives in chrome scope, so this runs over Marionette after Zen starts.
// The drag bar and the height survive a reload through a browser pref.
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
// script turns that column into a docked bottom section and adds the bar.
const INJECT = `(() => {
  const doc = document;
  const root = doc.documentElement;
  const box = doc.getElementById('sidebar-box');
  if (!box) return 'no-sidebar-box';
  const column =
    (doc.getElementById('sidebar-container') &&
      doc.getElementById('sidebar-container').getBoundingClientRect().width > 0 &&
      doc.getElementById('sidebar-container')) ||
    doc.getElementById('navigator-toolbox');
  if (!column) return 'no-column';

  const STYLE_ID = 'brosr-split-style';
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '#sidebar-box.brosr-docked {',
      '  position: fixed !important;',
      '  left: 0 !important;',
      '  bottom: 0 !important;',
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
      '#vertical-tabs, #tabbrowser-tabs {',
      '  padding-bottom: var(--brosr-panel-space, 0px) !important;',
      '}',
    ].join('\\n');
    doc.head.appendChild(style);
  }

  let bar = doc.getElementById('brosr-panel-bar');
  if (!bar) {
    bar = doc.createElementNS('http://www.w3.org/1999/xhtml', 'div');
    bar.id = 'brosr-panel-bar';
    bar.hidden = true;
    doc.documentElement.appendChild(bar);
  }

  const readHeight = () => {
    let height = 320;
    try {
      height = Services.prefs.getIntPref('brosr.panel.height', 320);
    } catch (error) {
      height = 320;
    }
    const max = Math.max(160, window.innerHeight - 220);
    return Math.max(120, Math.min(height, max));
  };

  const toolbox = doc.getElementById('navigator-toolbox');
  const wantColumn = () => {
    let stored = 480;
    try {
      stored = Services.prefs.getIntPref('brosr.column.width', 480);
    } catch (error) {
      stored = 480;
    }
    return Math.max(300, Math.min(500, stored));
  };

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
    root.style.setProperty('--brosr-panel-width', width + 'px');
    root.style.setProperty('--brosr-panel-height', height + 'px');
    root.style.setProperty('--brosr-panel-space', open ? height + 8 + 'px' : '0px');
    if (open) {
      root.setAttribute('data-brosr-docked', '1');
      box.classList.add('brosr-docked');
    } else {
      root.removeAttribute('data-brosr-docked');
    }
    bar.hidden = !open;
    bar.style.left = '0px';
    bar.style.width = width + 'px';
    bar.style.bottom = height + 'px';
    return { open, width, height };
  };

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
      const height = parseFloat(root.style.getPropertyValue('--brosr-panel-height')) || 320;
      try {
        Services.prefs.setIntPref('brosr.panel.height', Math.round(height));
      } catch (error) {
        // A read-only pref store leaves the height for this session only.
      }
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
  }

  if (!window.__brosrPanelTimer) {
    window.__brosrPanelTimer = setInterval(apply, 500);
    window.addEventListener('resize', apply);
  }
  const state = apply();
  return 'docked width=' + state.width + ' height=' + state.height + ' open=' + state.open;
})()`;
const SCRIPT = `return ${INJECT}`;

// A fresh session can land while the window restores, and Marionette then
// reports a discarded context. A retry after the window settles succeeds.
export async function dockPanel({ port = 2828, timeoutMs = 20000, attempts = 4 } = {}) {
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
      const result = await rpc(socket, 3, 'WebDriver:ExecuteScript', { script: SCRIPT, args: [] });
      return { ok: true, attempt, result: result && result.value };
    } catch (error) {
      last = error.message;
      await sleep(900);
    } finally {
      socket.end();
    }
  }
  return { ok: false, error: last };
}

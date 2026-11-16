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
  // The panel floats inside the column, so it keeps the same gap on each side
  // as the surfaces Zen draws there.
  const INSET = 8;
  // The toolbox is the visible tab column. Zen keeps a second container beside
  // it that can report a stale width, so the toolbox wins when it has a size.
  const toolboxBox = doc.getElementById('navigator-toolbox');
  const sidebarBox = doc.getElementById('sidebar-container');
  const sized = (el) => el && el.getBoundingClientRect().width > 0;
  const column = sized(toolboxBox) ? toolboxBox : sized(sidebarBox) ? sidebarBox : toolboxBox;
  if (!column) return 'no-column';

  if (box.parentElement !== body) body.appendChild(box);

  const STYLE_ID = 'brosr-split-style';
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '#sidebar-box.brosr-docked {',
      '  position: fixed !important;',
      '  left: var(--brosr-panel-left, 8px) !important;',
      '  bottom: var(--brosr-panel-inset, 8px) !important;',
      '  inset-inline-start: var(--brosr-panel-left, 8px) !important;',
      '  translate: 0 !important;',
      '  width: var(--brosr-panel-width, 464px) !important;',
      '  height: var(--brosr-panel-height, 320px) !important;',
      '  min-width: 0 !important;',
      '  max-width: none !important;',
      '  z-index: 12 !important;',
      '  border: 1px solid color-mix(in srgb, currentColor 20%, transparent) !important;',
      '  border-radius: var(--brosr-panel-radius, 8px) !important;',
      '  overflow: hidden !important;',
      '  background: transparent !important;',
      '  animation: brosr-rise 180ms cubic-bezier(0.2, 0.8, 0.2, 1);',
      '}',
      // The column owns the left edge and the full height. Its top strip is the
      // window frame, so the window controls show there and a drag moves the
      // window. The top bar starts where the column ends, which keeps the field
      // off that strip. The column keeps a 315 pixel floor, the width the room
      // layout was drawn at, and the splitter still reaches 640.
      '#navigator-toolbox {',
      '  clip-path: none !important;',
      '}',
      ':root[zen-sidebar-expanded="true"] #navigator-toolbox {',
      '  min-width: 315px !important;',
      '}',
      // The top bar is its own strip across the whole window, and the column
      // starts under it. Hiding the column leaves the bar in place, and hiding
      // the bar leaves the column in place. The bar pulls itself back by its own
      // measured left edge, which holds whether the column is open or collapsed.
      // The wrapper keeps the row height in place, so the page still starts
      // under the bar while the bar itself leaves the column.
      '#zen-appcontent-navbar-wrapper {',
      '  min-height: var(--brosr-bar-height, 42px) !important;',
      '  z-index: 30 !important; overflow: visible !important;',
      '}',
      // The container is fixed to the window edge, so the strip spans the window
      // in every column state. Hiding the column never moves the bar.
      '#zen-appcontent-navbar-container {',
      '  position: fixed !important;',
      '  top: 0 !important; left: 0 !important; right: auto !important; bottom: auto !important;',
      '  width: 100vw !important; margin-inline-start: 0 !important;',
      '  background-color: var(--zen-main-browser-background, Canvas) !important;',
      '  -moz-window-dragging: drag !important;',
      '}',
      // The window controls sit at the bar's left end on a mac and at its right
      // end elsewhere. The bar keeps that end free, so no button lands on the
      // lights at any width.
      '#nav-bar {',
      '  box-sizing: border-box !important;',
      '  width: 100% !important; flex: 1 1 auto !important;',
      '  margin-inline-start: 0 !important;',
      '  padding-inline-start: 88px !important;',
      '}',
      'html[data-brosr-os="win"] #nav-bar,',
      'html[data-brosr-os="linux"] #nav-bar {',
      '  padding-inline-start: 4px !important; padding-inline-end: 88px !important;',
      '}',
      '#nav-bar toolbarbutton, #nav-bar #urlbar-container {',
      '  -moz-window-dragging: no-drag !important;',
      '}',
      // Zen hides its compact toggle. This layout keeps it in the top bar, so
      // the button shows there with a hit box of its own.
      'toolbarbutton[command="cmd_toggleCompactModeIgnoreHover"] {',
      '  display: inline-flex !important; flex: 0 0 28px !important;',
      '  width: 28px !important; height: 28px !important; min-width: 28px !important;',
      '  margin: 0 2px !important;',
      '}',
      // Zen centers the field with two springs. This row gives the field the
      // free width, so the springs take none.
      '#customizableui-special-spring1, #customizableui-special-spring2 {',
      '  flex: 0 0 0 !important; width: 0 !important; min-width: 0 !important;',
      '  margin: 0 !important;',
      '}',
      // The field takes the free width, so it fills the bar instead of keeping
      // Zen's 62rem cap. The buttons keep their own width beside it.
      '#urlbar-container { flex: 1 1 auto !important; width: auto !important; max-width: none !important; }',
      '#urlbar { width: 100% !important; max-width: none !important; }',
      // The space name is gone. The tiles are the bookmark row, so they carry
      // their own heading above the tab list.
      '#zen-current-workspace-indicator-container, .zen-current-workspace-indicator {',
      '  display: none !important;',
      '}',
      '#brosr-sites-label {',
      '  display: flex; align-items: center; padding: 12px 16px 0;',
      '  font: 600 11px/1 system-ui, sans-serif; letter-spacing: 0.1em;',
      '  text-transform: uppercase; opacity: 0.55;',
      '}',
      // Zen draws a rule between the name and the new tab row. The name stands
      // alone here, so the rule goes.
      '#tabbrowser-tabs toolbarseparator { display: none !important; }',
      // The foot row keeps the library button, the space dots and the new tab
      // button. It sits above the room panel, so the panel never covers it.
      '#TabsToolbar { position: relative !important; }',
      '#zen-sidebar-foot-buttons {',
      '  position: absolute !important; left: 0 !important; right: 0 !important;',
      '  bottom: calc(var(--brosr-panel-space, 0px) + 6px) !important;',
      '  margin: 0 !important; padding: 0 16px !important; height: 30px !important;',
      '  display: flex !important; align-items: center;',
      '  justify-content: space-between !important;',
      '  background: transparent !important;',
      '}',
      '#zen-library-download-list { display: none !important; }',
      // The dots are one per space. Zen hides the strip in this layout, so the
      // dock turns it back on and centers the row.
      '#zen-workspaces-button, #zen-workspaces-button[dont-show] {',
      '  display: flex !important; align-items: center; justify-content: center;',
      '  gap: 4px; opacity: 1 !important; overflow: visible !important;',
      '}',
      // Each space is a plain dot, so the row reads the same in every space.
      '#zen-workspaces-button .zen-workspace-icon {',
      '  width: 8px !important; height: 8px !important;',
      '  border-radius: 50% !important; min-width: 8px !important;',
      '  background: color-mix(in srgb, currentColor 45%, transparent) !important;',
      '}',
      'html[data-brosr-docked] #sidebar-splitter { display: none !important; }',
      // A slight translucency on the window surface, and only when the platform
      // draws a material behind the window. A plain window would turn grey.
      // A compact window slides the column over the page. The column paints its
      // own surface there, so the page never shows through the row or the tabs.
      ':root[zen-compact-mode="true"] #navigator-toolbox,',
      ':root[zen-compact-mode="true"] #titlebar,',
      ':root[zen-compact-mode="true"] #vertical-tabs,',
      ':root[zen-compact-mode="true"] #tabbrowser-tabs {',
      '  background-color: var(--zen-main-browser-background, Canvas) !important;',
      '  background-image: none !important;',
      '  backdrop-filter: none !important;',
      '}',
      ':root { --brosr-surface-alpha: 0.86; }',
      'html[data-brosr-clear="1"] .zen-browser-generic-background::after {',
      '  opacity: calc(var(--zen-background-opacity, 1) * var(--brosr-surface-alpha)) !important;',
      '}',
      '#brosr-panel-bar {',
      '  position: fixed; left: var(--brosr-panel-left, 8px); height: 12px; z-index: 14;',
      '  cursor: row-resize; background: transparent; touch-action: none;',
      '}',
      '#brosr-panel-bar::after {',
      '  content: ""; position: absolute; left: 8px; right: 8px; top: 5px;',
      '  height: 2px; border-radius: 1px;',
      '  background: color-mix(in srgb, currentColor 35%, transparent);',
      '  transition: background-color 120ms ease;',
      '}',
      '#brosr-panel-bar:hover::after, #brosr-panel-bar[data-drag="1"]::after {',
      '  background: currentColor;',
      '}',
      // The window controls keep the frame strip above the tiles. The platform
      // draws the buttons and their order, so this only pins the box. A mac
      // window puts the lights on the left, and Windows and Linux keep theirs
      // on the right.
      '.titlebar-buttonbox-container {',
      '  position: fixed !important; top: 10px !important; z-index: 40 !important;',
      '  margin: 0 !important;',
      '}',
      'html[data-brosr-os="mac"] .titlebar-buttonbox-container {',
      '  left: 12px !important; right: auto !important;',
      '}',
      'html[data-brosr-os="win"] .titlebar-buttonbox-container,',
      'html[data-brosr-os="linux"] .titlebar-buttonbox-container {',
      '  left: auto !important; right: 12px !important;',
      '}',
      // The column header is the window frame, so a drag there moves the window.
      // The tabs, the tiles and the docked panel keep the pointer.
      '#navigator-toolbox { -moz-window-dragging: drag !important; }',
      '#vertical-tabs, sidebar-main, #tabbrowser-tabs, #brosr-sites,',
      '#brosr-panel-toggle, #brosr-panel-bar, #sidebar-box {',
      '  -moz-window-dragging: no-drag !important;',
      '}',
      '#titlebar { -moz-window-dragging: drag !important; }',
      '#brosr-panel-toggle {',
      '  position: fixed; left: var(--brosr-panel-left, 8px); bottom: 8px; z-index: 12;',
      '  max-width: var(--brosr-panel-width, 300px);',
      '  display: inline-flex; align-items: center; gap: 6px;',
      '  padding: 6px 10px; border-radius: 8px; cursor: pointer;',
      '  border: 1px solid color-mix(in srgb, currentColor 22%, transparent);',
      '  background: var(--zen-main-browser-background, Canvas);',
      '  color: inherit;',
      '  font: 11px/1.2 system-ui, sans-serif;',
      '  animation: brosr-fade 120ms ease-out;',
      '  transition: background-color 120ms ease;',
      '}',
      '#brosr-panel-toggle::before {',
      '  content: ""; width: 6px; height: 6px; border-radius: 50%;',
      '  background: currentColor; opacity: 0.6;',
      '}',
      '#brosr-panel-toggle:hover {',
      '  background: color-mix(in srgb, currentColor 12%, transparent);',
      '}',
      '#brosr-panel-toggle:focus-visible { outline: 2px solid currentColor; outline-offset: 1px; }',
      // The sites bar is a second tab strip. Each site is one compact tab that
      // takes its fill and radius from the same variables Zen paints its own
      // tabs with, so the strip sits in the column instead of on top of it.
      '#brosr-sites {',
      '  display: flex; align-items: center; gap: 6px; padding: 6px 8px 8px;',
      '  width: 100%; flex: 0 0 auto; overflow: hidden;',
      // The side padding comes out of the width, so the last tile ends at the
      // column edge instead of past it.
      '  box-sizing: border-box !important;',
      '  background: transparent;',
      '}',
      '#brosr-sites[hidden] { display: none !important; }',
      // The add form takes the whole row, so a narrow column never has to fit
      // a field inside one tile.
      '#brosr-sites[data-adding="1"] { display: block; }',
      '#brosr-sites .brosr-site {',
      '  position: relative; display: flex; flex: 1 1 0;',
      '  align-items: center; gap: 6px; min-width: 0; height: 32px;',
      '  padding: 0 8px; border: 1px solid transparent;',
      '  border-radius: var(--tab-border-radius, 8px); cursor: grab;',
      '  background: transparent; color: inherit;',
      '  font: 500 12px/1 system-ui, sans-serif;',
      '  user-select: none; touch-action: none;',
      '  transition: background-color 120ms ease, border-color 120ms ease;',
      '}',
      '#brosr-sites .brosr-site:hover {',
      '  background: var(--tab-background-color-hover, color-mix(in srgb, currentColor 10%, transparent));',
      '}',
      '#brosr-sites .brosr-site:focus-visible { outline: 2px solid currentColor; outline-offset: 1px; }',
      '#brosr-sites .brosr-site[data-drag="1"] { opacity: 0.6; cursor: grabbing; }',
      '#brosr-sites .brosr-site[data-over="1"] {',
      '  border-color: var(--base-border-color, currentColor);',
      '}',
      // A site that already holds the selected tab reads the way a selected tab
      // reads, with the same fill, edge and lift Zen gives one.
      // The fill is the one Zen gives a selected tab. That variable lives on the
      // tab strip, so the same value stands in as the fallback here.
      '#brosr-sites .brosr-site[data-current="1"] {',
      '  border-color: var(--base-border-color, transparent);',
      '  background: var(--tab-background-color-selected, light-dark(rgba(255, 255, 255, 0.82), rgba(255, 255, 255, 0.18)));',
      '  box-shadow: var(--tab-box-shadow-selected, none);',
      '}',
      '#brosr-sites .brosr-site-slot {',
      '  position: relative; display: inline-flex; flex: none;',
      '  align-items: center; justify-content: center; width: 16px; height: 16px;',
      '}',
      '#brosr-sites .brosr-site-icon { position: absolute; inset: 0; width: 16px; height: 16px; }',
      '#brosr-sites .brosr-site-mark {',
      '  font: 600 10px/1 system-ui, sans-serif; opacity: 0.6;',
      '}',
      // The name sits beside the favicon, so the strip reads as a tab row.
      '#brosr-sites .brosr-site-label {',
      '  flex: 1 1 auto; min-width: 0; overflow: hidden; opacity: 0.78;',
      '  text-overflow: ellipsis; white-space: nowrap;',
      '}',
      '#brosr-sites .brosr-site[data-current="1"] .brosr-site-label,',
      '#brosr-sites .brosr-site:hover .brosr-site-label { opacity: 1; }',
      // A tile has no button of its own. A right click opens the menu, which
      // keeps the whole tile one target.
      '#brosr-site-menu {',
      '  position: fixed; z-index: 60; min-width: 180px; padding: 4px;',
      '  display: flex; flex-direction: column; gap: 1px;',
      '  border: 1px solid color-mix(in srgb, currentColor 18%, transparent);',
      '  border-radius: 8px; background: var(--zen-main-browser-background, Canvas);',
      '  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28); color: inherit;',
      '  font: 12px/1.2 system-ui, sans-serif;',
      '}',
      '#brosr-site-menu[hidden] { display: none !important; }',
      '#brosr-site-menu button {',
      '  display: flex; align-items: center; width: 100%; height: 26px;',
      '  padding: 0 8px; border: 0; border-radius: 5px;',
      '  background: transparent; color: inherit; cursor: pointer;',
      '  font: inherit; text-align: start;',
      '}',
      '#brosr-site-menu button:hover {',
      '  background: color-mix(in srgb, currentColor 12%, transparent);',
      '}',
      '#brosr-site-menu button:focus-visible { outline: 2px solid currentColor; outline-offset: 1px; }',
      '#brosr-site-menu hr {',
      '  margin: 3px 4px; border: 0;',
      '  border-top: 1px solid color-mix(in srgb, currentColor 14%, transparent);',
      '}',
      // The star sits in the urlbar, left of the site data icon. It reports
      // whether the page is in the row, and a click adds or removes it.
      '#brosr-star {',
      '  display: inline-flex !important; align-items: center; justify-content: center;',
      '  width: 24px !important; height: 24px !important; padding: 0 !important;',
      '  margin: 0 2px 0 0 !important; border: 0 !important; border-radius: 6px;',
      '  background: transparent !important; color: inherit !important;',
      '  cursor: pointer; opacity: 0.6;',
      '  transition: background-color 120ms ease, opacity 120ms ease;',
      '}',
      '#brosr-star:hover {',
      '  opacity: 1;',
      '  background: color-mix(in srgb, currentColor 12%, transparent) !important;',
      '}',
      '#brosr-star[data-on="1"] { opacity: 1; color: var(--zen-primary-color, currentColor) !important; }',
      '#brosr-star svg {',
      '  width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.6;',
      '}',
      '#brosr-star[data-on="1"] svg { fill: currentColor; }',
      '#brosr-star[data-off="1"] { display: none !important; }',
      '#brosr-sites .brosr-site-form {',
      '  display: flex; gap: 6px; align-items: center; width: 100%;',
      '}',
      '#brosr-sites .brosr-site-form input {',
      '  flex: 1 1 auto; min-width: 0; height: 32px; padding: 0 10px;',
      '  border: 1px solid color-mix(in srgb, currentColor 18%, transparent);',
      '  border-radius: var(--tab-border-radius, 8px);',
      '  background: color-mix(in srgb, currentColor 6%, transparent);',
      '  color: inherit; font: 12px/1 system-ui, sans-serif;',
      '}',
      '#brosr-sites .brosr-site-form input:focus-visible { outline: 2px solid currentColor; outline-offset: 1px; }',
      '#brosr-sites .brosr-site-error {',
      '  flex: 1 1 100%; margin: 2px 0 0;',
      '  color: inherit; font: 11px/1.3 system-ui, sans-serif; opacity: 0.7;',
      '}',
      '#brosr-sites .brosr-site-form button {',
      '  flex: none; height: 32px; padding: 0 10px; cursor: pointer;',
      '  border: 1px solid color-mix(in srgb, currentColor 18%, transparent);',
      '  border-radius: var(--tab-border-radius, 8px); background: transparent; color: inherit;',
      '  font: 500 12px/1 system-ui, sans-serif;',
      '}',
      '#brosr-sites .brosr-site-form button[type="submit"] {',
      '  background: color-mix(in srgb, currentColor 10%, transparent);',
      '}',
      '#vertical-tabs, #tabbrowser-tabs {',
      '  padding-bottom: var(--brosr-panel-space, 0px) !important;',
      '}',
      '@keyframes brosr-rise {',
      '  from { opacity: 0; transform: translateY(6px); }',
      '  to { opacity: 1; transform: none; }',
      '}',
      '@keyframes brosr-fade {',
      '  from { opacity: 0; }',
      '  to { opacity: 1; }',
      '}',
      '@media (prefers-reduced-motion: reduce) {',
      '  #sidebar-box.brosr-docked, #brosr-panel-toggle { animation: none !important; }',
      '}',
    ].join(String.fromCharCode(10));
    doc.head.appendChild(style);
  }

  let bar = doc.getElementById('brosr-panel-bar');
  if (!bar) {
    bar = doc.createElementNS('http://www.w3.org/1999/xhtml', 'div');
    bar.id = 'brosr-panel-bar';
    bar.setAttribute('role', 'separator');
    bar.setAttribute('aria-orientation', 'horizontal');
    bar.setAttribute('aria-label', 'Resize the room panel');
    bar.hidden = true;
    body.appendChild(bar);
  }

  let toggle = doc.getElementById('brosr-panel-toggle');
  if (!toggle) {
    toggle = doc.createElementNS('http://www.w3.org/1999/xhtml', 'button');
    toggle.id = 'brosr-panel-toggle';
    toggle.type = 'button';
    toggle.textContent = 'Brosr room';
    toggle.setAttribute('aria-label', 'Show the Brosr room panel');
    toggle.title = 'Show the Brosr room panel';
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
  const prefBool = (key, fallback) => {
    try {
      return Services.prefs.getBoolPref(key, fallback);
    } catch (error) {
      return fallback;
    }
  };

  // The essentials bar replaces the spaces strip. Two pages ship as defaults, and
  // the list lives in a pref so a drag survives a reload. A drop on the room
  // panel hands the page to the panel list, and a drop off the bar removes it.
  const SITE_DEFAULTS = ['https://www.youtube.com/', 'https://fmhy.net/'];
  const hostName = (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (error) {
      return String(url);
    }
  };
  const readList = (key) => {
    try {
      const value = JSON.parse(prefString(key) || '[]');
      return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
    } catch (error) {
      return [];
    }
  };
  const writeList = (key, list) => {
    try {
      Services.prefs.setStringPref(key, JSON.stringify(list));
    } catch (error) {
      // A read-only store keeps the change for this session.
    }
  };
  if (!prefHas('brosr.sites')) writeList('brosr.sites', SITE_DEFAULTS);
  let sites = readList('brosr.sites');
  const saveSites = () => writeList('brosr.sites', sites);

  let sitesBar = doc.getElementById('brosr-sites');
  if (!sitesBar) {
    sitesBar = doc.createElementNS('http://www.w3.org/1999/xhtml', 'div');
    sitesBar.id = 'brosr-sites';
    sitesBar.setAttribute('role', 'toolbar');
    sitesBar.setAttribute('aria-label', 'Essentials');
  }
  // The tiles are the essentials row, so a heading names the strip and the
  // space name that used to sit here goes.
  let sitesLabel = doc.getElementById('brosr-sites-label');
  if (!sitesLabel) {
    sitesLabel = doc.createElementNS('http://www.w3.org/1999/xhtml', 'div');
    sitesLabel.id = 'brosr-sites-label';
    sitesLabel.textContent = 'Essentials';
  }
  // The tiles sit at the very top of the left column, above the tabs.
  if (sitesBar.parentElement !== column) column.insertBefore(sitesBar, column.firstChild);
  if (sitesLabel.nextElementSibling !== sitesBar) column.insertBefore(sitesLabel, sitesBar);

  // A tile names the page by its own title, the way a bookmark reads. The title
  // comes from the history entry, and a page with no title keeps its host name.
  const titles = new Map();
  const titleTried = new Set();
  const titleOf = (url) => titles.get(url) || hostName(url);
  const fillTitles = () => {
    for (const url of sites) {
      if (titles.has(url) || titleTried.has(url)) continue;
      titleTried.add(url);
      try {
        PlacesUtils.history
          .fetch(url)
          .then((page) => {
            const title = page && page.title ? String(page.title).trim() : '';
            if (!title) return;
            titles.set(url, title);
            for (const tile of sitesBar.querySelectorAll('.brosr-site[data-index]')) {
              if (tile.dataset.url !== url) continue;
              const label = tile.querySelector('.brosr-site-label');
              if (label) label.textContent = title;
              tile.setAttribute('aria-label', title);
            }
          })
          .catch(() => {});
      } catch (error) {
        // A build without Places keeps the host name.
      }
    }
  };

  const tabList = () => {
    const browser = window.gBrowser;
    return browser && browser.tabs ? Array.from(browser.tabs) : [];
  };
  const tabUrl = (tab) => {
    try {
      return String(tab.linkedBrowser && tab.linkedBrowser.currentURI.spec) || '';
    } catch (error) {
      return '';
    }
  };
  const tabTag = (tab) => {
    try {
      return String(tab.getAttribute('brosr-open') || '');
    } catch (error) {
      return '';
    }
  };
  // A tab that is still loading reports about:blank, so a second click in that
  // moment reads the host the tab was opened for.
  const findTab = (url) => {
    const host = hostName(url);
    for (const tab of tabList()) {
      const spec = tabUrl(tab);
      const pending = !spec || spec === 'about:blank';
      if (pending) {
        if (tabTag(tab) === host) return tab;
        continue;
      }
      if (!/^https?:/i.test(spec)) continue;
      if (spec === url || hostName(spec) === host) return tab;
    }
    return null;
  };
  // A tile behaves like a tab. A click selects the tab that already holds that
  // site, and only a missing tab opens one. A modified click opens a fresh tab
  // in the background, the way a sidebar tab or a bookmark does.
  const openSite = (url, options = {}) => {
    const browser = window.gBrowser;
    const found = options.background ? null : findTab(url);
    if (found) {
      try {
        browser.selectedTab = found;
        return true;
      } catch (error) {
        // A locked tab still leaves the new tab path below.
      }
    }
    try {
      const principal = Services.scriptSecurityManager.getSystemPrincipal();
      const tab = browser.addTab(url, {
        triggeringPrincipal: principal,
        inBackground: Boolean(options.background),
        relatedToCurrent: true,
      });
      if (tab) tab.setAttribute('brosr-open', hostName(url));
      return true;
    } catch (error) {
      try {
        window.openTrustedLinkIn(url, options.background ? 'tabshifted' : 'tab');
        return true;
      } catch (inner) {
        // A chrome without the tab browser leaves the click inert.
        return false;
      }
    }
  };

  // The panel floats in the column above the page bottom, so a drop inside its
  // rectangle is a hand off. Anything else off the bar is a delete.
  const dropSite = (from, x, y) => {
    const url = sites[from];
    if (!url) return sites.slice();
    const panelRect = box.getBoundingClientRect();
    const panelStyle = window.getComputedStyle(box);
    const panelOpen =
      !box.hidden &&
      panelStyle.visibility !== 'hidden' &&
      panelRect.width > 0 &&
      panelRect.height > 0;
    const onPanel =
      panelOpen &&
      x >= panelRect.left &&
      x <= panelRect.right &&
      y >= panelRect.top &&
      y <= panelRect.bottom;
    if (onPanel) {
      sites.splice(from, 1);
      saveSites();
      const moved = readList('brosr.sites.panel');
      moved.push(url);
      writeList('brosr.sites.panel', moved);
      renderSites();
      syncPanelSites();
      return sites.slice();
    }
    const barRect = sitesBar.getBoundingClientRect();
    const inside =
      x >= barRect.left && x <= barRect.right && y >= barRect.top - 6 && y <= barRect.bottom + 6;
    if (!inside) {
      sites.splice(from, 1);
      saveSites();
      renderSites();
      return sites.slice();
    }
    const hit = doc.elementFromPoint(x, y);
    const over = hit && hit.closest ? hit.closest('.brosr-site[data-index]') : null;
    let to = over ? Number(over.dataset.index) : sites.length - 1;
    if (!Number.isFinite(to)) to = from;
    if (to !== from) {
      const moved = sites.splice(from, 1)[0];
      sites.splice(to, 0, moved);
      saveSites();
      renderSites();
    }
    return sites.slice();
  };

  // The panel page cannot read a pref, so a moved tile is handed to it as a
  // URL parameter. The dock reloads only the extension sidebar, and only when
  // its list differs from the one in the page URL.
  let lastPanelSync = 0;
  const syncPanelSites = () => {
    if (Date.now() - lastPanelSync < 4000) return;
    try {
      const wrapper = doc.getElementById('sidebar');
      const inner =
        wrapper && wrapper.contentDocument && wrapper.contentDocument.querySelector('browser');
      if (!inner || !inner.currentURI) return;
      const spec = inner.currentURI.spec;
      if (!spec.startsWith('moz-extension://')) return;
      const url = new URL(spec);
      const moved = readList('brosr.sites.panel');
      const wanted = moved.length ? JSON.stringify(moved) : '';
      if ((url.searchParams.get('panelSites') || '') === wanted) return;
      if (wanted) url.searchParams.set('panelSites', wanted);
      else url.searchParams.delete('panelSites');
      lastPanelSync = Date.now();
      const principal = Services.scriptSecurityManager.getSystemPrincipal();
      inner.loadURI(url.href, { triggeringPrincipal: principal });
    } catch (error) {
      // A remote or hidden panel keeps the list for the next open.
    }
  };

  // The add form takes the bar, so one field serves any tile width. A link
  // without a scheme gets https, and only http and https reach the list.
  const normalizeSite = (value) => {
    const text = String(value || '').trim();
    if (!text) return '';
    const spec = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : 'https://' + text;
    try {
      const url = new URL(spec);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      if (!url.hostname) return '';
      return url.toString();
    } catch (error) {
      return '';
    }
  };

  let adding = false;
  let editing = -1;
  let addText = '';
  let addError = '';

  const addSite = (value) => {
    const url = normalizeSite(value);
    if (!url) {
      addError = 'Enter an http or https link.';
      renderSites();
      return sites.slice();
    }
    if (editing >= 0 && editing < sites.length) {
      const before = sites[editing];
      titles.delete(before);
      titleTried.delete(before);
      if (sites.includes(url) && sites[editing] !== url) sites.splice(editing, 1);
      else sites[editing] = url;
      addText = '';
    } else if (!sites.includes(url)) {
      sites.push(url);
    }
    editing = -1;
    saveSites();
    adding = false;
    addText = '';
    addError = '';
    renderSites();
    return sites.slice();
  };

  const removeSite = (index) => {
    if (!sites[index]) return sites.slice();
    if (index === editing) editing = -1;
    sites.splice(index, 1);
    saveSites();
    renderSites();
    return sites.slice();
  };

  // A tile belongs to the bookmark bar, so a right click opens a menu with the
  // actions that bar offers. The row itself keeps no button, so every tile is
  // one target.
  let menuIndex = -1;
  const NS = 'http://www.w3.org/1999/xhtml';
  let tileMenu = doc.getElementById('brosr-site-menu');
  if (!tileMenu) {
    tileMenu = doc.createElementNS(NS, 'div');
    tileMenu.id = 'brosr-site-menu';
    tileMenu.setAttribute('role', 'menu');
    tileMenu.hidden = true;
    body.appendChild(tileMenu);
  }
  const startEdit = (index) => {
    if (!sites[index]) return;
    editing = index;
    adding = true;
    addText = sites[index];
    addError = '';
    renderSites();
  };
  const closeMenu = () => {
    tileMenu.hidden = true;
    menuIndex = -1;
  };
  const runMenu = (act) => {
    const index = menuIndex;
    const url = sites[index];
    closeMenu();
    if (!url) return;
    if (act === 'open') openSite(url, {});
    else if (act === 'tab') openSite(url, { background: true });
    else if (act === 'edit') startEdit(index);
    else if (act === 'remove') removeSite(index);
    markCurrent();
  };
  const buildMenu = () => {
    tileMenu.textContent = '';
    const item = (act, text) => {
      const row = doc.createElementNS(NS, 'button');
      row.type = 'button';
      row.dataset.act = act;
      row.textContent = text;
      row.setAttribute('role', 'menuitem');
      row.addEventListener('click', () => runMenu(act));
      tileMenu.append(row);
    };
    item('open', 'Open');
    item('tab', 'Open in New Tab');
    tileMenu.append(doc.createElementNS(NS, 'hr'));
    item('edit', 'Edit');
    item('remove', 'Remove');
  };
  const openMenu = (index, x, y) => {
    if (!sites[index]) return;
    menuIndex = index;
    buildMenu();
    tileMenu.hidden = false;
    const box = tileMenu.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - box.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - box.height - 8));
    tileMenu.style.left = Math.round(left) + 'px';
    tileMenu.style.top = Math.round(top) + 'px';
    const first = tileMenu.querySelector('button');
    if (first) first.focus();
  };
  if (!tileMenu.__brosrWired) {
    tileMenu.__brosrWired = true;
    doc.addEventListener(
      'pointerdown',
      (event) => {
        if (tileMenu.hidden) return;
        if (tileMenu.contains(event.target)) return;
        closeMenu();
      },
      true
    );
    doc.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Escape' || tileMenu.hidden) return;
        closeMenu();
      },
      true
    );
    window.addEventListener('blur', () => {
      if (!tileMenu.hidden) closeMenu();
    });
  }

  // The star sits in the urlbar, left of the site data icon. It reports whether
  // the page is in the row, and a click adds or removes it.
  let star = doc.getElementById('brosr-star');
  if (!star) {
    star = doc.createElementNS(NS, 'button');
    star.id = 'brosr-star';
    star.type = 'button';
    star.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6l2 4.1 4.5.6-3.3 3.1.8 4.5L8 11.8l-4 2.1.8-4.5L1.5 6.3 6 5.7z" stroke-linejoin="round"/></svg>';
    body.appendChild(star);
  }
  const placeStar = () => {
    const settings = doc.getElementById('zen-site-data-icon-button');
    const holder = settings && settings.parentElement;
    if (holder && star.parentElement !== holder) holder.insertBefore(star, settings);
  };
  const currentSpec = () => {
    const tab = window.gBrowser && window.gBrowser.selectedTab;
    return tab ? tabUrl(tab) : '';
  };
  const starIndex = () => {
    const spec = currentSpec();
    if (!/^https?:/i.test(spec)) return -1;
    const host = hostName(spec);
    return sites.findIndex((url) => hostName(url) === host);
  };
  const starState = () => {
    const spec = currentSpec();
    const live = /^https?:/i.test(spec);
    const index = live ? starIndex() : -1;
    return { live, index, on: index >= 0, spec };
  };
  const syncStar = () => {
    placeStar();
    const state = starState();
    if (state.live) star.removeAttribute('data-off');
    else star.setAttribute('data-off', '1');
    if (state.on) star.setAttribute('data-on', '1');
    else star.removeAttribute('data-on');
    const text = state.on ? 'Remove this page from bookmarks' : 'Bookmark this page';
    star.setAttribute('aria-label', text);
    star.title = text;
  };
  const toggleStar = () => {
    const state = starState();
    if (!state.live) return false;
    if (state.on) removeSite(state.index);
    else addSite(state.spec);
    syncStar();
    return true;
  };
  if (!star.__brosrWired) {
    star.__brosrWired = true;
    star.addEventListener('click', () => toggleStar());
  }

  const renderForm = () => {
    const form = doc.createElementNS('http://www.w3.org/1999/xhtml', 'form');
    form.className = 'brosr-site-form';
    const input = doc.createElementNS('http://www.w3.org/1999/xhtml', 'input');
    input.type = 'text';
    input.value = addText;
    input.placeholder = 'Paste a link';
    input.setAttribute('aria-label', 'Site address');
    if (addError) input.setAttribute('aria-invalid', 'true');
    input.addEventListener('input', () => {
      addText = input.value;
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      adding = false;
      editing = -1;
      addError = '';
      renderSites();
    });
    const submit = doc.createElementNS('http://www.w3.org/1999/xhtml', 'button');
    submit.type = 'submit';
    submit.textContent = editing >= 0 ? 'Save' : 'Add';
    const cancel = doc.createElementNS('http://www.w3.org/1999/xhtml', 'button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      adding = false;
      editing = -1;
      addError = '';
      renderSites();
    });
    form.append(input, submit, cancel);
    if (addError) {
      const error = doc.createElementNS('http://www.w3.org/1999/xhtml', 'p');
      error.className = 'brosr-site-error';
      error.textContent = addError;
      form.append(error);
    }
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      addText = input.value;
      addSite(addText);
    });
    sitesBar.append(form);
    input.focus();
  };

  // A tile whose site is open in the selected tab reads as current, so the bar
  // shows what the window already holds.
  const markCurrent = () => {
    const tab = window.gBrowser && window.gBrowser.selectedTab;
    const spec = tab ? tabUrl(tab) : '';
    const host = /^https?:/i.test(spec) ? hostName(spec) : '';
    for (const tile of sitesBar.querySelectorAll('.brosr-site[data-index]')) {
      if (host && hostName(tile.dataset.url || '') === host) tile.setAttribute('data-current', '1');
      else tile.removeAttribute('data-current');
    }
    syncStar();
  };

  const opening = () => {
    editing = -1;
    adding = true;
    addText = '';
    addError = '';
    renderSites();
  };

  const renderSites = () => {
    sitesBar.textContent = '';
    if (adding) {
      sitesBar.setAttribute('data-adding', '1');
      sitesBar.hidden = false;
      renderForm();
      return;
    }
    sitesBar.removeAttribute('data-adding');
    sites.forEach((url, index) => {
      const host = hostName(url);
      const tile = doc.createElementNS('http://www.w3.org/1999/xhtml', 'div');
      tile.className = 'brosr-site';
      tile.dataset.url = url;
      tile.dataset.index = String(index);
      tile.setAttribute('role', 'link');
      tile.setAttribute('tabindex', '0');
      tile.setAttribute('aria-label', titleOf(url));
      tile.title = url;
      const slot = doc.createElementNS('http://www.w3.org/1999/xhtml', 'span');
      slot.className = 'brosr-site-slot';
      const mark = doc.createElementNS('http://www.w3.org/1999/xhtml', 'span');
      mark.className = 'brosr-site-mark';
      mark.textContent = host.slice(0, 1).toUpperCase();
      const icon = doc.createElementNS('http://www.w3.org/1999/xhtml', 'img');
      icon.className = 'brosr-site-icon';
      icon.alt = '';
      // A page without a stored icon leaves the monogram behind it.
      icon.addEventListener('error', () => icon.remove());
      icon.src = 'page-icon:' + url;
      // The tab carries the host name, so the row reads without a tooltip.
      const label = doc.createElementNS('http://www.w3.org/1999/xhtml', 'span');
      label.className = 'brosr-site-label';
      label.textContent = titleOf(url);
      slot.append(mark, icon);
      tile.append(slot, label);
      const open = (background) => {
        openSite(url, { background });
        markCurrent();
      };
      tile.addEventListener('click', (event) => {
        // A drag ends as a drop, not as a visit.
        if (tile.dataset.moved === '1') return;
        open(event.metaKey || event.ctrlKey);
      });
      tile.addEventListener('auxclick', (event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        open(true);
      });
      tile.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        open(event.metaKey || event.ctrlKey);
      });
      tile.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        openMenu(index, event.clientX, event.clientY);
      });
      tile.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        if (event.target && event.target.closest && event.target.closest('button')) return;
        const start = { x: event.clientX, y: event.clientY };
        let live = false;
        try {
          tile.setPointerCapture(event.pointerId);
        } catch (error) {
          // The drag still tracks the pointer without capture.
        }
        const move = (ev) => {
          if (!live && Math.abs(ev.clientX - start.x) < 4 && Math.abs(ev.clientY - start.y) < 4) {
            return;
          }
          live = true;
          tile.setAttribute('data-drag', '1');
          const hit = doc.elementFromPoint(ev.clientX, ev.clientY);
          const over = hit && hit.closest ? hit.closest('.brosr-site[data-index]') : null;
          for (const node of sitesBar.querySelectorAll('.brosr-site')) {
            node.removeAttribute('data-over');
          }
          if (over && over !== tile) over.setAttribute('data-over', '1');
        };
        const finish = (ev) => {
          tile.removeEventListener('pointermove', move);
          tile.removeEventListener('pointerup', finish);
          tile.removeEventListener('pointercancel', finish);
          tile.removeAttribute('data-drag');
          for (const node of sitesBar.querySelectorAll('.brosr-site')) {
            node.removeAttribute('data-over');
          }
          if (!live) return;
          tile.dataset.moved = '1';
          dropSite(index, ev.clientX, ev.clientY);
        };
        tile.addEventListener('pointermove', move);
        tile.addEventListener('pointerup', finish);
        tile.addEventListener('pointercancel', finish);
      });
      sitesBar.appendChild(tile);
    });
    sitesBar.hidden = false;
    markCurrent();
    fillTitles();
  };
  renderSites();

  // The chord reaches the form from anywhere in the window, so the bar has a
  // keyboard path that needs no pointer. The handler reads the live closure, so
  // a second injection never leaves a stale one behind.
  window.__brosrOpenForm = opening;
  window.__brosrMarkCurrent = markCurrent;
  if (!window.__brosrSiteKey) {
    window.__brosrSiteKey = true;
    window.addEventListener(
      'keydown',
      (event) => {
        if (!event.ctrlKey || !event.altKey) return;
        if (event.key !== 'a' && event.key !== 'A' && event.code !== 'KeyA') return;
        event.preventDefault();
        if (window.__brosrOpenForm) window.__brosrOpenForm();
      },
      true
    );
    const container = window.gBrowser && window.gBrowser.tabContainer;
    if (container) {
      const refresh = () => {
        if (window.__brosrMarkCurrent) window.__brosrMarkCurrent();
      };
      container.addEventListener('TabSelect', refresh);
      container.addEventListener('TabOpen', refresh);
      container.addEventListener('TabClose', refresh);
    }
  }

  // The probe drives the same drop path a pointer does, and can restore the
  // shipped pair after a delete.
  window.__brosrSites = {
    list: () => sites.slice(),
    reset: () => {
      sites = SITE_DEFAULTS.slice();
      saveSites();
      adding = false;
      addError = '';
      renderSites();
      return sites.slice();
    },
    empty: () => {
      sites = [];
      saveSites();
      renderSites();
      return sites.slice();
    },
    add: (url) => addSite(url),
    remove: (index) => removeSite(index),
    drop: (index, x, y) => dropSite(index, x, y),
    open: (index, background = false) => {
      const url = sites[index];
      if (!url) return null;
      const tabsBefore = tabList().length;
      const reused = Boolean(findTab(url)) && !background;
      const ok = openSite(url, { background });
      markCurrent();
      const active = window.gBrowser && window.gBrowser.selectedTab;
      return {
        ok,
        reused,
        tabsBefore,
        tabsAfter: tabList().length,
        active: active ? tabUrl(active) : '',
      };
    },
  };
  window.__brosrStar = { toggle: () => toggleStar(), state: () => starState() };
  window.__brosrMenu = { open: (index) => openMenu(index, 60, 220), close: closeMenu };

  // Zen creates this folder in its welcome flow. Hiding the folder hides its
  // label and the tabs it holds, and the file keeps no other name.
  let basicsHidden = 0;
  const hideBasics = () => {
    const tabs = doc.getElementById('tabbrowser-tabs');
    if (!tabs) return;
    const nodes = tabs.querySelectorAll(
      'zen-folder, .tab-group-label, .tab-group-label-container'
    );
    for (const node of nodes) {
      const label = String(
        node.getAttribute('label') || node.getAttribute('aria-label') || node.textContent || ''
      )
        .trim()
        .toLowerCase();
      if (label !== 'zen basics') continue;
      const folder = node.closest('zen-folder') || node;
      if (folder.getAttribute('data-brosr-hidden') === '1') continue;
      folder.style.setProperty('display', 'none', 'important');
      folder.setAttribute('data-brosr-hidden', '1');
      basicsHidden += 1;
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

  // A sidebar is a chrome wrapper page that embeds the extension page in a
  // browser of its own. The wrapper title stays empty, so the panel title is
  // one level in. A build without that wrapper keeps the direct title.
  const panelTitle = () => {
    const panel = doc.getElementById('sidebar');
    if (!panel) return '';
    try {
      const inner = panel.contentDocument && panel.contentDocument.querySelector('browser');
      if (inner && inner.contentTitle) return String(inner.contentTitle);
    } catch (error) {
      // A remote wrapper hides its document, so the sidebar title is next.
    }
    try {
      return String(panel.contentTitle || '');
    } catch (error) {
      return '';
    }
  };

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

  // A drag owns the height while it runs. The timer would otherwise write the
  // stored pref back over the pointer four times a second.
  let dragging = false;
  let lastLabel = '';

  // The page starts where the column ends. A customize run or a collapsed
  // column leaves no room, and the card then parks instead of covering the page.
  const pageEdge = () => {
    // The customize page covers the tab box and starts at the window edge. It
    // comes first, because the tab box keeps its old geometry underneath it.
    for (const id of ['customization-container', 'appcontent', 'tabbrowser-tabbox']) {
      const page = doc.getElementById(id);
      const measure = page && page.getBoundingClientRect();
      if (measure && measure.width > 0) return measure.left;
    }
    return window.innerWidth;
  };

  const apply = () => {
    const colBox = column.getBoundingClientRect();
    // The bar row sits above the column and measures 42 pixels on this build.
    // Both values come from the live layout, so a theme or zoom change keeps
    // the bar and the column seam together.
    const barRow = doc.getElementById('zen-appcontent-navbar-wrapper');
    const navBar = doc.getElementById('nav-bar');
    const navBox = navBar && navBar.getBoundingClientRect();
    const barBox = barRow && barRow.getBoundingClientRect();
    // The row height comes from the bar itself, because the wrapper holds that
    // height open with the variable that this pass writes.
    const barHeight =
      navBox && navBox.height > 0
        ? Math.round(navBox.height)
        : barBox && barBox.height > 0
          ? Math.round(barBox.height)
          : 42;
    root.style.setProperty('--brosr-bar-height', barHeight + 'px');
    // The column starts under the bar. Whatever Zen keeps at the top of the
    // column, such as the compact mode buttons, keeps its room too, so the
    // heading never sits under a control. A compact window lays those buttons
    // under the bookmark row instead, so the bar alone bounds the heading
    // there. The natural spot is measured, then snapped to the edge.
    const compactMode = root.getAttribute('zen-compact-mode') === 'true';
    sitesLabel.style.marginTop = '0px';
    const headButtons = doc.getElementById('zen-sidebar-top-buttons');
    const headBox = headButtons ? headButtons.getBoundingClientRect() : null;
    const headFloor = compactMode
      ? barHeight
      : Math.max(barHeight, headBox && headBox.height > 0 ? Math.round(headBox.bottom) : 0);
    const headNatural = Math.round(sitesLabel.getBoundingClientRect().top);
    if (headNatural < headFloor) {
      sitesLabel.style.marginTop = headFloor - headNatural + 'px';
    }
    const urlRow = doc.getElementById('nav-bar');
    const urlBox = urlRow && urlRow.getBoundingClientRect();
    const urlField = doc.getElementById('urlbar');
    const fieldBox = urlField && urlField.getBoundingClientRect();
    const colStyle = window.getComputedStyle(column);
    const onScreen =
      colBox.width >= 160 && colStyle.display !== 'none' && colStyle.visibility !== 'hidden';
    const edge = pageEdge();
    // A compact window slides the column over the page, so the page edge sits
    // behind it. The column edge alone bounds the card then.
    const limit = compactMode ? Math.round(colBox.right) : Math.min(colBox.right, edge);
    const left = Math.round(colBox.left) + INSET;
    const roomFor = onScreen ? limit - left - INSET : 0;
    const parked = roomFor < 160;
    const open = !parked && !box.hidden && box.getBoundingClientRect().width > 0;
    const width = parked ? 0 : Math.max(160, Math.round(roomFor));
    const height = readHeight();
    const room = roomId();
    root.style.setProperty('--brosr-panel-left', left + 'px');
    root.style.setProperty('--brosr-panel-inset', INSET + 'px');
    root.style.setProperty('--brosr-panel-radius', '8px');
    root.style.setProperty('--brosr-panel-width', width + 'px');
    if (!dragging) {
      root.style.setProperty('--brosr-panel-height', height + 'px');
      root.style.setProperty('--brosr-panel-space', open ? height + INSET * 2 + 'px' : '0px');
    }
    // Without a column there is no place for the card. Hidden keeps the panel
    // out of the page, and the next pass restores it with the column.
    if (parked) box.style.visibility = 'hidden';
    else if (box.style.visibility === 'hidden') box.style.removeProperty('visibility');
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
    bar.style.left = left + 'px';
    bar.style.width = width + 'px';
    if (!dragging) bar.style.bottom = height + INSET + 'px';
    // The panel writes its peer count into its own title, and the sidebar
    // browser republishes that title, so the closed chip can carry the count.
    // The panel writes its peer count into its own title, and the sidebar
    // republishes that title. Closing the panel unloads the page, so the chip
    // keeps the last count it read and stays useful while the panel is shut.
    const title = panelTitle();
    if (title.startsWith('Brosr room')) lastLabel = title;
    const label = lastLabel || 'Brosr room';
    if (toggle.textContent !== label) toggle.textContent = label;
    // The chip is the way back in. It hides only when the column is gone, so a
    // closed panel always leaves one visible button inside the column.
    toggle.hidden = parked || open;
    toggle.style.left = left + 'px';
    // The add card keeps the row alive after the last page goes, so the bar
    // never strands a person with no way to add a site back.
    sitesBar.hidden = false;
    root.setAttribute('data-brosr-sites', '1');
    // The compact mode toggle belongs to the top bar. The command also names a
    // keyboard binding, so only the button moves. Its XUL flex attribute would
    // let it take half the bar, so that goes too.
    const compact = doc.querySelector('toolbarbutton[command="cmd_toggleCompactModeIgnoreHover"]');
    const navRow = doc.getElementById('nav-bar');
    if (compact) {
      compact.removeAttribute('flex');
      if (navRow && compact.parentElement !== navRow) navRow.appendChild(compact);
    }
    // The stylesheet pins the window controls by platform. This names the one
    // in use, so a mac window gets the lights on the left.
    const os = String(Services.appinfo.OS || '');
    root.setAttribute(
      'data-brosr-os',
      os === 'Darwin' ? 'mac' : os.startsWith('WIN') ? 'win' : 'linux'
    );
    hideBasics();
    syncStar();
    if (open) syncPanelSites();
    const spacesNode =
      doc.getElementById('zen-current-workspace-indicator-container') ||
      doc.querySelector('.zen-current-workspace-indicator');
    // macOS vibrancy and Windows Mica draw a material behind the window, so a
    // surface at 90 percent shows a soft hint of the desktop. A window without
    // a material keeps its solid paint.
    const clear =
      prefBool('zen.widget.macos.window-vibrancy', false) ||
      prefBool('zen.widget.windows.mica', false) ||
      prefBool('zen.widget.linux.transparency', false);
    if (clear) root.setAttribute('data-brosr-clear', '1');
    else root.removeAttribute('data-brosr-clear');
    const rect = box.getBoundingClientRect();
    const style = window.getComputedStyle(box);
    const sitesRect = sitesBar.getBoundingClientRect();
    const firstTile = sitesBar.querySelector('.brosr-site');
    const tileRect = firstTile ? firstTile.getBoundingClientRect() : null;
    return {
      docked: box.classList.contains('brosr-docked'),
      open,
      width,
      column: Math.round(colBox.width),
      columnLeft: Math.round(colBox.left),
      pageEdge: Math.round(edge),
      parked,
      panelVisible: style.visibility !== 'hidden',
      height: Math.round(rect.height),
      toolbar: prefBool('zen.view.use-single-toolbar', true),
      splitter: (() => {
        const el = doc.getElementById('zen-sidebar-splitter');
        return el ? window.getComputedStyle(el).display : 'missing';
      })(),
      inset: INSET,
      radius: style.borderTopLeftRadius,
      surface: style.backgroundColor,
      room,
      sidebar: sidebarId(),
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      panelWidth: Math.round(rect.width),
      panelHeight: Math.round(rect.height),
      bar: !bar.hidden,
      toggle: !toggle.hidden,
      toggleText: toggle.textContent,
      windowWidth: window.innerWidth,
      barLeft: urlBox ? Math.round(urlBox.left) : 0,
      barWidth: urlBox ? Math.round(urlBox.width) : 0,
      barTop: urlBox ? Math.round(urlBox.top) : 0,
      barHeight: urlBox ? Math.round(urlBox.height) : 0,
      // The bar is its own strip across the window, so it reports its own box
      // and the room it keeps for the window controls.
      barRow: (() => {
        const row = doc.getElementById('zen-appcontent-navbar-container');
        if (!row) return { left: 0, right: 0, top: 0, bottom: 0, width: 0 };
        const r = row.getBoundingClientRect();
        return {
          left: Math.round(r.left),
          right: Math.round(r.right),
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          width: Math.round(r.width),
        };
      })(),
      controlsBox: (() => {
        const row = doc.querySelector('.titlebar-buttonbox-container');
        const back = doc.getElementById('back-button');
        const rowBox = row ? row.getBoundingClientRect() : null;
        const backBox = back ? back.getBoundingClientRect() : null;
        return {
          count: doc.querySelectorAll('.titlebar-button').length,
          left: rowBox ? Math.round(rowBox.left) : 0,
          right: rowBox ? Math.round(rowBox.right) : 0,
          backLeft: backBox ? Math.round(backBox.left) : 0,
        };
      })(),
      // The window controls belong to the frame. Their order and their look come
      // from the platform, so this only reports where the box landed.
      controls: (() => {
        const cb = doc.querySelector('.titlebar-buttonbox-container');
        if (!cb) return { count: 0, display: 'missing', left: 0, top: 0, parent: '' };
        const cbBox = cb.getBoundingClientRect();
        return {
          count: doc.querySelectorAll('.titlebar-button').length,
          display: window.getComputedStyle(cb).display,
          left: Math.round(cbBox.left),
          top: Math.round(cbBox.top),
          parent: cb.parentElement ? cb.parentElement.id || cb.parentElement.tagName : '',
        };
      })(),
      platform: Services.appinfo.OS,
      columnMin: parseInt(colStyle.minWidth, 10) || 0,
      columnTop: Math.round(colBox.top),
      tabsTop: Math.round(
        (doc.getElementById('titlebar') || column).getBoundingClientRect().top
      ),
      barClip: window.getComputedStyle(column).clipPath,
      urlWidth: urlBox ? Math.round(urlBox.width) : 0,
      urlRight: urlBox ? Math.round(urlBox.right) : 0,
      fieldLeft: fieldBox ? Math.round(fieldBox.left) : 0,
      fieldWidth: fieldBox ? Math.round(fieldBox.width) : 0,
      fieldRight: fieldBox ? Math.round(fieldBox.right) : 0,
      footHeight: (() => {
        const foot = doc.getElementById('zen-sidebar-foot-buttons');
        return foot ? Math.round(foot.getBoundingClientRect().height) : 0;
      })(),
      footBottom: (() => {
        const foot = doc.getElementById('zen-sidebar-foot-buttons');
        return foot ? Math.round(foot.getBoundingClientRect().bottom) : 0;
      })(),
      footDots: (() => {
        const strip = doc.getElementById('zen-workspaces-button');
        if (!strip) return 0;
        return strip.querySelectorAll('toolbarbutton').length;
      })(),
      compact: (() => {
        const el = doc.querySelector('toolbarbutton[command="cmd_toggleCompactModeIgnoreHover"]');
        if (!el) {
          return { found: false, inBar: false, left: 0, top: 0, width: 0, height: 0 };
        }
        const r = el.getBoundingClientRect();
        return {
          found: true,
          inBar: Boolean(el.closest('#nav-bar')),
          left: Math.round(r.left),
          top: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height),
          display: window.getComputedStyle(el).display,
        };
      })(),
      bookmarks: (() => {
        const el = doc.getElementById('brosr-sites-label');
        if (!el) return { text: '', top: 0, width: 0 };
        const r = el.getBoundingClientRect();
        return { text: el.textContent, top: Math.round(r.top), width: Math.round(r.width) };
      })(),
      // The star reports its own spot, the page it describes and the left edge
      // of the settings icon beside it.
      star: (() => {
        const el = star;
        const settings = doc.getElementById('zen-site-data-icon-button');
        const settingsBox = settings ? settings.getBoundingClientRect() : null;
        const r = el.getBoundingClientRect();
        return {
          found: Boolean(el),
          inBar: Boolean(el.closest('#urlbar')),
          on: el.getAttribute('data-on') === '1',
          live: el.getAttribute('data-off') !== '1',
          left: Math.round(r.left),
          right: Math.round(r.right),
          width: Math.round(r.width),
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          settingsLeft: settingsBox ? Math.round(settingsBox.left) : 0,
        };
      })(),
      menu: (() => {
        return {
          found: Boolean(tileMenu),
          open: !tileMenu.hidden,
          items: Array.from(tileMenu.querySelectorAll('button')).map((row) => row.textContent),
        };
      })(),
      sites: sites.length,
      siteLabels: sites.map(hostName),
      sitesTop: Math.round(sitesRect.top),
      sitesHeight: Math.round(sitesRect.height),
      siteWidth: tileRect ? Math.round(tileRect.width) : 0,
      siteHeight: tileRect ? Math.round(tileRect.height) : 0,
      sitesRight: Math.round(sitesRect.right),
      addRight: (() => {
        const add = sitesBar.querySelector('.brosr-site-add');
        return add ? Math.round(add.getBoundingClientRect().right) : 0;
      })(),
      addWidth: (() => {
        const add = sitesBar.querySelector('.brosr-site-add');
        return add ? Math.round(add.getBoundingClientRect().width) : 0;
      })(),
      addTile: Boolean(sitesBar.querySelector('.brosr-site-add')),
      siteForm: sitesBar.getAttribute('data-adding') === '1',
      formFocus: Boolean(
        doc.activeElement &&
          doc.activeElement.closest &&
          doc.activeElement.closest('.brosr-site-form')
      ),
      currentTiles: sitesBar.querySelectorAll('.brosr-site[data-current="1"]').length,
      spaces: spacesNode ? window.getComputedStyle(spacesNode).display : 'missing',
      basics: basicsHidden,
      reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      motion: style.animationName,
      motionMs: Math.round(parseFloat(style.animationDuration || '0') * 1000),
      clear,
      alpha: clear
        ? Number(window.getComputedStyle(root).getPropertyValue('--brosr-surface-alpha')) || 1
        : 1,
      layer: doc.querySelectorAll('.zen-browser-generic-background').length,
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
      dragging = true;
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
      root.style.setProperty('--brosr-panel-space', height + INSET * 2 + 'px');
      bar.style.bottom = height + INSET + 'px';
    };
    const end = () => {
      if (!drag) return;
      drag = null;
      dragging = false;
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
      apply();
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

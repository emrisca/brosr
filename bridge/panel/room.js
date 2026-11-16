// The panel asks a room tab for status. The panel is its own page, so the
// active tab is the panel itself and the code falls back to a room tab on the
// relay origin.
const $ = (id) => document.getElementById(id);
// One namespace for both engines.
const api = globalThis.browser || globalThis.chrome || null;
// The landing page is the room front door, and its room params mark it. A
// fixture page is still a room page by its name.
const ROOM_FIXTURE = /^https?:\/\/[^/]+\/(room|media|board|form|ad|sync|layout)[^/]*\.html/;
function isRoomPage(href) {
  if (typeof href !== 'string' || !href) return false;
  if (ROOM_FIXTURE.test(href)) return true;
  try {
    const url = new URL(href);
    return url.searchParams.has('room') && url.searchParams.has('peer');
  } catch {
    return false;
  }
}
// One guest id per panel, so two people copying the link do not collide.
const GUEST = 'guest-' + Math.random().toString(36).slice(2, 6);

// The toolbar opens this page as an anchored popup, which takes its size from
// the document. A page opened in a tab names itself so the stylesheet can fill
// it, and anything else reads as the popup.
const asked = new URLSearchParams(location.search).get('surface') || '';
const SURFACE = asked === 'tab' ? 'tab' : 'popup';
document.documentElement.dataset.surface = SURFACE;

// The panel is a content page, so prefers-color-scheme reports the system and
// not the browser theme. The theme API is the true source. A contrast pass then
// keeps text readable when a palette pairs a light surface with pale text.
const DARK_TEXT = '#16161a';
const LIGHT_TEXT = '#fbfbfe';

// Gecko reports a mixed colour as `color(srgb r g b)` with unit channels, so a
// plain rgba match would miss every token the stylesheet builds. Both forms
// resolve here, and a named system colour resolves through getComputedStyle.
function channels(value) {
  const text = String(value).trim();
  const rgb = text.match(/^rgba?\(([^)]+)\)$/);
  if (rgb) {
    const parts = rgb[1]
      .split(/[,/ ]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) return parts.slice(0, 3);
  }
  const hex = text.replace('#', '');
  if (/^[0-9a-f]{6}$/i.test(hex)) return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  if (/^[0-9a-f]{3}$/i.test(hex)) return [0, 1, 2].map((i) => parseInt(hex[i] + hex[i], 16));
  const wide = text.match(/^color\(\s*[a-z0-9-]+\s+([^)]+)\)$/i);
  if (wide) {
    const parts = wide[1]
      .split(/[\s/]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
      return parts.slice(0, 3).map((part) => Math.round(Math.min(1, Math.max(0, part)) * 255));
    }
  }
  return null;
}

const asRgb = (rgb) => `rgb(${rgb.map((value) => Math.round(value)).join(', ')})`;

// The theme API can stay silent about a Zen space palette, so the panel also
// reads the system surface. That path never returns a half colour pair.
function systemSurface() {
  const probe = document.createElement('span');
  probe.style.cssText =
    'position:fixed;left:-9999px;top:-9999px;background:Canvas;color:CanvasText';
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const pair = { base: channels(style.backgroundColor), text: channels(style.color) };
  probe.remove();
  return pair;
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The base, the text and the mixed surface are written as plain rgb triples.
// A `color-mix` token would compute to `color(srgb ...)`, which the guard could
// not read, so the guard would pass a pale pair through unchecked.
async function applyTheme() {
  const root = document.documentElement;
  let colours = null;
  try {
    const theme = await api.theme.getCurrent();
    colours = theme && theme.colors ? theme.colors : null;
  } catch {
    colours = null;
  }
  const system = systemSurface();
  const base = channels(colours && (colours.toolbar || colours.popup || colours.frame)) || system.base;
  let text = channels(colours && (colours.toolbar_text || colours.popup_text)) || system.text;
  if (!base || !text) return;
  // A palette can hand back a light surface and pale text. Keep the pair above
  // 4.5 to 1, and pick the near end that the surface can carry.
  if (contrast(base, text) < 4.5) {
    text = channels(luminance(base) > 0.45 ? DARK_TEXT : LIGHT_TEXT);
  }
  const accent = channels(colours && (colours.tab_line || colours.frame_text));
  const keepAccent = accent && contrast(base, accent) >= 3;
  const surface = base.map((value, index) => value * 0.94 + text[index] * 0.06);
  const set = (name, value) => {
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  };
  set('--room-base', asRgb(base));
  set('--room-text', asRgb(text));
  set('--room-bg', asRgb(surface));
  set('--room-accent', keepAccent ? asRgb(accent) : '');
}

if (api && api.theme) {
  applyTheme();
  try {
    api.theme.onUpdated.addListener(() => applyTheme());
  } catch {
    // An older build without the event keeps the first pass.
  }
  const scheme = matchMedia('(prefers-color-scheme: dark)');
  scheme.addEventListener('change', () => applyTheme());
}
// The room tab carries the room and the transport in its URL. A join link
// keeps the page and the room, drops the host identity and adds a guest one.
function inviteLink(href) {
  if (!href) return '';
  try {
    const url = new URL(href);
    for (const key of ['role', 'peer', 'name', 'panel', 'selftest', 'bias', 'grant', 'capture']) {
      url.searchParams.delete(key);
    }
    url.searchParams.set('role', 'peer');
    url.searchParams.set('peer', GUEST);
    url.searchParams.set('name', 'Guest');
    return url.toString();
  } catch {
    return '';
  }
}

function setStatus(message, state) {
  const node = $('status');
  node.textContent = message;
  if (state) node.dataset.state = state;
  else delete node.dataset.state;
}

function notice(message, bad) {
  const node = $('notice');
  node.textContent = message;
  if (bad) node.dataset.bad = '1';
  else delete node.dataset.bad;
}

function latencyLabel(data) {
  const stats = data.latency || data.rtt || null;
  if (stats && Number.isFinite(stats.p95)) return `${Math.round(stats.p95)} ms p95`;
  if (Number.isFinite(data.latencyMs)) return `${Math.round(data.latencyMs)} ms`;
  return '-';
}

let lastReply = null;

function renderHistory(data) {
  const list = $('history');
  list.replaceChildren();
  const history = Array.isArray(data.controlHistory)
    ? data.controlHistory.slice(-3).reverse()
    : [];
  if (!history.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No control changes yet.';
    list.append(empty);
    return;
  }
  for (const entry of history) {
    const row = document.createElement('li');
    row.textContent = `${entry.peerId} ${entry.allowed ? 'granted' : 'revoked'}`;
    list.append(row);
  }
}

// A tile dropped on the panel arrives as a URL parameter, because this page
// cannot read the pref that the dock writes.
const PANEL_SITES = (() => {
  try {
    const raw = new URL(location.href).searchParams.get('panelSites');
    const list = JSON.parse(raw || '[]');
    if (!Array.isArray(list)) return [];
    return list.filter((url) => typeof url === 'string' && /^https?:\/\//.test(url));
  } catch (error) {
    return [];
  }
})();

function renderPanelSites() {
  const box = $('panel-sites');
  const list = $('panel-sites-list');
  if (!box || !list) return;
  box.hidden = PANEL_SITES.length === 0;
  list.replaceChildren();
  for (const url of PANEL_SITES) {
    const row = document.createElement('li');
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch (error) {
      host = url;
    }
    link.textContent = host;
    row.append(link);
    list.append(row);
  }
}

// A sealed room says so in the header. A failed key is the one state a person
// must notice, because the room refuses to connect rather than fall back.
function renderSeal(seal) {
  const node = $('seal');
  if (!node) return;
  const mode = seal && seal.mode ? seal.mode : 'off';
  node.hidden = mode === 'off';
  node.dataset.state = mode;
  node.textContent = mode === 'on' ? 'Sealed' : mode === 'failed' ? 'Key failed' : 'Sealing';
  node.title =
    mode === 'on'
      ? 'Every frame is sealed for this room.'
      : mode === 'failed'
        ? String((seal && seal.error) || 'The room key did not derive.')
        : 'The room key is loading.';
}

// The tab list is read from the background page, which knows the role and the
// tab ids. The panel writes the same state back, so one render pass draws both.
let tabState = null;

// A film key names a page. The card shows a short label and keeps the full key
// in a title, so a long URL never pushes the button off the row.
function filmLabel(key) {
  const text = String(key || '');
  if (text.startsWith('youtube:')) return 'YouTube film';
  try {
    return new URL(text).hostname.replace(/^www\./, '') || 'The film';
  } catch {
    return 'The film';
  }
}

// A position reads better as a clock than as a raw second count.
function clockText(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '-';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

// One badge per peer says what that peer's own tab is doing with the film.
function viewerLabel(viewer) {
  if (!viewer) return 'No report';
  if (!viewer.open) return 'No tab on the film';
  if (viewer.ad) return 'Ad';
  if (viewer.buffering) return 'Buffering';
  if (!viewer.playing) return 'Paused';
  const gap = Number(viewer.behind);
  if (!Number.isFinite(gap)) return 'Watching';
  return Math.abs(gap) <= 1 ? 'In sync' : `${Math.abs(gap).toFixed(1)} s off`;
}

// The watch card states what the room plays, where this browser's own tab has
// it, and what each peer reports. The button opens the film, or brings an open
// film tab to the front, so joining takes one click.
function renderWatch(reply) {
  const data = (reply && reply.data) || {};
  const media = data.media || null;
  const state = $('watch-state');
  const copy = $('watch-copy');
  const button = $('watch-toggle');
  const list = $('watch-viewers');
  if (!list) return;
  list.replaceChildren();
  delete copy.title;
  const action = $('watch-action');
  if (action) {
    action.hidden = true;
    action.textContent = '';
  }
  if (!media) {
    state.textContent = 'No media';
    delete state.dataset.state;
    copy.textContent =
      reply && reply.role === 'host'
        ? 'Play something in a tab and the room follows it.'
        : 'The host has not started a film.';
    button.textContent = 'Open the film';
    button.disabled = true;
    button.title = 'No film in this room yet';
    return;
  }
  const flag = media.ad ? 'Ad' : media.buffering ? 'Buffering' : '';
  const label = media.playing ? 'Playing' : 'Paused';
  state.textContent = flag ? `${label}, ${flag.toLowerCase()}` : label;
  state.dataset.state = media.playing ? 'playing' : 'paused';
  const place = clockText(Number(media.position));
  const here =
    media.open && Number.isFinite(media.localPosition)
      ? ` Your tab is at ${clockText(Number(media.localPosition))}.`
      : '';
  copy.textContent = media.open
    ? `${filmLabel(media.key)} at ${place}.${here}`
    : `${filmLabel(media.key)} at ${place}. No tab on it here.`;
  copy.title = String(media.key || '');
  button.textContent = media.open ? 'Show the film' : 'Open the film';
  button.disabled = !media.url;
  button.title = media.open
    ? 'Bring the film tab to the front'
    : 'Open the film in a new tab';

  const last = data.lastMediaAction;
  if (action && last && last.text) {
    action.textContent = last.text;
    action.hidden = false;
  }

  const peers = Array.isArray(data.peerList) ? data.peerList : [];
  const reports = Array.isArray(data.viewers) ? data.viewers : [];
  const byId = new Map(reports.map((entry) => [String(entry && entry.id), entry]));
  for (const peer of peers) {
    if (!peer || !peer.id || peer.self) continue;
    const entry = byId.get(String(peer.id));
    if (!entry) continue;
    const row = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'watch-name';
    name.textContent = peer.name || peer.id;
    const badge = document.createElement('span');
    badge.className = 'watch-badge';
    badge.textContent = viewerLabel(entry.viewer);
    if (entry.viewer && entry.viewer.inSync === true) badge.dataset.sync = '1';
    if (entry.viewer && entry.viewer.inSync === false) badge.dataset.sync = '0';
    row.append(name, badge);
    list.append(row);
  }
}

// The Control section names the tab a grant types into. A room with no trusted
// channel has no switch to move, so the row states why it stays off.
function renderTrust(data) {
  const box = $('trust-target');
  const note = $('trust-note');
  if (!box) return;
  const hasTrust = Boolean(data && data.trust);
  const url = data && typeof data.trustTarget === 'string' ? data.trustTarget : '';
  box.disabled = !hasTrust;
  box.checked = hasTrust && Boolean(url);
  if (note) {
    note.textContent = !hasTrust
      ? 'This room has no trusted channel.'
      : url
        ? `Typing goes to ${pageLabel(url)}.`
        : 'Typing goes to this room tab.';
  }
}

function render(reply) {
  lastReply = reply;
  const data = reply.data || {};
  $('room').textContent = reply.room || 'room';
  $('role').textContent = reply.role || '';
  // The background page learns the role from the room tab hello. When the tab
  // list lands first, this fills the gap on the next status pass.
  if (tabState && !tabState.role && reply.role) {
    tabState.role = reply.role;
    renderTabs();
  }
  $('dot').dataset.state = data.socket === 1 ? 'live' : 'down';
  setStatus(data.socket === 1 ? 'Connected' : 'Reconnecting...');
  $('control').hidden = reply.role !== 'host';
  renderSeal(data.seal);
  renderTrust(data);
  const invite = inviteLink(data.inviteUrl || data.location);
  $('invite-box').hidden = !invite;
  if (invite && $('invite').value !== invite) $('invite').value = invite;

  const peers = Array.isArray(data.peerList)
    ? data.peerList
    : Array.isArray(data.peers)
      ? data.peers
      : [];
  const count = Number.isFinite(data.peers) ? data.peers : peers.length;
  // A connected room always states its size, including zero. A blank cell
  // would look like a panel that has not answered yet.
  const connected = data.socket === 1;
  $('count').textContent = connected ? String(count) : '';
  // The title is the one channel the chrome layer can read from this page, so
  // it carries the count to the closed chip.
  document.title = connected ? `Brosr room \u00b7 ${count}` : 'Brosr room';
  const list = $('peers');
  list.replaceChildren();
  if (!peers.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    const line = document.createElement('span');
    const label = count === 1 ? 'peer' : 'peers';
    line.textContent = count ? `${count} ${label} in this room.` : 'No peers in this room yet.';
    const again = document.createElement('button');
    again.type = 'button';
    again.textContent = 'Refresh';
    again.addEventListener('click', () => refresh());
    empty.append(line, again);
    list.append(empty);
  }
  for (const peer of peers) {
    const row = document.createElement('li');
    row.dataset.peer = peer.id || '';
    if (peer.granted) row.dataset.granted = '1';
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    if (peer.colour) swatch.style.background = peer.colour;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = peer.name || peer.id || 'peer';
    name.title = name.textContent;
    if (peer.self) name.textContent += ' (you)';
    row.append(swatch, name);
    const presence = data.presenceByPeer ? data.presenceByPeer[peer.id] : null;
    if (presence && Number.isFinite(presence.p95)) {
      const time = document.createElement('span');
      time.className = 'latency';
      time.title = 'Presence latency, 95th percentile.';
      time.textContent = `${Math.round(presence.p95)} ms`;
      row.append(time);
    }
    if (peer.granted) {
      const badge = document.createElement('span');
      badge.className = 'grant';
      badge.textContent = 'Control';
      row.append(badge);
    }
    if (reply.role === 'host' && peer.id && !peer.self) {
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'peer-control';
      action.dataset.peer = peer.id;
      action.textContent = peer.granted ? 'Revoke' : 'Grant';
      action.setAttribute(
        'aria-label',
        peer.granted
          ? `Revoke control from ${peer.name || peer.id}`
          : `Grant control to ${peer.name || peer.id}`
      );
      action.addEventListener('click', () => control(!peer.granted, peer.id));
      row.append(action);
    }
    list.append(row);
  }

  // The watch card states what the room plays and where this browser's own tab
  // has it. The button opens or fronts the film, so joining takes one click.
  renderWatch(reply);
  $('latency').textContent = latencyLabel(data);
  const reconnects = Number(data.reconnects) || 0;
  $('relay').textContent =
    data.socket === 1 ? (reconnects ? `Live, ${reconnects} reconnects` : 'Live') : 'Reconnecting';
  $('playback').textContent =
    typeof data.playing === 'boolean' ? (data.playing ? 'Playing' : 'Paused') : '-';
  renderHistory(data);
}

function missing(reason) {
  lastReply = null;
  $('dot').dataset.state = 'down';
  setStatus(reason || 'This tab is not in a room.', 'error');
  $('peers').replaceChildren();
  $('control').hidden = true;
  $('latency').textContent = '-';
  $('count').textContent = '';
  document.title = 'Brosr room';
  $('invite-box').hidden = true;
  $('invite').value = '';
  renderSeal(null);
  renderTrust(null);
  $('playback').textContent = '-';
  $('relay').textContent = '-';
  renderWatch(null);
}

// A sidebar sender can report the placeholder id -1. Sending to it throws, so
// the panel treats it as no id and keeps looking for a real tab.
const usable = (tab) => Boolean(tab) && Number.isInteger(tab.id) && tab.id >= 0;

async function targetTab() {
  try {
    const info = await api.runtime.sendMessage({ type: 'brosr:room-tab' });
    if (info && info.debug) tabHint = info.debug;
    if (info && Number.isInteger(info.tabId) && info.tabId >= 0) {
      return { id: info.tabId, url: '' };
    }
  } catch {
    // Fall through to the tab list.
  }
  const [active] = await api.tabs.query({ active: true, currentWindow: true });
  if (usable(active) && isRoomPage(active.url || '')) return active;
  const tabs = (await api.tabs.query({ currentWindow: true })).filter(usable);
  const here = tabs.find((tab) => isRoomPage(tab.url || ''));
  if (here) return here;
  // A sidebar belongs to no window in some builds, so both scans above come
  // back empty and the panel would sit blank beside a live room. Every window is
  // the last pass, and a room elsewhere beats no room at all.
  const all = (await api.tabs.query({})).filter(usable);
  return all.find((tab) => isRoomPage(tab.url || '')) || null;
}

// A sidebar can be refused the tab message channel while the page itself
// answers it. The background page holds the room tab id for exactly that case,
// so a refused direct call falls through to the relay and the panel still
// shows the room. The report keeps the route and the reason, so a headless run
// can tell a dead room from a refused channel.
let askRoute = null;
let askError = null;
let tabHint = null;

async function askStatus(tab) {
  try {
    const reply = await api.tabs.sendMessage(tab.id, { type: 'brosr:status' });
    if (reply && reply.ok) {
      askRoute = 'tab';
      askError = null;
      return reply;
    }
    askError = reply ? `reply ${JSON.stringify(reply).slice(0, 120)}` : 'empty reply';
  } catch (error) {
    askError = String((error && error.message) || error).slice(0, 160);
  }
  try {
    const relay = await api.runtime.sendMessage({ type: 'brosr:tab-status' });
    if (relay && relay.ok && relay.reply && relay.reply.ok) {
      askRoute = 'background';
      askError = null;
      return relay.reply;
    }
    askError = `${askError || ''} relay ${JSON.stringify(relay).slice(0, 120)}`.trim();
  } catch (error) {
    askError = `${askError || ''} relay ${String((error && error.message) || error)}`.slice(0, 200);
  }
  return null;
}

// The room tab also publishes its own status to the background. That copy
// carries no tab id, so a sidebar that cannot name or reach the tab still
// renders the room instead of sitting blank beside it.
async function cachedStatus() {
  try {
    const reply = await api.runtime.sendMessage({ type: 'brosr:cached-status' });
    const status = reply && reply.ok ? reply.status : null;
    if (!status || !status.data) return null;
    if (Date.now() - Number(status.at || 0) > 10000) return null;
    askRoute = 'cached';
    askError = null;
    return {
      ok: true,
      room: status.room,
      peerId: status.peerId,
      role: status.role,
      source: status.source,
      panelUrl: status.panelUrl,
      data: status.data,
    };
  } catch {
    return null;
  }
}

async function refresh() {
  try {
    const tab = await targetTab();
    if (tab) {
      const reply = await askStatus(tab);
      if (reply) return render(reply);
    } else {
      askRoute = null;
      askError = `no tab (background ${JSON.stringify(tabHint)})`;
    }
    const cached = await cachedStatus();
    if (cached) return render(cached);
    return missing(tab ? 'This tab is not in a room.' : 'Open a room tab first.');
  } catch {
    // A tab without the content script rejects the message.
    missing('This tab is not in a room.');
  }
}

async function control(allowed, peer) {
  const tab = await targetTab();
  if (!tab) return notice('Open a room tab first.', true);
  const peerId = String(peer || '').trim();
  if (!peerId) return notice('Choose a peer first.', true);
  try {
    const reply = await api.tabs.sendMessage(tab.id, {
      type: 'brosr:grant',
      peerId,
      allowed,
    });
    if (reply && reply.ok) {
      await refresh();
      notice(allowed ? `Control granted to ${peerId}.` : `Control revoked from ${peerId}.`);
    } else {
      notice('Only the host can change control.', true);
    }
  } catch {
    notice('The room tab did not answer.', true);
  }
}

// Two placeholder rows hold the space the peer list takes, so the first reply
// does not move the panel. They carry no name, so a reader sees only the wait.
function renderSkeleton() {
  const list = $('peers');
  list.replaceChildren();
  for (let i = 0; i < 2; i += 1) {
    const row = document.createElement('li');
    row.className = 'skeleton';
    row.setAttribute('aria-hidden', 'true');
    const long = document.createElement('span');
    long.className = 'w-long';
    const short = document.createElement('span');
    short.className = 'w-short';
    row.append(long, short);
    list.append(row);
  }
}

// The room menu holds every action, so the header keeps one control. Escape,
// a Tab out, an outside click and an item click all close it, and focus returns
// to the button that opened it. Arrow keys walk the rows and Home and End jump
// to either end, so the menu reads the same to a keyboard and to a pointer.
const menu = $('menu');
const menuButton = $('menu-button');
const menuItems = () => [...menu.querySelectorAll('[role="menuitem"]')];

function closeMenu(returnFocus) {
  if (menu.hidden) return;
  menu.hidden = true;
  menuButton.setAttribute('aria-expanded', 'false');
  if (returnFocus) menuButton.focus();
}

function openMenu() {
  menu.hidden = false;
  menuButton.setAttribute('aria-expanded', 'true');
  const [first] = menuItems();
  if (first) first.focus();
}

menuButton.addEventListener('click', (event) => {
  event.stopPropagation();
  if (menu.hidden) openMenu();
  else closeMenu(true);
});

menu.addEventListener('click', (event) => {
  if (event.target.closest('[role="menuitem"]')) closeMenu(true);
});

document.addEventListener('click', (event) => {
  if (menu.hidden) return;
  if (menu.contains(event.target) || menuButton.contains(event.target)) return;
  closeMenu(false);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !menu.hidden) {
    event.preventDefault();
    closeMenu(true);
  }
});

menu.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') return closeMenu(false);
  const key = event.key;
  if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return;
  event.preventDefault();
  const items = menuItems();
  if (!items.length) return;
  if (key === 'Home') return items[0].focus();
  if (key === 'End') return items[items.length - 1].focus();
  const index = items.indexOf(document.activeElement);
  const step = key === 'ArrowDown' ? 1 : -1;
  const next = index < 0 ? 0 : (index + step + items.length) % items.length;
  items[next].focus();
});

// Tab sharing is host led. The panel only says what this browser sends, and the
// background page opens what the host announces.
function hostOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// A target reads as the page it is, not only as the site it sits on.
function pageLabel(url) {
  try {
    const parsed = new URL(String(url));
    return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname}`;
  } catch {
    return String(url || '');
  }
}

function renderTabs() {
  const list = $('tabs-list');
  const auto = $('tabs-auto');
  const note = $('tabs-note');
  if (!list || !auto || !note) return;
  const state = tabState;
  // Control is what allows a tab to go out. A granted peer holds it just as
  // the host does, so a ticked tab works for either one.
  const canShare = Boolean(state && state.canShare);
  const guest = Boolean(state && !state.canShare);
  auto.disabled = !canShare;
  auto.checked = Boolean(state && state.auto);
  auto.title = canShare ? 'Send every new tab to the room.' : 'Ask the host for control first.';
  const noticeBox = $('notice-media');
  if (noticeBox) {
    noticeBox.checked = !state || state.notices !== false;
    noticeBox.disabled = !state;
  }
  note.hidden = !guest;
  note.textContent = guest ? 'Ask the host for control, then tick a tab.' : '';
  renderSync();
  list.replaceChildren();
  // A browser without control never shares, so its own tabs are not a choice
  // and the list stays empty. Showing them would suggest a control it does not
  // hold.
  if (!canShare) return;
  const tabs = (state && Array.isArray(state.tabs) ? state.tabs : []).filter((tab) => !tab.room);
  if (!tabs.length) {
    const empty = document.createElement('li');
    empty.className = 'tabs-empty';
    empty.textContent = state ? 'No other tab to share yet.' : 'Reading tabs...';
    list.append(empty);
    return;
  }
  for (const tab of tabs) {
    const row = document.createElement('li');
    const label = document.createElement('label');
    label.className = 'tab-row';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = Boolean(tab.shared);
    box.disabled = !canShare;
    box.setAttribute('aria-label', `Share ${tab.title || 'this tab'}`);
    const text = document.createElement('span');
    text.className = 'tab-text';
    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title || tab.url || 'Tab';
    title.title = tab.url || '';
    const hostName = document.createElement('span');
    hostName.className = 'tab-host';
    hostName.textContent = hostOf(tab.url);
    text.append(title, hostName);
    label.append(box, text);
    box.addEventListener('change', () => setShared(tab, box));
    row.append(label);
    list.append(row);
  }
}

// A worker that is still starting can hold a message channel open. A short
// timeout keeps the list from waiting forever, and the next pass fills it.
function tabMessage(payload) {
  return Promise.race([
    api.runtime.sendMessage(payload),
    new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
  ]);
}

async function loadTabs() {
  if (!api || !api.runtime || !$('tabs-list')) return;
  try {
    const reply = await tabMessage({ type: 'brosr:tabs-list' });
    if (reply && reply.ok) {
      tabState = {
        role: reply.role || '',
        canShare: Boolean(reply.canShare || reply.role === 'host'),
        auto: Boolean(reply.auto),
        sync: reply.sync !== false,
        notices: reply.notices !== false,
        tabs: Array.isArray(reply.tabs) ? reply.tabs : [],
      };
      renderTabs();
      return;
    }
  } catch {
    // A worker restart drops one read. The next open fills the list.
  }
  if (!tabState) {
    tabState = { role: '', auto: false, tabs: [] };
    renderTabs();
  }
}

// The box moves at once and rolls back when the background page refuses, so a
// guest never sees a tab marked shared that the room never received.
async function setShared(tab, box) {
  const wanted = box.checked;
  box.disabled = true;
  try {
    const reply = await tabMessage({
      type: 'brosr:tab-share',
      tabId: tab.id,
      shared: wanted,
    });
    if (reply && reply.ok) {
      notice(wanted ? 'Sharing that tab.' : 'That tab stays private.');
      await loadTabs();
      return;
    }
    box.checked = !wanted;
    notice('Ask the host for control first.', true);
  } catch {
    box.checked = !wanted;
    notice('The background page did not answer.', true);
  }
  box.disabled = false;
}

// Playback sync is a switch, not a property of a room. The panel says which
// way it points and the background drops the frames either way.
function renderSync() {
  const box = $('sync-media');
  const note = $('playback-note');
  if (!box) return;
  box.checked = !tabState || tabState.sync !== false;
  box.disabled = !tabState;
  if (note) {
    note.textContent = box.checked
      ? 'This browser follows the room playhead.'
      : 'This browser plays on its own.';
  }
}

const syncBox = $('sync-media');
if (syncBox) {
  syncBox.addEventListener('change', async (event) => {
    const box = event.currentTarget;
    const wanted = box.checked;
    box.disabled = true;
    try {
      const reply = await tabMessage({ type: 'brosr:sync-toggle', on: wanted });
      if (reply && reply.ok) {
        notice(wanted ? 'Playback follows the room.' : 'Playback stays on this browser.');
        await loadTabs();
        return;
      }
      box.checked = !wanted;
      notice('The browser did not answer.', true);
    } catch {
      box.checked = !wanted;
      notice('The background page did not answer.', true);
    }
    box.disabled = false;
  });
}

const noticeToggle = $('notice-media');
if (noticeToggle) {
  noticeToggle.addEventListener('change', async (event) => {
    const box = event.currentTarget;
    const wanted = box.checked;
    box.disabled = true;
    try {
      const reply = await tabMessage({ type: 'brosr:notice-toggle', on: wanted });
      if (reply && reply.ok) {
        notice(wanted ? 'Action notices are on.' : 'Action notices are off.');
        await loadTabs();
        return;
      }
      box.checked = !wanted;
      notice('The browser did not answer.', true);
    } catch {
      box.checked = !wanted;
      notice('The background page did not answer.', true);
    }
    box.disabled = false;
  });
}

// Trusted typing follows one tab at a time. The switch sends that tab's URL to
// the room tab, and the helper resolves it on this browser. A room opened
// without a trusted channel answers no-trust and the switch rolls back.
const trustBox = $('trust-target');
if (trustBox) {
  trustBox.addEventListener('change', async (event) => {
    const box = event.currentTarget;
    const wanted = box.checked;
    const tab = await targetTab();
    if (!tab) {
      box.checked = !wanted;
      return notice('Open a room tab first.', true);
    }
    let url = null;
    if (wanted) {
      const [active] = await api.tabs.query({ active: true, currentWindow: true });
      const open = (await api.tabs.query({ currentWindow: true })).filter(usable);
      const page =
        usable(active) && /^https?:/.test(active.url || '') && !isRoomPage(active.url || '')
          ? active
          : open.find((item) => /^https?:/.test(item.url || '') && !isRoomPage(item.url || ''));
      if (!page) {
        box.checked = false;
        return notice('Open the page you want to type into, then tick this.', true);
      }
      url = page.url;
    }
    box.disabled = true;
    try {
      const reply = await api.tabs.sendMessage(tab.id, { type: 'brosr:trust-target', url });
      if (reply && reply.ok) {
        notice(url ? `Typing goes to ${pageLabel(url)}.` : 'Typing goes to the room tab.');
        await refresh();
        return;
      }
      box.checked = !wanted;
      notice(
        reply && reply.reason === 'no-trust'
          ? 'Start the room with trusted input first.'
          : 'The room tab did not answer.',
        true
      );
    } catch {
      box.checked = !wanted;
      notice('The room tab did not answer.', true);
    }
    box.disabled = false;
  });
}

$('tabs-auto').addEventListener('change', async (event) => {
  const box = event.currentTarget;
  const wanted = box.checked;
  box.disabled = true;
  try {
    const reply = await tabMessage({ type: 'brosr:tabs-auto', on: wanted });
    if (reply && reply.ok) {
      notice(wanted ? 'New tabs go to the room.' : 'New tabs stay private.');
      await loadTabs();
      return;
    }
    box.checked = !wanted;
    notice('Ask the host for control first.', true);
  } catch {
    box.checked = !wanted;
    notice('The background page did not answer.', true);
  }
  box.disabled = false;
});

renderPanelSites();
renderSkeleton();
// One pass before the read, so the section states what it is doing instead of
// sitting blank while a cold worker starts.
renderTabs();
loadTabs();
$('refresh').addEventListener('click', refresh);

// The watch button opens the room's film. A tab that already shows it comes to
// the front, so a second click never opens a duplicate.
$('watch-toggle').addEventListener('click', async () => {
  const media = lastReply && lastReply.data ? lastReply.data.media : null;
  if (!media || !media.url) return notice('No film in this room yet.', true);
  try {
    const reply = await api.runtime.sendMessage({
      type: 'brosr:open-film',
      key: media.key,
      url: media.url,
    });
    if (reply && reply.ok) {
      notice(reply.focused ? 'The film tab is in front.' : 'Opened the film.');
    } else {
      notice('The browser did not open the film.', true);
    }
  } catch {
    notice('The browser did not open the film.', true);
  }
});

// One copy path serves the invite card and the menu item. The button confirms
// in place, so a person sees the copy without reading the notice line.
async function copyInvite(button) {
  const field = $('invite');
  if (!field.value) return notice('Open a room tab first.', true);
  try {
    await navigator.clipboard.writeText(field.value);
    if (button) {
      const label = button.dataset.label || button.textContent;
      button.dataset.label = label;
      button.textContent = 'Copied';
      setTimeout(() => {
        button.textContent = label;
      }, 1400);
    }
    notice('Join link copied.');
  } catch {
    field.select();
    notice('Press Command C to copy the link.', true);
  }
}

$('invite-copy').addEventListener('click', (event) => copyInvite(event.currentTarget));
$('copy').addEventListener('click', () => copyInvite($('invite-copy')));
// The browser owns the popup frame, so the page closes itself. A page in a tab
// closes that tab instead, and a bare page closes itself the same way.
$('hide').addEventListener('click', async () => {
  if (SURFACE === 'tab' && api && api.tabs && api.tabs.getCurrent) {
    try {
      const tab = await api.tabs.getCurrent();
      if (tab && tab.id >= 0) {
        await api.tabs.remove(tab.id);
        return;
      }
    } catch {
      // A refused tab close falls through to the page path.
    }
  }
  window.close();
});

// Leave closes the room tab's socket and clears its stored identity, then the
// panel shows the room as gone instead of leaving a live dot behind.
$('leave').addEventListener('click', async () => {
  const tab = await targetTab().catch(() => null);
  if (!tab) return notice('Open a room tab first.', true);
  try {
    const reply = await api.tabs.sendMessage(tab.id, { type: 'brosr:leave' });
    if (!reply || !reply.ok) return notice('The room tab did not answer.', true);
    notice('Left the room.');
    await refresh();
  } catch {
    notice('The room tab did not answer.', true);
  }
});
refresh();
setInterval(refresh, 2000);

// The background page carries this report to the room tab, which is how a
// headless run can prove the panel rendered without drawing chrome.
setInterval(async () => {
  try {
    // The check lane reads the route here, so it can prove which path drew the
    // panel without reaching into the extension context.
    document.documentElement.dataset.brosrRoute = askRoute || '';
    await api.runtime.sendMessage({
      type: 'brosr:panel-report',
      state: {
        state: $('dot').dataset.state,
        route: askRoute,
        surface: SURFACE,
        error: askError,
        width: innerWidth,
        height: innerHeight,
        visible: document.visibilityState,
        room: $('room').textContent,
        seal: lastReply && lastReply.data ? lastReply.data.seal || null : null,
        invite: $('invite').value,
        count: $('count').textContent,
        playback: $('playback').textContent,
        media: lastReply && lastReply.data ? lastReply.data.media || null : null,
        viewers:
          lastReply && lastReply.data && Array.isArray(lastReply.data.viewers)
            ? lastReply.data.viewers.map((entry) => ({
                id: entry.id,
                open: Boolean(entry.viewer && entry.viewer.open),
                inSync: entry.viewer ? entry.viewer.inSync : null,
                behind: entry.viewer ? entry.viewer.behind : null,
              }))
            : [],
        watch:
          $('watch-state').textContent +
          ' | ' +
          [...document.querySelectorAll('#watch-viewers .watch-badge')]
            .map((node) => node.textContent)
            .join(', '),
        control: !$('control').hidden,
        tabs: tabState
          ? {
              role: tabState.role,
              auto: tabState.auto,
              count: tabState.tabs.filter((tab) => !tab.room).length,
            }
          : null,
        notice: $('notice').textContent,
        status: $('status').textContent,
        peers: [...document.querySelectorAll('#peers .name')].map((node) => node.textContent),
        grantedPeers: [...document.querySelectorAll('#peers li[data-granted="1"]')].map(
          (node) => node.dataset.peer
        ),
        history: [...document.querySelectorAll('#history li')].map((node) => node.textContent),
        geometry: (() => {
          const box = (node) => {
            if (!node) return null;
            const rect = node.getBoundingClientRect();
            return {
              w: Math.round(rect.width),
              h: Math.round(rect.height),
              top: Math.round(rect.top),
              left: Math.round(rect.left),
            };
          };
          return {
            width: innerWidth,
            height: innerHeight,
            header: box(document.querySelector('.room-header')),
            peer: box(document.querySelector('#peers li[data-peer]')),
            footer: box(document.querySelector('footer')),
            scrollW: document.documentElement.scrollWidth,
            overflowX: document.documentElement.scrollWidth > innerWidth + 1,
          };
        })(),
        selftest: new URLSearchParams(location.search).get('selftest'),
      },
    });
  } catch {
    // The extension is reloading.
  }
}, 500);

if (new URLSearchParams(location.search).get('selftest') === '1') {
  // Drive Grant and then Revoke. A headless tab can take twenty seconds to
  // register with the background page, so this retries until each lands. The
  // grant holds for a moment so a peer tab can report that it received it.
  let tries = 0;
  let stage = 'grant';
  let sent = false;
  let holdUntil = 0;
  let selftestPeer = null;
  const timer = setInterval(async () => {
    tries += 1;
    await refresh();
    if ($('control').hidden) {
      if (tries > 120) clearInterval(timer);
      return;
    }
    const text = String($('notice').textContent);
    if (stage === 'grant') {
      if (text.includes('Control granted')) {
        if (!holdUntil) holdUntil = Date.now() + 2500;
        if (Date.now() < holdUntil) return;
        stage = 'revoke';
        sent = false;
        return;
      }
      const guest = ((lastReply && lastReply.data && lastReply.data.peerList) || []).find(
        (peer) => peer && peer.id && !peer.self
      );
      if (!guest) {
        if (tries > 120) clearInterval(timer);
        return;
      }
      if (!sent) {
        selftestPeer = guest.id;
        const button = document.querySelector(
          `#peers li[data-peer="${guest.id}"] .peer-control`
        );
        if (button) button.click();
        sent = true;
      }
      return;
    }
    if (text.includes('Control revoked')) {
      clearInterval(timer);
      return;
    }
    if (!sent) {
      const button = selftestPeer
        ? document.querySelector(`#peers li[data-peer="${selftestPeer}"] .peer-control`)
        : null;
      if (button) button.click();
      sent = true;
    }
    if (tries > 120) clearInterval(timer);
  }, 500);
}

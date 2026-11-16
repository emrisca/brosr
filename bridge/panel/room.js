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

// The stylesheet owns the neutral palette in both colour schemes. The panel
// follows the system scheme and never borrows a page or browser accent.
// The room tab carries the room and the transport in its URL. A join link
// keeps the page and the room, drops the host identity and adds a guest one.
function inviteLink(href, roomName) {
  if (!href) return '';
  try {
    const url = new URL(href);
    for (const key of ['role', 'peer', 'name', 'panel', 'selftest', 'bias', 'grant', 'capture']) {
      url.searchParams.delete(key);
    }
    url.searchParams.set('role', 'peer');
    url.searchParams.set('peer', GUEST);
    url.searchParams.set('name', 'Guest');
    if (roomName) url.searchParams.set('rname', roomName);
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

const FALLBACK_COLOURS = [
  '#e2603f',
  '#3f86e2',
  '#d94f8a',
  '#2f9e6b',
  '#b07a2a',
  '#7a5cd6',
  '#cf3b3b',
  '#2f8fa8',
  '#8f6a3d',
  '#6366f1',
  '#c2410c',
  '#15803d',
];
let cursorCards = [];
let cursorBusy = false;
let cursorStatusAt = 0;

function setCursorStatus(message, bad) {
  const node = $('cursor-status');
  if (!node) return;
  node.textContent = message;
  cursorStatusAt = Date.now();
  if (bad) node.dataset.bad = '1';
  else delete node.dataset.bad;
}

async function roomMessage(payload) {
  const tab = await targetTab();
  if (!tab) {
    notice('Open a room tab first.', true);
    return null;
  }
  try {
    return await api.tabs.sendMessage(tab.id, payload);
  } catch {
    notice('The room tab did not answer.', true);
    return null;
  }
}

function renderSettings(data) {
  const nameInput = $('room-name');
  if (nameInput && document.activeElement !== nameInput) {
    nameInput.value = (data && data.roomName) || $('room').textContent || '';
  }

  const grid = $('colour-grid');
  if (!grid) return;
  const colours = [
    ...new Set([
      ...(Array.isArray(data && data.colours) && data.colours.length
        ? data.colours
        : FALLBACK_COLOURS),
      data && data.colour,
    ].filter(Boolean)),
  ];
  const custom = Boolean(data && data.cursor && data.cursor.src);
  const signature = `${Boolean(data)}|${custom}|${data && data.colour}|${colours.join(',')}`;
  if (grid.dataset.signature !== signature) {
    grid.dataset.signature = signature;
    grid.replaceChildren();
    for (const colour of colours) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'colour-swatch';
      button.style.background = colour;
      button.title = colour;
      button.setAttribute('aria-label', `Use ${colour}`);
      button.setAttribute('aria-pressed', String(Boolean(data && data.colour === colour)));
      button.disabled = !data || custom;
      button.addEventListener('click', () => setRoomColour(colour, button));
      grid.append(button);
    }
  }

  const note = $('colour-note');
  if (note) {
    note.textContent = custom
      ? `Using ${(data.cursor.name || 'a custom cursor')}. Colour is off because the image carries its own.`
      : data
        ? 'Pick the colour other people see.'
        : 'Open a room to choose a colour.';
  }

  const show = $('show-cursor');
  if (show) {
    show.checked = !data || data.showOwnCursor !== false;
    show.disabled = !data || !custom;
  }
  const showNote = $('show-cursor-note');
  if (showNote) {
    showNote.textContent = !custom
      ? 'Pick a cursor above, then the switch draws it here.'
      : show && !show.checked
        ? 'Your own pointer is the system arrow here.'
        : 'On draws your own pick on every page here. Off keeps the system arrow.';
  }

  const own = $('own-cursor');
  if (own) {
    own.checked = !data || data.sharePointer !== false;
    own.disabled = !data;
  }
  const ownNote = $('own-cursor-note');
  if (ownNote) {
    ownNote.textContent = own && !own.checked
      ? 'Your pointer is hidden from every other screen.'
      : 'Off keeps your pointer off every other screen.';
  }

  const names = $('cursor-names');
  if (names) {
    names.checked = !data || data.cursorNames !== false;
    names.disabled = !data;
  }

  // The site list belongs to the host. A peer sees no card at all.
  const sitesCard = $('cursor-sites');
  if (sitesCard) {
    const host = Boolean(data && data.role === 'host');
    sitesCard.hidden = !host;
    if (host) renderCursorSites(data);
  }

  const clear = $('cursor-clear');
  if (clear) clear.hidden = !custom;
  if (!cursorBusy && Date.now() - cursorStatusAt > 4000) {
    const node = $('cursor-status');
    if (node) {
      node.textContent = custom
        ? `Selected: ${data.cursor.name || 'custom cursor'}.`
        : 'No custom cursor.';
      delete node.dataset.bad;
    }
  }
}

function siteParts(key) {
  try {
    const url = new URL(key);
    const path = url.pathname.replace(/\/+$/, '');
    return { host: url.host, path: path && path !== '/' ? path : '' };
  } catch {
    return { host: key, path: '' };
  }
}

function siteLabel(key) {
  const parts = siteParts(key);
  return parts.path ? `${parts.host}${parts.path}` : parts.host;
}

function renderCursorSites(data) {
  const list = $('cursor-sites-list');
  if (!list) return;
  const policy = Array.isArray(data && data.cursorSites) ? data.cursorSites : null;
  const seen = Array.isArray(data && data.cursorSeen) ? data.cursorSeen : [];
  const defaults = (() => {
    try {
      const origin = new URL((data && data.url) || '').origin;
      return [`${origin}/canvas`, `${origin}/notes`];
    } catch {
      return [];
    }
  })();
  const forgotten = Array.isArray(data && data.cursorForgot) ? data.cursorForgot : [];
  const keep = (key) => !forgotten.includes(key);
  const keys = [...new Set([...(policy || []), ...seen, ...defaults])].filter(keep);
  const active = (policy || defaults).filter(keep);
  const signature = `${active.join(',')}|${keys.join(',')}`;
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
  list.replaceChildren();
  if (!keys.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No sites yet. A site joins this list the first time someone visits it.';
    list.append(empty);
    return;
  }
  for (const key of keys) {
    const row = document.createElement('li');
    const label = document.createElement('label');
    label.className = 'switch-row';
    const parts = siteParts(key);
    const text = document.createElement('span');
    text.className = 'site-text';
    text.title = key;
    const host = document.createElement('span');
    host.className = 'site-host';
    host.textContent = parts.host;
    text.append(host);
    // The path sits on its own line, so two long addresses on one host still
    // read as different sites.
    if (parts.path) {
      const path = document.createElement('span');
      path.className = 'site-path';
      path.textContent = parts.path;
      text.append(path);
    }
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = active.includes(key);
    input.addEventListener('change', () => setCursorSite(key, input.checked));
    label.append(text, input);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'site-forget';
    const name = siteLabel(key);
    remove.title = `Remove ${name} from this list`;
    remove.setAttribute('aria-label', `Remove ${name} from this list`);
    remove.textContent = '×';
    remove.addEventListener('click', () => forgetCursorSite(key));
    row.append(label, remove);
    list.append(row);
  }
}

async function setCursorNames(on) {
  const reply = await roomMessage({ type: 'brosr:cursor-names', on });
  if (reply && reply.ok) {
    notice(on ? 'Pointer names are on.' : 'Pointer names are off.');
    await refresh();
  } else {
    $('cursor-names').checked = !on;
    notice('The name setting did not change.', true);
  }
}

async function setCursorSite(site, on) {
  const reply = await roomMessage({ type: 'brosr:cursor-site', site, on });
  if (reply && reply.ok) {
    notice(
      on ? `${siteLabel(site)} shows cursors.` : `${siteLabel(site)} hides cursors.`
    );
    await refresh();
  } else {
    notice('The site list did not change.', true);
    await refresh();
  }
}

async function forgetCursorSite(site) {
  const reply = await roomMessage({ type: 'brosr:cursor-forget', site, on: true });
  if (reply && reply.ok) {
    notice(`${siteLabel(site)} is off the list.`);
    await refresh();
  } else {
    notice('The site list did not change.', true);
    await refresh();
  }
}

async function saveRoomName() {
  const value = $('room-name').value.trim();
  if (!value) return notice('Type a room name first.', true);
  const button = $('room-name-save');
  button.disabled = true;
  const reply = await roomMessage({ type: 'brosr:room-name', roomName: value });
  button.disabled = false;
  if (reply && reply.ok) {
    notice('Room renamed.');
    await refresh();
  } else {
    notice('The room name did not change.', true);
  }
}

async function setRoomColour(value, button) {
  button.disabled = true;
  const reply = await roomMessage({ type: 'brosr:colour', colour: value });
  if (reply && reply.ok) {
    notice('Cursor colour changed.');
    await refresh();
  } else {
    button.disabled = false;
    notice('That colour did not stick.', true);
  }
}

function cursorSetUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  if (host !== 'cursors-4u.com' && host !== 'www.cursors-4u.com' && !host.endsWith('.cursors-4u.com')) {
    return null;
  }
  if (!url.pathname.startsWith('/cursor/')) return null;
  return url;
}

function parseCursorSet(html, base) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const cards = [];
  const seen = new Set();
  for (const anchor of doc.querySelectorAll('a.cursor-set-link')) {
    let href;
    let preview;
    try {
      href = new URL(anchor.getAttribute('href') || '', base).toString();
      const image = anchor.querySelector('img');
      preview = image ? new URL(image.getAttribute('src') || '', base).toString() : '';
    } catch {
      continue;
    }
    if (!href || !preview || seen.has(href)) continue;
    const text = (anchor.getAttribute('title') || anchor.querySelector('img')?.getAttribute('alt') || 'Cursor')
      .replace(/\s*Cursor$/i, '')
      .trim();
    seen.add(href);
    cards.push({ name: text || 'Cursor', href, preview });
  }
  return cards.slice(0, 40);
}

function renderCursorCards(cards) {
  const list = $('cursor-results');
  if (!list) return;
  list.replaceChildren();
  const selected = lastReply && lastReply.data && lastReply.data.cursor
    ? lastReply.data.cursor.name || ''
    : '';
  for (const card of cards) {
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cursor-choice';
    button.setAttribute('aria-pressed', String(Boolean(selected) && selected === card.name));
    button.title = card.name;
    const image = document.createElement('img');
    image.src = card.preview;
    image.alt = '';
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    const label = document.createElement('span');
    label.className = 'cursor-name';
    label.textContent = card.name;
    button.append(image, label);
    button.addEventListener('click', () => chooseCursor(card, button));
    row.append(button);
    list.append(row);
  }
}

async function cursorImage(preview) {
  const response = await fetchWithDeadline(preview, 8000, { credentials: 'include' });
  if (!response.ok) throw new Error('The preview did not load.');
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw new Error('The preview is not an image.');
  if (blob.size > 500000) throw new Error('The cursor image is too large.');
  const bitmap = await createImageBitmap(blob);
  for (const size of [32, 28, 24, 20]) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) continue;
    context.clearRect(0, 0, size, size);
    context.imageSmoothingEnabled = true;
    context.drawImage(bitmap, 0, 0, size, size);
    let src = canvas.toDataURL('image/webp', 0.82);
    if (!src.startsWith('data:image/webp')) src = canvas.toDataURL('image/png');
    if (src.length <= 11800) {
      bitmap.close?.();
      return { src, w: size, h: size };
    }
  }
  bitmap.close?.();
  throw new Error('The cursor image is too large for the room.');
}

async function chooseCursor(card, button) {
  cursorBusy = true;
  button.disabled = true;
  setCursorStatus(`Loading ${card.name}...`);
  try {
    const image = await cursorImage(card.preview);
    const reply = await roomMessage({
      type: 'brosr:cursor',
      cursor: { ...image, name: card.name },
    });
    if (!reply || !reply.ok) throw new Error('The room did not accept that cursor.');
    notice('Custom cursor set for the room.');
    await refresh();
  } catch (error) {
    setCursorStatus(String((error && error.message) || error), true);
    notice('That cursor did not load.', true);
  } finally {
    cursorBusy = false;
    button.disabled = false;
  }
}

// A challenged request can hang instead of failing, so every read of the site
// carries a deadline and the tab fallback takes over when it expires.
async function fetchWithDeadline(url, ms, options) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: control.signal });
  } finally {
    clearTimeout(timer);
  }
}

// The site answers an extension fetch with its bot check, so a tab that
// already loaded the set hands over the page it rendered. With no such tab,
// the set gets one of its own for as long as it takes to read the markup.
async function cursorSetHtml(url) {
  const readTab = async (tabId) => {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      try {
        const reply = await api.tabs.sendMessage(tabId, { type: 'brosr:cursor-set' });
        if (reply && reply.ok && typeof reply.html === 'string') return reply.html;
      } catch {
        // The page may still be loading its content script.
      }
      try {
        // A tab opened in the background does not always run its content
        // script, and this read does not wait for one.
        const results = await api.scripting.executeScript({
          target: { tabId },
          func: () => (document.documentElement ? document.documentElement.outerHTML : ''),
        });
        const html = results && results[0] ? results[0].result : '';
        if (typeof html === 'string' && html.includes('cursor-set-link')) return html;
      } catch {
        // The tab may still be on its way to the set page.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return null;
  };
  try {
    const response = await fetchWithDeadline(url, 4000, {
      credentials: 'include',
      redirect: 'follow',
    });
    if (response.ok) {
      const html = await response.text();
      if (!/Just a moment|challenge-platform|cf-chl/i.test(html)) return html;
    }
  } catch {
    // Fall through to a tab.
  }
  try {
    const prefix = url.origin + url.pathname;
    const tabs = (await api.tabs.query({})).filter(usable);
    const open = tabs.find((entry) => String(entry.url || '').startsWith(prefix));
    if (open) return await readTab(open.id);
    const created = await api.tabs.create({ url: url.toString(), active: false });
    if (!created || created.id === undefined) return null;
    const html = await readTab(created.id);
    try {
      await api.tabs.remove(created.id);
    } catch {
      // The tab is the browser's problem now.
    }
    return html;
  } catch {
    // No tab answered.
  }
  return null;
}

async function loadCursorSet() {
  const url = cursorSetUrl($('cursor-set').value);
  if (!url) {
    setCursorStatus('Paste a cursors-4u set link, not a cursor or another site.', true);
    return;
  }
  const button = $('cursor-load');
  button.disabled = true;
  cursorBusy = true;
  setCursorStatus('Loading the set...');
  try {
    const html = await cursorSetHtml(url);
    if (!html) {
      throw new Error('cursors-4u is checking this browser. Open the set in a tab, then load it again.');
    }
    const cards = parseCursorSet(html, url);
    if (!cards.length) throw new Error('That page does not list a cursor set.');
    cursorCards = cards;
    renderCursorCards(cards);
    setCursorStatus(`${cards.length} pointers. Pick one for the room.`);
    notice('Cursor set loaded.');
  } catch (error) {
    setCursorStatus(String((error && error.message) || error), true);
    notice('The cursor set did not load. Paste its page link and try again.', true);
  } finally {
    cursorBusy = false;
    button.disabled = false;
  }
}

async function clearCursor() {
  const reply = await roomMessage({ type: 'brosr:cursor', cursor: null });
  if (reply && reply.ok) {
    notice('Colour choice is back.');
    await refresh();
  } else {
    notice('The custom cursor did not clear.', true);
  }
}

async function setOwnCursor(on) {
  const reply = await roomMessage({ type: 'brosr:own-cursor', on });
  if (reply && reply.ok) {
    notice(on ? 'Your pointer is shared.' : 'Your pointer is hidden.');
    await refresh();
  } else {
    $('own-cursor').checked = !on;
    notice('The pointer setting did not change.', true);
  }
}

async function setShowOwnCursor(on) {
  const reply = await roomMessage({ type: 'brosr:show-own-cursor', on });
  if (reply && reply.ok) {
    notice(on ? 'Your custom cursor is on.' : 'Your custom cursor is off here.');
    await refresh();
  } else {
    $('show-cursor').checked = !on;
    notice('The cursor setting did not change.', true);
  }
}

function renderHistory(data) {
  const list = $('history');
  list.replaceChildren();
  const history = Array.isArray(data.controlHistory)
    ? data.controlHistory.slice(-3).reverse()
    : [];
  if (!history.length) return;
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
    copy.textContent = 'No film yet.';
    button.textContent = 'Open the film';
    button.disabled = true;
    button.title = 'No film yet';
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
  delete document.body.dataset.state;
  const data = reply.data || {};
  const roomLabel = data.roomName || reply.roomName || reply.room || 'room';
  $('room').textContent = roomLabel;
  $('role').textContent = reply.role || '';
  // The background page learns the role from the room tab hello. When the tab
  // list lands first, this fills the gap on the next status pass.
  if (tabState && !tabState.role && reply.role) {
    tabState.role = reply.role;
    renderTabs();
  }
  $('dot').dataset.state = data.socket === 1 ? 'live' : 'down';
  if (data.socket === 1) setStatus('');
  else setStatus('Reconnecting...', 'error');
  $('control').hidden = reply.role !== 'host';
  renderSeal(data.seal);
  renderTrust(data);
  const invite = inviteLink(data.inviteUrl || data.location, roomLabel);
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
  document.title = connected ? `Brosr \u00b7 ${roomLabel}` : 'Brosr room';
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
  renderSettings(data);
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
  document.body.dataset.state = 'missing';
  $('dot').dataset.state = 'down';
  setStatus(reason || 'This tab is not in a room.', 'error');
  $('peers').replaceChildren();
  $('control').hidden = true;
  $('latency').textContent = '-';
  $('count').textContent = '';
  document.title = 'Brosr room';
  $('invite-box').hidden = true;
  $('invite').value = '';
  $('room').textContent = 'Room';
  renderSettings(null);
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

// The room and cursor controls share one menu. Tabs keep the shared surface
// page clean, and a keyboard reaches both panels without opening the menu.
const tabButtons = [...document.querySelectorAll('.panel-tab')];

function selectTab(id) {
  for (const button of tabButtons) {
    const on = button.id === id;
    button.setAttribute('aria-selected', String(on));
    button.tabIndex = on ? 0 : -1;
    const pane = document.getElementById(button.getAttribute('aria-controls'));
    if (pane) pane.hidden = !on;
  }
}

for (const button of tabButtons) {
  button.addEventListener('click', () => selectTab(button.id));
  button.addEventListener('keydown', (event) => {
    const index = tabButtons.indexOf(button);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % tabButtons.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabButtons.length) % tabButtons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabButtons.length - 1;
    else return;
    event.preventDefault();
    selectTab(tabButtons[next].id);
    tabButtons[next].focus();
  });
}

selectTab('tab-room');

$('room-name-save').addEventListener('click', saveRoomName);
$('room-name').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  saveRoomName();
});
$('cursor-load').addEventListener('click', loadCursorSet);
$('cursor-set').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  loadCursorSet();
});
$('cursor-clear').addEventListener('click', clearCursor);
$('show-cursor').addEventListener('change', (event) => {
  setShowOwnCursor(event.currentTarget.checked);
});
$('own-cursor').addEventListener('change', (event) => {
  setOwnCursor(event.currentTarget.checked);
});
$('cursor-names').addEventListener('change', (event) => {
  setCursorNames(event.currentTarget.checked);
});

renderPanelSites();
renderSkeleton();
// One pass before the read, so the section states what it is doing instead of
// sitting blank while a cold worker starts.
renderTabs();
renderSettings(null);
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

// The panel asks a room tab for status. In a sidebar the active tab is the
// room. Opened as a page, the active tab is the panel itself, so the code
// falls back to a room tab on the relay origin.
const $ = (id) => document.getElementById(id);
const ROOM_PAGE = /^https?:\/\/[^/]+\/(room|media|board|form|ad|sync|layout)[^/]*\.html/;

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

function render(reply) {
  lastReply = reply;
  const data = reply.data || {};
  $('room').textContent = reply.room || 'room';
  $('role').textContent = reply.role || '';
  $('dot').dataset.state = data.socket === 1 ? 'live' : 'down';
  setStatus(data.socket === 1 ? 'Connected' : 'Reconnecting...');
  $('control').hidden = reply.role !== 'host';

  const peers = Array.isArray(data.peerList)
    ? data.peerList
    : Array.isArray(data.peers)
      ? data.peers
      : [];
  const count = Number.isFinite(data.peers) ? data.peers : peers.length;
  const list = $('peers');
  list.replaceChildren();
  if (!peers.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    const label = count === 1 ? 'peer' : 'peers';
    empty.textContent = count ? `${count} ${label} in this room.` : 'No peers in this room yet.';
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
    if (peer.self) name.textContent += ' (you)';
    row.append(swatch, name);
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
      action.addEventListener('click', () => control(!peer.granted, peer.id));
      row.append(action);
    }
    list.append(row);
  }

  $('latency').textContent = latencyLabel(data);
  renderHistory(data);
}

function missing(reason) {
  lastReply = null;
  $('dot').dataset.state = 'down';
  setStatus(reason || 'This tab is not in a room.', 'error');
  $('peers').replaceChildren();
  $('control').hidden = true;
  $('latency').textContent = '-';
}

async function targetTab() {
  try {
    const info = await browser.runtime.sendMessage({ type: 'brosr:room-tab' });
    if (info && info.tabId !== null && info.tabId !== undefined) {
      return { id: info.tabId, url: '' };
    }
  } catch {
    // Fall through to the tab list.
  }
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (active && ROOM_PAGE.test(active.url || '')) return active;
  const tabs = await browser.tabs.query({ currentWindow: true });
  return tabs.find((tab) => ROOM_PAGE.test(tab.url || '')) || null;
}

async function refresh() {
  try {
    const tab = await targetTab();
    if (!tab) return missing('Open a room tab first.');
    const reply = await browser.tabs.sendMessage(tab.id, { type: 'brosr:status' });
    if (!reply || !reply.ok) return missing('This tab is not in a room.');
    render(reply);
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
    const reply = await browser.tabs.sendMessage(tab.id, {
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

$('refresh').addEventListener('click', refresh);
refresh();
setInterval(refresh, 2000);

// The background page carries this report to the room tab, which is how a
// headless run can prove the panel rendered without drawing chrome.
setInterval(async () => {
  try {
    await browser.runtime.sendMessage({
      type: 'brosr:panel-report',
      state: {
        state: $('dot').dataset.state,
        room: $('room').textContent,
        control: !$('control').hidden,
        notice: $('notice').textContent,
        status: $('status').textContent,
        peers: [...document.querySelectorAll('#peers .name')].map((node) => node.textContent),
        grantedPeers: [...document.querySelectorAll('#peers li[data-granted="1"]')].map(
          (node) => node.dataset.peer
        ),
        history: [...document.querySelectorAll('#history li')].map((node) => node.textContent),
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

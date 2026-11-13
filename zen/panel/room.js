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
    list.append(row);
  }

  $('latency').textContent = latencyLabel(data);
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

async function control(allowed) {
  const tab = await targetTab();
  if (!tab) return notice('Open a room tab first.', true);
  const peerId = $('peer').value.trim();
  if (!peerId) return notice('Enter a peer id first.', true);
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
$('grant').addEventListener('click', () => control(true));
$('revoke').addEventListener('click', () => control(false));
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
        $('peer').value = guest.id;
        $('grant').click();
        sent = true;
      }
      return;
    }
    if (text.includes('Control revoked')) {
      clearInterval(timer);
      return;
    }
    if (!sent) {
      $('revoke').click();
      sent = true;
    }
    if (tries > 120) clearInterval(timer);
  }, 500);
}

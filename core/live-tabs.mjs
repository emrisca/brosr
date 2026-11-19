// A shared tab is a tab someone with control chose to publish. Peers see it in
// a list and open a copy only when they click. Nothing opens by itself.

import { shareable } from './tabs.mjs';

// A room with more than this many offers is a room nobody can read at a
// glance. The cap keeps the landing page section one screen of choices.
export const MAX_SHARED_TABS = 40;

function cleanText(value, limit) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

// The room validates an offer before the list shows it. A key names the owner's
// tab, so a later navigation updates that row instead of adding a second one.
export function sharedTab(data, { from = '', hostId = null } = {}) {
  if (!data || typeof data !== 'object') return null;
  if (data.action !== 'open') return null;
  if (!shareable(data.url)) return null;
  if (data.key === undefined || data.key === null || String(data.key) === '') return null;
  // The sender names itself, so a peer cannot borrow the host's row by saying
  // it is the host. Only the receiver's own host id grants that role.
  const ownerId = String(from || data.ownerId || '');
  const role = ownerId && hostId && ownerId === String(hostId) ? 'host' : 'control';
  return {
    key: String(data.key),
    url: String(data.url),
    title: cleanText(data.title, 140),
    owner: cleanText(data.owner, 40) || 'Guest',
    ownerId,
    role,
    // A tab with a player says whether it plays. A tab without one keeps null,
    // because the row must not guess a state nobody measured.
    playing: typeof data.playing === 'boolean' ? data.playing : null,
  };
}

// One row per key. The newest offer leads the list, and an older copy of the
// same tab is replaced rather than repeated.
export function rememberSharedTab(list, tab) {
  const current = Array.isArray(list) ? list : [];
  if (!tab || !tab.key) return current;
  const next = [tab, ...current.filter((entry) => entry && entry.key !== tab.key)];
  return next.slice(0, MAX_SHARED_TABS);
}

export function forgetSharedTab(list, key) {
  const id = String(key || '');
  const current = Array.isArray(list) ? list : [];
  if (!id) return current;
  return current.filter((entry) => entry && entry.key !== id);
}

// A publisher says a tab started or stopped playing. The row shows that state
// without re-sending the offer, which already carries the URL and the title.
export function tabMedia(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.action !== 'media') return null;
  if (data.key === undefined || data.key === null || String(data.key) === '') return null;
  if (typeof data.playing !== 'boolean') return null;
  return { key: String(data.key), playing: data.playing };
}

// The newest playback state for one offer. A key nobody published is ignored,
// so a stray frame cannot add a row to the list.
export function noteSharedMedia(list, media) {
  const current = Array.isArray(list) ? list : [];
  const id = String((media && media.key) || '');
  if (!id) return current;
  return current.map((entry) =>
    entry && entry.key === id ? { ...entry, playing: media.playing === true } : entry
  );
}

// The landing page draws one group per person with control. The host sorts
// first because that is the person a room expects to drive.
export function groupSharedTabs(list, { hostId = null } = {}) {
  const groups = new Map();
  for (const tab of Array.isArray(list) ? list : []) {
    if (!tab || !tab.key) continue;
    const id = String(tab.ownerId || tab.owner || '');
    const key = id || 'guest';
    if (!groups.has(key)) {
      groups.set(key, {
        ownerId: id || null,
        owner: tab.owner || 'Guest',
        role: id && hostId && id === String(hostId) ? 'host' : tab.role || 'control',
        tabs: [],
      });
    }
    groups.get(key).tabs.push(tab);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.role === 'host' && b.role !== 'host') return -1;
    if (b.role === 'host' && a.role !== 'host') return 1;
    return String(a.owner).localeCompare(String(b.owner));
  });
}

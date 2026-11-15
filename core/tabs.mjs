// Which tabs a room may share. A tab is shareable when it is a plain web page.
// The browser's own pages, local files and script URLs stay on this machine.

const BLOCKED = /^(chrome|chrome-extension|moz-extension|edge|about|view-source|file|data|blob|javascript):/i;

export const TAB_APP = 'tabs';

export function shareable(url) {
  if (typeof url !== 'string' || !url) return false;
  if (BLOCKED.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// The page validates what arrives before it asks the browser to open anything.
// A frame from another room is already opened, so this is the second check.
// The key names the host tab, so a navigation in that tab moves the copy that
// is already open here instead of opening another one.
export function tabOpen(data) {
  if (!data || typeof data !== 'object' || data.action !== 'open') return null;
  if (!shareable(data.url)) return null;
  const key = data.key === undefined || data.key === null ? null : String(data.key);
  return { url: data.url, key };
}

// Share one site's login between two browsers on this machine. The cookies are
// credentials, so they travel from one local profile to another over the
// browsers' own debug ports, and they never reach the room relay. A guest on
// another machine never receives them.
//
// A site that rotates a session can sign one browser out, so a copy may need a
// repeat. That is a limit of the site, not of the copy.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CDP_TIMEOUT_MS = 8000;

const text = (error) => String((error && error.message) || error);

// A cookie host matches the site itself and every name under it. A lookalike
// such as notyoutube.com is a different site and must not match.
export function cookieDomainMatches(host, domain) {
  const clean = String(domain || '').replace(/^\./, '').toLowerCase();
  if (!clean) return false;
  const value = String(host || '').replace(/^\./, '').toLowerCase();
  if (!value) return false;
  return value === clean || value.endsWith(`.${clean}`);
}

// Firefox stores sameSite as 0, 1 or 2. Chrome reads a name. A cookie with no
// scheme reads as Lax, which is the default in both browsers.
export function sameSiteName(value) {
  const number = Number(value);
  if (number === 2) return 'Strict';
  if (number === 0) return 'None';
  return 'Lax';
}

// A Chrome cookie record from a Firefox row or a Chrome record. The values are
// carried, and only the shape changes.
export function chromiumCookies(rows, { domain } = {}) {
  const cookies = [];
  for (const row of rows || []) {
    const host = String(row.host || row.domain || '');
    if (!cookieDomainMatches(host, domain)) continue;
    const name = String(row.name || '');
    if (!name) continue;
    const secure = Boolean(row.isSecure ?? row.secure);
    let sameSite = sameSiteName(row.sameSite ?? row.same_site);
    // Chrome refuses SameSite=None unless the cookie is Secure.
    if (sameSite === 'None' && !secure) sameSite = 'Lax';
    const expiry = Number(row.expiry ?? row.expires ?? 0);
    cookies.push({
      name,
      value: String(row.value ?? ''),
      domain: host,
      path: String(row.path || '/'),
      secure,
      httpOnly: Boolean(row.isHttpOnly ?? row.httpOnly),
      sameSite,
      // Chrome reads -1 as a session cookie.
      expires: expiry > 0 ? Math.round(expiry) : -1,
    });
  }
  return cookies;
}

async function callOn(wsUrl, method, params = {}, timeout = CDP_TIMEOUT_MS) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('debug socket did not open')), timeout);
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('debug socket failed'));
      },
      { once: true }
    );
  });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeout);
      socket.addEventListener('message', (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message || method));
        else resolve(message.result || {});
      });
      socket.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    socket.close();
  }
}

async function targets(endpoint) {
  const base = String(endpoint || '').replace(/\/$/, '');
  if (!base) throw new Error('pass a debug address, for example http://127.0.0.1:9482');
  let list;
  try {
    list = await (await fetch(`${base}/json/list`)).json();
  } catch (error) {
    throw new Error(`cannot reach the browser at ${base}: ${text(error)}`);
  }
  return Array.isArray(list) ? list : [];
}

async function pageTarget(endpoint) {
  const list = await targets(endpoint);
  const page = list.find((item) => item && item.type === 'page' && item.webSocketDebuggerUrl);
  const any = page || list.find((item) => item && item.webSocketDebuggerUrl);
  if (!any) throw new Error(`no page is open at ${endpoint}`);
  return any;
}

export async function cdpCall(endpoint, method, params = {}) {
  const target = await pageTarget(endpoint);
  return callOn(target.webSocketDebuggerUrl, method, params);
}

// Firefox keeps its cookies in a SQLite file in the profile. A running browser
// holds the store, so this reads a copy and takes the write ahead log with it.
// The copy is removed before the call returns.
export async function readFirefoxCookies(profileDir, domain) {
  const source = path.join(String(profileDir || ''), 'cookies.sqlite');
  if (!fs.existsSync(source)) throw new Error(`no cookie store at ${source}`);
  let sqlite;
  try {
    sqlite = await import('node:sqlite');
  } catch {
    throw new Error('this Node build cannot read a Firefox cookie store');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brosr-cookies-'));
  const file = path.join(dir, 'cookies.sqlite');
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const part = source + suffix;
      if (fs.existsSync(part)) fs.copyFileSync(part, file + suffix);
    }
    const db = new sqlite.DatabaseSync(file);
    try {
      const rows = db
        .prepare(
          'SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies'
        )
        .all();
      return chromiumCookies(rows, { domain });
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function readChromiumCookies(endpoint, domain) {
  const answer = await cdpCall(endpoint, 'Network.getAllCookies');
  return chromiumCookies(answer.cookies || [], { domain });
}

export async function writeChromiumCookies(endpoint, cookies) {
  if (!cookies || !cookies.length) return 0;
  await cdpCall(endpoint, 'Network.setCookies', { cookies });
  return cookies.length;
}

// A page that was already open read the old cookie jar. It needs one reload to
// pick the new one up, and only the pages on the shared site are touched.
export async function reloadChromiumTabs(endpoint, domain) {
  const list = await targets(endpoint);
  let reloaded = 0;
  for (const target of list) {
    if (!target || target.type !== 'page' || !target.webSocketDebuggerUrl) continue;
    let host = '';
    try {
      host = new URL(target.url).hostname;
    } catch {
      continue;
    }
    if (!cookieDomainMatches(host, domain)) continue;
    try {
      await callOn(target.webSocketDebuggerUrl, 'Page.reload', {});
      reloaded += 1;
    } catch {
      // A page that refuses the reload still has the new cookies next time.
    }
  }
  return reloaded;
}

// The one call the host uses. It returns cookie names and never a value, so a
// log or a report cannot leak a session.
export async function shareSession({ from, to, domain, reload = true } = {}) {
  if (!from || !to) throw new Error('a share needs a source and a target');
  if (!domain) throw new Error('pass the site to share, for example youtube.com');
  const cookies =
    from.kind === 'firefox'
      ? await readFirefoxCookies(from.profile, domain)
      : await readChromiumCookies(from.cdp, domain);
  if (!cookies.length) {
    return { ok: false, reason: 'no-cookies', domain, cookies: 0, reloaded: 0, names: [] };
  }
  await writeChromiumCookies(to.cdp, cookies);
  const reloaded = reload ? await reloadChromiumTabs(to.cdp, domain) : 0;
  const names = [...new Set(cookies.map((cookie) => cookie.name))].sort();
  return { ok: true, domain, cookies: cookies.length, reloaded, names };
}

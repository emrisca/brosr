// The host app and the room tab share one private app channel. The token is
// minted by the host start path and travels in the host room URL only.
export const PANEL_APP = 'brosr-panel';
export const PANEL_PEER = 'host-app';

// One schema for both sides of the app-to-CLI boundary. A field that is not in
// this table is refused, so a spelling mistake cannot become a silent no-op.
export const PANEL_ACTIONS = Object.freeze({
  status: Object.freeze({}),
  grant: Object.freeze({ peerId: 'string', allowed: 'boolean' }),
  'cursor-site': Object.freeze({ site: 'string', on: 'boolean' }),
  'cursor-forget': Object.freeze({ site: 'string', on: 'boolean' }),
  'scroll-site': Object.freeze({ site: 'string', on: 'boolean' }),
  'room-name': Object.freeze({ value: 'string' }),
  set: Object.freeze({ key: 'string', on: 'boolean' }),
  tab: Object.freeze({ tabId: 'number', shared: 'boolean' }),
  trust: Object.freeze({ url: 'string' }),
});

// The app uses the long names. The short names predate the app and stay for
// the host commands that already shipped.
export const PANEL_ALIASES = Object.freeze({
  peer: 'peerId',
  allow: 'allowed',
  tab: 'tabId',
});

const FIELD_TYPES = Object.freeze(
  Object.values(PANEL_ACTIONS).reduce((all, fields) => ({ ...all, ...fields }), {})
);

const REQUIRED = Object.freeze({
  grant: Object.freeze(['peerId', 'allowed']),
  'cursor-site': Object.freeze(['site', 'on']),
  'cursor-forget': Object.freeze(['site']),
  'scroll-site': Object.freeze(['site', 'on']),
  'room-name': Object.freeze(['value']),
  set: Object.freeze(['key', 'on']),
  tab: Object.freeze(['tabId', 'shared']),
  trust: Object.freeze(['url']),
});

function parseValue(name, kind, raw) {
  if (kind === 'string') return raw;
  if (kind === 'boolean') {
    if (/^(true|1|on|yes)$/i.test(raw)) return true;
    if (/^(false|0|off|no)$/i.test(raw)) return false;
    throw new Error(`--${name} must be true or false`);
  }
  if (kind === 'number') {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`);
    return value;
  }
  throw new Error(`--${name} has no known type`);
}

export function parsePanelArgs(argv = []) {
  const values = {};
  let guest = false;
  let action = 'status';

  for (const entry of argv) {
    if (typeof entry !== 'string' || !entry.startsWith('--')) {
      throw new Error(`unknown panel argument: ${entry}`);
    }
    const split = entry.indexOf('=');
    const rawName = split < 0 ? entry.slice(2) : entry.slice(2, split);
    if (rawName === 'guest') {
      if (split >= 0) throw new Error('--guest is a flag, not a value');
      guest = true;
      continue;
    }
    if (split < 0) throw new Error(`pass --${rawName}=<value>`);
    const raw = entry.slice(split + 1);
    const name = PANEL_ALIASES[rawName] || rawName;
    if (name === 'action') {
      action = raw;
      continue;
    }
    const kind = FIELD_TYPES[name];
    if (!kind) throw new Error(`unknown panel field: --${rawName}`);
    values[name] = parseValue(name, kind, raw);
  }

  if (!Object.prototype.hasOwnProperty.call(PANEL_ACTIONS, action)) {
    throw new Error(`unknown panel action: ${action}`);
  }
  const fields = PANEL_ACTIONS[action];
  for (const name of Object.keys(values)) {
    if (!Object.prototype.hasOwnProperty.call(fields, name)) {
      throw new Error(`--${name} is not used by the ${action} action`);
    }
  }
  for (const name of REQUIRED[action] || []) {
    if (!Object.prototype.hasOwnProperty.call(values, name)) {
      throw new Error(`the ${action} action needs --${name}`);
    }
  }
  if ('tabId' in values && !Number.isInteger(values.tabId)) {
    throw new Error('--tabId must be a whole tab number');
  }
  return { action, values, guest };
}

import { invoke } from '@tauri-apps/api/core';

export type Browser = {
  id: string;
  name: string;
  vendor: string;
  native: boolean;
  family: 'gecko' | 'chromium';
  path: string;
  version: string | null;
  gecko: string | null;
  geckoMajor: number;
  supported: boolean;
  // Why the build cannot host a room. Null when it can.
  reason: string | null;
  profileRoot: string | null;
};

export type DetectResult = {
  ok: true;
  platform: string;
  browsers: Browser[];
  ready: number;
};

// One setup stage. The host writes these to stderr while it builds the profile,
// and the app listens for them so the screen moves before the command answers.
export type Progress = {
  step: number;
  total: number;
  label: string;
};

export type Prepared = {
  ok: true;
  browser: Browser;
  profile: string;
  bridge: { file: string; built: boolean; version: string | null };
  extensions: number;
  blocker: boolean;
  pstream?: boolean;
  pstreamError?: string | null;
};

// Where the start call spent its time. The room screen shows this line so a
// slow launch names its stage.
export type Timings = {
  prepareMs: number;
  relayMs: number;
  launchMs: number;
  totalMs: number;
  reused: boolean;
};

export type Run = {
  ok: true;
  browser: { id: string; name: string; path: string; family?: 'gecko' | 'chromium' };
  room: string;
  roomName: string;
  name: string;
  host: string;
  port: number;
  url: string;
  invite: string;
  profile: string;
  relayPid: number;
  browserPid: number;
  bridge: { file: string; built: boolean; version: string | null };
  extensions: number;
  pstream?: boolean;
  pstreamError?: string | null;
  panelToken?: string;
  timings?: Timings;
};

export type Status = Run & {
  running: boolean;
  relayAlive: boolean;
  browserAlive: boolean;
  relayReady: boolean;
  peers: number;
};

type Failure = { ok?: false; error?: string; reason?: string };

// One call, one JSON answer. A command that fails rejects with the text the
// host wrote to stderr, so the screen can show it without a second lookup.
async function host<T>(args: string[]): Promise<T> {
  const answer = await invoke<T & Failure>('host', { args });
  if (!answer || answer.ok === false) {
    const error = new Error(answer?.error || 'The host did not answer.');
    if (answer?.reason) (error as Error & { reason?: string }).reason = answer.reason;
    throw error;
  }
  return answer as T;
}

export const detect = () => host<DetectResult>(['detect']);

export const prepare = (browser: string) =>
  host<Prepared>(['prepare', `--browser=${browser}`]);

export const start = (browser: string, name: string, roomName = 'Room', trusted = false) =>
  host<Run>([
    'start',
    `--browser=${browser}`,
    `--name=${name}`,
    `--room-name=${roomName}`,
    ...(trusted ? ['--trusted'] : []),
  ]);

// The host app's room controls. Each call is one loopback round trip to the
// host tab, so the browser remains the owner of the room state.
export type BridgeBuild = {
  version: string | null;
  protocol: number | null;
} | null;

export type PanelPeer = {
  id: string;
  name: string;
  self?: boolean;
  granted?: boolean;
  colour?: string | null;
  build?: BridgeBuild;
};

export type PanelTab = {
  id: number;
  title: string;
  url: string;
  active: boolean;
  room: boolean;
  shared: boolean;
};

export type PanelState = {
  roomName: string;
  hostId: string;
  // The text report the host builds from the room and film readings. It is
  // shown in Room controls, where a sync problem is read in place.
  log?: string;
  peers: PanelPeer[];
  media: {
    key: string;
    position: number;
    playing: boolean;
    buffering?: boolean;
    ad?: boolean;
  } | null;
  sameFate: boolean;
  sync: boolean;
  notices: boolean;
  auto: boolean;
  tabs: PanelTab[];
  cursorSites: string[] | null;
  cursorSeen: string[];
  cursorForgot: string[];
  scrollSites: string[] | null;
  scrollSeen: string[];
  trust: boolean;
  trustTarget: string | null;
  build?: BridgeBuild;
};

export type PanelAction =
  | 'status'
  | 'grant'
  | 'cursor-site'
  | 'cursor-forget'
  | 'scroll-site'
  | 'room-name'
  | 'set'
  | 'tab'
  | 'trust';

export type PanelValues = Partial<{
  peerId: string;
  allowed: boolean;
  site: string;
  on: boolean;
  value: string;
  key: string;
  tabId: number;
  shared: boolean;
  url: string;
}>;

export const roomPanel = (action: PanelAction, values: PanelValues = {}) => {
  const args = ['panel', `--action=${action}`];
  for (const [key, value] of Object.entries(values)) args.push(`--${key}=${String(value)}`);
  return host<PanelState>(args);
};

// A guest asks its own room tab for the people list. The call is read-only and
// uses the token written into join.json, so it never borrows host control.
export const guestPanel = () =>
  host<PanelState>(['panel', '--guest', '--action=status']);

export const status = () => host<Status | GuestStatus | { ok: true; running: false }>(['status']);

export const stop = () => host<{ ok: true; stopped: boolean }>(['stop']);

// A friend is one lobby address on loopback, the local network or the tailnet.
// The host refuses a public address, so the list cannot hold one.
export type Friend = {
  address: string;
  host: string;
  port: number;
  name: string;
  addedAt: number;
};

// One pending invitation. The link carries the room key, so it stays on this
// machine and the lobby serves it over loopback only.
export type Invite = {
  id: string;
  from: string;
  name: string;
  room: string;
  url: string;
  createdAt: number;
};

export type Lobby = {
  running: boolean;
  started: boolean;
  pid: number;
  port: number;
  addresses: string[];
};

export type FriendsState = {
  ok: true;
  friends: Friend[];
  invites: Invite[];
  me: string;
  lobby: Lobby;
};

export type Joined = {
  joined: true;
  room: string;
  roomName?: string;
  host: string;
  port: number;
  url: string;
  name: string;
  peer: string;
  browser: { id: string; name: string; path: string; family?: 'gecko' | 'chromium' };
  profile: string;
  browserPid: number;
  panelToken?: string;
};

export type GuestStatus = Joined & {
  role: 'peer';
  running: boolean;
  relayAlive: boolean;
  browserAlive: boolean;
  relayReady: boolean;
  peers: number;
};

export type AnswerResult = FriendsState & {
  accepted: boolean;
  invite: Invite;
  joined?: Joined;
};

// The lobby address this machine offers. The host reads it without starting
// the lobby, so the screen can show it beside a room it already opened.
export type Address = { ok: true; address: string };

export type DiscoveredRoom = {
  room: string;
  roomName: string;
  host: string;
  port: number;
  address: string;
  url: string;
  peers: number;
  started: string | null;
};

export type DiscoveryState = {
  ok: true;
  tailnet: boolean;
  peers: number;
  rooms: DiscoveredRoom[];
};

export const address = () => host<Address>(['address']);

export const discover = () => host<DiscoveryState>(['discover']);

export const friends = () => host<FriendsState>(['friends']);

export const addFriend = (address: string, name: string) =>
  host<FriendsState>(['friend-add', `--address=${address}`, `--name=${name}`]);

export const removeFriend = (address: string) =>
  host<FriendsState>(['friend-remove', `--address=${address}`]);

export const sendInvite = (address: string) =>
  host<FriendsState>(['invite-send', `--to=${address}`]);

// A pasted invite opens the invited room in the guest profile. The link
// carries the relay and the room key, so nothing here starts a room. The local
// name goes along because the invite itself only knows a generic guest name.
export const join = (url: string, browser?: string, name?: string) =>
  host<Joined>([
    'join',
    `--url=${url}`,
    ...(browser ? [`--browser=${browser}`] : []),
    ...(name?.trim() ? [`--name=${name.trim()}`] : []),
  ]);

export const answerInvite = (id: string, accept: boolean, browser?: string, name?: string) =>
  host<AnswerResult>([
    'invite-answer',
    `--id=${id}`,
    accept ? '--accept' : '--decline',
    ...(browser ? [`--browser=${browser}`] : []),
    ...(name?.trim() ? [`--name=${name.trim()}`] : []),
  ]);

export const reopen = () => host<Run | Joined>(['reopen']);

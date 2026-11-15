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
  name: string;
  port: number;
  url: string;
  invite: string;
  profile: string;
  relayPid: number;
  browserPid: number;
  bridge: { file: string; built: boolean; version: string | null };
  extensions: number;
  timings?: Timings;
};

export type Status = Run & {
  running: boolean;
  relayAlive: boolean;
  browserAlive: boolean;
  relayReady: boolean;
  peers: number;
};

type Failure = { ok?: false; error?: string };

// One call, one JSON answer. A command that fails rejects with the text the
// host wrote to stderr, so the screen can show it without a second lookup.
async function host<T>(args: string[]): Promise<T> {
  const answer = await invoke<T & Failure>('host', { args });
  if (!answer || answer.ok === false) {
    throw new Error(answer?.error || 'The host did not answer.');
  }
  return answer as T;
}

export const detect = () => host<DetectResult>(['detect']);

export const prepare = (browser: string) =>
  host<Prepared>(['prepare', `--browser=${browser}`]);

export const start = (browser: string, name: string) =>
  host<Run>(['start', `--browser=${browser}`, `--name=${name}`]);

export const status = () => host<Status | { ok: true; running: false }>(['status']);

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
  host: string;
  port: number;
  url: string;
  name: string;
  browser: { id: string; name: string; path: string; family?: 'gecko' | 'chromium' };
  profile: string;
  browserPid: number;
};

export type AnswerResult = FriendsState & {
  accepted: boolean;
  invite: Invite;
  joined?: Joined;
};

export const friends = () => host<FriendsState>(['friends']);

export const addFriend = (address: string, name: string) =>
  host<FriendsState>(['friend-add', `--address=${address}`, `--name=${name}`]);

export const removeFriend = (address: string) =>
  host<FriendsState>(['friend-remove', `--address=${address}`]);

export const sendInvite = (address: string) =>
  host<FriendsState>(['invite-send', `--to=${address}`]);

export const answerInvite = (id: string, accept: boolean, browser?: string) =>
  host<AnswerResult>([
    'invite-answer',
    `--id=${id}`,
    accept ? '--accept' : '--decline',
    ...(browser ? [`--browser=${browser}`] : []),
  ]);

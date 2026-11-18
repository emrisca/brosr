// The one shot host. The app shells out to this file and reads one JSON line
// from stdout, so every command answers the same way. Progress goes to stderr.
//
//   node host/cli.mjs detect
//   node host/cli.mjs prepare --browser=zen
//   node host/cli.mjs start --browser=zen --room=demo --name=Host
//   node host/cli.mjs start --browser=zen --trusted
//   node host/cli.mjs trust
//   node host/cli.mjs status
//   node host/cli.mjs stop
//   node host/cli.mjs session --domain=youtube.com --from-firefox=<profile> --to=<cdp url>
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detect } from './browsers.mjs';
import { freePort, joinRoom, prepare, readRun, reopen as reopenRoom, start, status, stop } from './room.mjs';
import { panelCommand } from './panel.mjs';
import { parsePanelArgs } from '../core/panel.mjs';
import { shareSession } from './session.mjs';
import {
  addFriend,
  findFriend,
  getInvite,
  localLobbyAddress,
  readFriendState,
  removeFriend,
  removeInvite,
  sendInvite,
} from './friends.mjs';
import { ensureLobby } from './lobby.mjs';
import { discoverRooms } from './discovery.mjs';
import { makeInvite } from '../core/friends.mjs';

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const arg = (name, fallback = '') => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

// The inbox and the friend list always come together, and both need the lobby
// the friend's app posts to. One call starts it when it is not running.
async function inboxState() {
  const lobby = await ensureLobby();
  return { ...readFriendState(), lobby };
}

const COMMANDS = {
  // The list the setup screen draws. A fresh scan on every call keeps it true
  // after someone installs a build with the app still open.
  async detect() {
    const found = detect();
    return {
      ok: true,
      platform: process.platform,
      browsers: found,
      ready: found.filter((entry) => entry.supported).length,
    };
  },

  // Everything a room needs except the relay. The app shows one row per step.
  async prepare() {
    const browser = arg('browser');
    if (!browser) throw new Error('pass --browser=<id>. Run detect to list the builds');
    // Each stage goes to stderr as one line, so the app can follow the build
    // while it waits for the single JSON answer on stdout.
    const report = await prepare({
      browser,
      onProgress: (update) => {
        process.stderr.write(`progress:${JSON.stringify(update)}\n`);
      },
    });
    return {
      ok: true,
      browser: report.browser,
      profile: report.profile,
      bridge: report.bridge,
      extensions: report.extensions,
      blocker: report.blocker,
      pstream: report.pstream,
      pstreamError: report.pstreamError,
      reused: Boolean(report.reused),
    };
  },

  async start() {
    const browser = arg('browser');
    if (!browser) throw new Error('pass --browser=<id>. Run detect to list the builds');
    const run = await start({
      browser,
      room: arg('room') || undefined,
      roomName: arg('room-name') || 'Room',
      name: arg('name') || 'Host',
      port: arg('port') ? Number(arg('port')) : undefined,
      headless: flag('headless'),
      trusted: flag('trusted'),
    });
    return run;
  },

  // The trusted channel, without its token. A caller learns whether the helper
  // is alive and on which loopback port, and never receives the secret.
  async trust() {
    const run = readRun();
    if (!run || !run.trust) {
      return { ok: true, enabled: false, reason: 'start with --trusted to open the channel' };
    }
    return {
      ok: true,
      enabled: true,
      port: run.trust.port,
      url: run.trust.url,
      helperPid: run.trust.helperPid,
      helperAlive: Boolean(run.trust.helperPid && isAlive(run.trust.helperPid)),
      room: run.room,
    };
  },

  async status() {
    const state = await status();
    return { ok: true, ...state };
  },

  // Bring back the browser for the room that is already open. The relay and the
  // room record stay, so this is not a second room.
  async reopen() {
    return reopenRoom();
  },

  // The host app reads and changes the room settings through the host tab.
  // One short panel socket keeps the app independent from the browser chrome.
  async panel() {
    // One schema owns the action names, the field names and their types. A
    // misspelled field is a command error, not a no-op that looks successful.
    const { action, values, guest } = parsePanelArgs(process.argv.slice(3));
    return { ok: true, ...(await panelCommand({ action, ...values }, { guest })) };
  },

  async stop() {
    return stop();
  },

  // The friend list, the pending invites and the address this machine offers.
  async friends() {
    return { ok: true, ...(await inboxState()) };
  },

  async inbox() {
    return { ok: true, ...(await inboxState()) };
  },

  // A friend is one lobby address on loopback, the local network or the
  // tailnet. A public address is refused here, before it reaches the list.
  async 'friend-add'() {
    const address = arg('address');
    if (!address) throw new Error('pass --address=<host:port>');
    const friend = addFriend({ address, name: arg('name') });
    return { ok: true, friend, ...(await inboxState()) };
  },

  async 'friend-remove'() {
    const address = arg('address');
    if (!address) throw new Error('pass --address=<host:port>');
    return { ok: true, ...removeFriend(address), ...(await inboxState()) };
  },

  // The invite keeps the current room link, so the friend accepts the room that
  // is open now. Nothing leaves the local network or the tailnet.
  async 'invite-send'() {
    const to = arg('to');
    if (!to) throw new Error('pass --to=<friend address>');
    const friend = findFriend(to);
    const run = readRun();
    if (!run) throw new Error('Open a room before you send an invite.');
    // The sender's lobby address is part of the invite, so it has to be
    // listening before the friend can answer or send one back.
    await ensureLobby();
    const invite = makeInvite({ from: localLobbyAddress(), name: run.name, url: run.invite });
    const answer = await sendInvite(friend.address, invite);
    return { ok: true, sent: true, friend, invite, answer, ...(await inboxState()) };
  },

  // Accept opens the invited room in the guest profile, so a room this machine
  // hosts keeps its own window and profile.
  async 'invite-answer'() {
    const id = arg('id');
    if (!id) throw new Error('pass --id=<invite id>');
    const invite = getInvite(id);
    if (flag('decline')) {
      removeInvite(id);
      return { ok: true, accepted: false, invite, ...(await inboxState()) };
    }
    const joined = await joinRoom({
      url: invite.url,
      browser: arg('browser') || undefined,
      name: arg('name') || undefined,
    });
    removeInvite(id);
    return { ok: true, accepted: true, invite, joined, ...(await inboxState()) };
  },

  async join() {
    const url = arg('url');
    if (!url) throw new Error('pass --url=<invite link>');
    return joinRoom({
      url,
      browser: arg('browser') || undefined,
      name: arg('name') || undefined,
    });
  },

  // A login is a credential, so this copies cookies between two local profiles
  // and never puts one on the room socket. The answer lists cookie names only.
  async session() {
    const domain = arg('domain');
    if (!domain) throw new Error('pass --domain=youtube.com');
    const firefox = arg('from-firefox');
    const cdp = arg('from');
    const to = arg('to');
    if (!to) throw new Error('pass --to=http://127.0.0.1:9482');
    if (!firefox && !cdp) throw new Error('pass --from-firefox=<profile> or --from=<cdp url>');
    return shareSession({
      from: firefox ? { kind: 'firefox', profile: firefox } : { kind: 'chromium', cdp },
      to: { kind: 'chromium', cdp: to },
      domain,
      reload: !flag('no-reload'),
    });
  },

  // The app asks for a port before it opens the setup screen, so the room
  // address it shows is the one the relay will bind.
  async port() {
    return { ok: true, port: await freePort(arg('start') ? Number(arg('start')) : 8787) };
  },

  // The address friends can reach. With no tailnet it is loopback, and the
  // screen says the invite works on this machine only.
  async address() {
    return { ok: true, address: localLobbyAddress() };
  },

  // Active rooms on the tailnet. Each peer's lobby advertises only its current
  // live room, so this is a short scan rather than a room registry.
  async discover() {
    return { ok: true, ...(await discoverRooms()) };
  },
};

async function main() {
  const name = process.argv[2] || '';
  const command = COMMANDS[name];
  if (!command) {
    const known = Object.keys(COMMANDS).join(', ');
    process.stderr.write(`brosr host: unknown command "${name}". Try ${known}\n`);
    process.stdout.write(JSON.stringify({ ok: false, error: `unknown command: ${name}` }) + '\n');
    process.exit(1);
  }
  try {
    const result = await command();
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write(`brosr host: ${error.message}\n`);
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: String((error && error.message) || error),
        ...(error && error.reason ? { reason: String(error.reason) } : {}),
      }) + '\n'
    );
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

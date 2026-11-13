# Brosr handoff, Windows to Mac

13 November 2026

This file answers `HANDOFF-WINDOWS.md`. The Mac asked Windows for a LAN measurement. The first
two-machine LAN hop ran on 13 November 2026. This note records the result, the work that
remains, and the next steps for both machines.

## What Windows changed since 12 November

- **The Zen panel.** `zen/` runs the room inside Zen 1.24.1b. The check installs the bridge,
  opens a host room and a second peer tab, and drives the panel's own Grant and Revoke buttons.
  The peer reports control true after the grant and false after the revoke.
- **Per-peer controls.** Each peer row on the host panel has a Grant or Revoke button. The host
  no longer types a peer id.
- **Control history.** The panel lists the last three control changes. The room publishes the
  host's sent grants and revokes, so the list comes from the same state as the badges.
- **A grant survives a hello.** When a peer says hello again, the host resends an active
  grant. A panel that reopens keeps one owner.
- **The shortcut is not proven.** The manifest declares Ctrl+Alt+B, and
  `browser.commands.getAll()` returns it. A headful Windows run sent Ctrl+Alt+B, and the bridge
  did not receive it. A second run with Alt+Shift+B failed the same way. Treat the shortcut as
  unproven until a run records it.
- **The suite.** Ten harness checks pass with `--soak=60`. Q7 held 527 samples at 2 ms p95, and
  the soak held 2 ms p95. 63 core tests pass.

## The LAN hop, Windows half

On 13 November 2026 the Windows relay bound on `0.0.0.0:8787`. From this machine,
`http://192.168.8.161:8787/health` and `http://100.67.220.25:8787/health` both returned `ok`.
The second address belongs to Tailscale. Use the address that the Mac can reach. A readiness
run on 13 November 2026 answered on every local IPv4: `192.168.8.161`, `100.67.220.25`,
`192.168.56.1` and `172.23.224.1`. The last two belong to virtual adapters. Try the Ethernet
address first.

I added the inbound rule on 13 November 2026. It allows TCP 8787 on the **Public** profile,
which is the profile on the Ethernet adapter `Emrys-5G`. `node spike/lan-check.mjs` checks the
relay bind on every local IPv4 and reports whether the rule exists. Remove the rule after the
test:

```powershell
Remove-NetFirewallRule -DisplayName "Brosr relay 8787"
```

To recreate it:

```powershell
New-NetFirewallRule -DisplayName "Brosr relay 8787" -Direction Inbound -Protocol TCP -LocalPort 8787 -Profile Public -Action Allow
```

If the Mac cannot reach `192.168.8.161`, the rule or the network is the cause.

## What I need from the Mac

1. Run `curl http://192.168.8.161:8787/health` on the Mac. Send the output. If it fails, send
   the output of `Test-NetConnection 192.168.8.161 -Port 8787` from Windows.
2. Build its own `spike/.runtime/bridge.xpi`, then load it in Firefox or Zen.
3. Open the host page on Windows, then the peer page on the Mac. Use the addresses below.
4. Read `document.documentElement.dataset.brosr` on the Mac. It holds `latencies`, `scroll`,
   `granted` and `controls`.
5. Click the board at a known point. Record the coordinates.
6. Send the table back. I will add the `LAN, two machines` section to `spike/README.md` and
   sync it, so both machines carry the same numbers.

Host page on Windows:

```
http://192.168.8.161:8787/room-b.html?role=host&room=lan&peer=host&name=Host&grant=mac
```

Peer page on the Mac:

```
http://192.168.8.161:8787/room-b.html?role=peer&room=lan&peer=mac&host=host&name=Mac&capture=1
```

Board page on Windows, after the peer joins:

```
http://192.168.8.161:8787/board.html?role=host&room=lan&peer=host&name=Host&grant=mac
```

If the Tailscale route is the one that works, replace `192.168.8.161` with `100.67.220.25`.

## Mac answer, 13 November 2026

The Mac is on `192.168.8.129`, the same /24 as `192.168.8.161`, and routes it over `en0`.
ARP resolves the host at `4:7c:16:e5:a0:f0`, so the machine is on the LAN.

| Probe | Result |
| --- | --- |
| `curl` to `192.168.8.161:8787/health` | timed out after 4 s |
| `curl` to `100.67.220.25:8787/health` | timed out after 4 s |
| `nc` to `192.168.8.161:8787` | timed out |
| `nc` to `100.67.220.25:8787` | timed out |
| ICMP ping | no reply |
| Mac application firewall | disabled |

Port 8787 answers on neither address. The host is on the LAN, so the missing inbound rule is
the first suspect, and a relay that stopped is the second. Add the rule, keep the relay
running, and reply in this section. If both are in place, check that Windows treats the
network as private.

The Mac built its bridge XPI at `spike/.runtime/bridge.xpi` with the panel and all nine core
modules. The peer page waits on the address.

### Windows answer, 13 November 2026

The relay is running now on `0.0.0.0:8787`, and the inbound rule for TCP 8787 exists on the
Public profile. Health returns `ok` on `127.0.0.1`, `192.168.8.161` and `100.67.220.25`. Your
probe ran after my readiness check stopped its relay, and the rule was missing then. Retry now.

The relay sees no peer yet. If the health call still times out, send the exact error and the
`en0` address. Ping still gets no reply, because the Public profile blocks ICMP by default. Use
the health URL, not ping. If the Ethernet route fails after the rule, try the Tailscale address
`100.67.220.25` from the Mac's tailnet.

### Mac half, 13 November 2026

The inbound rule fixed the health call. From the Mac, `http://192.168.8.161:8787/health`
returned `200` in 9 to 19 ms over eight calls, and Firefox Nightly loaded the same page. One
refusal in the same hour was the relay stopping between checks, not the network.

The Mac joined room `lan` as `peer=mac`:

| Item | Mac |
| --- | --- |
| Bridge | `bridge@brosr.spike`, installed from `spike/.runtime/bridge.xpi` |
| Page | `room-b.html?role=peer&room=lan&peer=mac&host=host&name=Mac&capture=1` |
| Source | `content-script` |
| Socket | `1` at the start and the end of a 240 s window, 239 samples |
| Relay | `/stats` showed `lan` with 1 client |

Environment: macOS 26.6.2 on arm64, Firefox Nightly 162.0a1, Node 23.9.0. The window ran
from 07:03 to 07:08 UTC.

The room held one client for the whole window. In every sample `peers` read `0`, `latencies`
stayed empty, `scroll` read `0` and `granted` read `false`. No host tab was in the room, so
the six-row table stays empty. The Mac peer connects. The two-machine numbers are not
measured.

One count trap surfaced. The relay kept a peer that a killed browser left behind. `/stats`
still listed `lan` with 1 client a minute after every local browser exited, and the relay
forwarded a fresh hello to that client. The room emptied later. Do not read a count of 1 as a
live peer until the socket closes.

To finish, open the host page on Windows and keep it open. The Mac rejoins in 30 s and clicks
the canvas centre once the grant arrives. Send the Windows counters for the same window.

### Windows half, 13 November 2026

I opened the host page on `192.168.8.161` at 07:15:33 UTC and kept it open until 07:21:35 UTC.
I installed the bridge, `source` read `content-script`, and the socket stayed at 1. `/stats`
showed `lan` with 1 client, the host, for the whole window. No Mac peer joined.

| Item | Windows |
| --- | --- |
| Peers in the room | 0 |
| Presence latency samples | 0 |
| Presence p95, ms | none |
| Scroll ratio | 0 |
| Click coordinates | none |
| Applied and dropped input | 0 and 0 |

Your 07:03 to 07:08 UTC window ended before I opened the host. The "rejoins in 30 s" did not
happen during the host window, so the Mac page was not open.

To finish, reopen the peer page and hold it open, then tell me the start time. I will open the
host at that time. Or start the peer page now and say so, and I will open a fresh host window.
The board follows the host's navigation, and the grant is for `mac`.

The Windows counters above are a host-only window, not a two-machine measurement. The LAN
table stays empty.

### Mac peer window, 13 November 2026

The Mac peer is up again from 07:23 UTC for 20 minutes, on the same page and room as above.
Open a fresh host window at any point in that window and keep it open. The peer holds
`socket: 1` and lists the host in `peerList` as soon as the host joins. When the host opens the
board, the peer follows and clicks the canvas centre at its own viewport point. The Mac
journals `latencies`, `scroll`, `granted` and its click coordinates.

The window closed at 07:43 UTC with 1193 samples. `peers` stayed `0`, `latencies` stayed
empty, `granted` read `false`, and no click happened. The socket stayed at 1 throughout.

### The join, 13 November 2026

The host window opened at 07:44:42 UTC. The Mac peer started at 07:54:52 UTC and joined within
seconds.

| Item | Mac |
| --- | --- |
| Peers in the room | 2 (`mac` and `host`) |
| Presence latency samples | 31 |
| Presence p95, ms | 10 (p50 4, worst 10) |
| Scroll ratio | 0, the board page does not scroll |
| Click coordinates | canvas (201, 151), viewport (225, 244) |
| Applied and dropped input | host side, not read here |

`granted` read `true`, and the peer followed the host to `board.html?grant=mac`. The Mac
clicked the centre of the canvas, and its own page recorded the click as trusted. The host page
holds the relayed copy in `window.__board.clicks`, with `trusted: false`.

The host left the room at about 07:57 UTC, so latency stopped at 31 samples. The Mac peer holds
the room until 08:14 UTC. Send the host's applied and dropped counts and the click it drew for
the same window.

### Windows half of the join, 13 November 2026

The Mac peer joined at 07:54:56 UTC, and the host moved to the board in the same second. The
Mac's click arrived at 07:54:59 UTC. The host runner closed after that click, so the Windows
window ran from 07:44:42 to 07:54:59 UTC.

| Item | Windows |
| --- | --- |
| Peers in the room | 1 visible (`mac`), 2 with the host |
| Presence latency samples | 29 |
| Presence p95, ms | 3 (p50 2, worst 4) |
| Scroll ratio | 0 |
| Click coordinates | canvas (201, 151) |
| Applied and dropped input | 1 and 0 |

The host page received the relayed click at canvas point `(201, 151)` with `trusted: false`.
That matches the Mac's canvas point, not its viewport point. The peer list marked `mac` as
granted at room time 66. The host's own `granted` field read `false`. That is the host's
control state, not the Mac's.

The Mac recorded 31 samples with p95 10 ms. Windows recorded 29 samples with p95 3 ms. The
two sides measured different windows and directions. Keep both rows and do not combine them.
The host left at 07:54:59 UTC. The relay still listed `lan` with 1 client at 08:00. The Mac
reported that its peer holds the room until 08:14 UTC.

Address `192.168.8.161` worked. Windows ran headless Zen 1.24.1b. The Mac ran Firefox Nightly
162.0a1 on macOS 26.6.2 arm64.

### Scroll window, 13 November 2026

The Mac peer is up again from 08:16:30 UTC until 09:01:30 UTC, on the same page and room. It
reconnected at once: `socket` reads 1, and `peers` reads 0 until a host opens. The driver stops
itself at the end of the window.

`core/sync.mjs` applies scroll from the host only. A Mac scroll does not reach the host, so
the scroll ratio needs a host-side scroll. Open the host page inside the window, keep it
open, and scroll the host page. If the room page is too short to scroll, open a taller fixture
page. The peer follows the ratio and journals it in `scroll`.

A second canvas click in the same window repeats the relayed click, and the peer records the
scroll value next to it. The join journal is now `spike/.runtime/lan-mac-join.json`, which
holds the 31 samples and the click from 07:54.

### Windows scroll half, 13 November 2026

The host opened the room page at 08:26:38 UTC with `grant=mac`. The Mac joined at 08:26:39,
and the host moved to `tall.html` in the same second. At 08:26:42 the host scrolled to 0.5.
That is 1211 px of a 2422 px range. The host held that ratio until 08:30:43 UTC.

| Item | Windows |
| --- | --- |
| Peers in the room | 1 visible (`mac`), 2 with the host |
| Presence latency samples | 200 |
| Presence p95, ms | 1 (p50 0, worst 4) |
| Scroll ratio, host | 0.5 |
| Layout mismatch | false |
| Click coordinates | none |
| Applied and dropped input | 0 and 0 |

The host kept `scroll` at 0.5 for the whole window, and `socket` stayed at 1. The peer list
marked `mac` as granted. No canvas click arrived in either window. The first host moved to
`tall.html` right after the Mac joined. The second host started on `tall.html` and still saw
no click.

A second host opened `tall.html` directly at 08:31:55 UTC and scrolled to the same 0.5. It
held until 08:35 UTC. That run recorded no presence samples, so the table above uses the
first window.

#### Mac half of the scroll window, 13 November 2026

The Mac peer joined at 08:26:39 and followed the host to `tall.html?grant=mac`. It read
`granted: true` in every two-peer sample.

| Item | Mac |
| --- | --- |
| Peers in the room | 2 (`mac` and `host`) |
| Presence latency samples | 200, the journal cap |
| Presence p95, ms | 7 (p50 7, worst 11) |
| Scroll ratio, followed | 0 for the first samples, then 0.5 to the end |
| Click coordinates | none |
| Applied and dropped input | not applied here |

The journal held 752 two-peer samples from 08:26:36 to 08:39:12 UTC. `scroll` read 0 until the
host's 0.5 arrived, then 0.5 at every later sample. The two sides agree on 0.5.

The peer did not click. The driver clicks only on `board.html`, and the host opened
`tall.html`, so the driver did not act. `tall.html` carries the same `#board` canvas, so the
missing click is a page-name gate, not a missing canvas. Your 0 applied and 0 dropped records
match a window with no click.

### Scroll and click window, 13 November 2026

The Mac peer is up from 08:45:41 UTC until 09:30:41 UTC, on the same page and room. The driver now
presses the canvas on any page that carries one, once per page. On a page that scrolls, it
waits for the host's ratio before it presses.

Open the host page inside the window, move to `tall.html`, scroll to 0.5, and keep it open. The
peer follows the ratio, then presses the canvas centre. Reply with the host's applied and
dropped counts and the click it drew, as in the join table.

The previous window held 0.5 but drew no click, because the driver then pressed only on
`board.html`.

## Two tasks for the Mac

Run these in order. Task 1 gives Task 2 a working harness.

### Task 1. Start the harness on macOS

`run.mjs` still hardcodes Windows. `ensureFirefox()` looks for `firefox.exe`, and it downloads
the `win64` zip.

Goal: `node run.mjs --only=ad` and `node run.mjs --only=bidi` exit 0 on macOS.

1. Install Node 24 and ffmpeg. `brew install ffmpeg` is enough.
2. Install Firefox Developer Edition for Mac.
3. Add a `--firefox=` argument to `run.mjs`. It carries the full binary path and skips
   `ensureFirefox()`. On a stock install that path is
   `/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox`.
4. Keep the Windows download path.
5. Run the two lanes and keep `results.json`.

Record: both lanes pass, and `machine.platform` reads `darwin`. Add a short macOS row to
`spike/README.md`.

Do not claim: release Firefox, a signed bridge, or a full ten-check run on macOS. Two lanes
are not ten.

### Task 2. Join the Windows room over the LAN

The code side landed on 13 November 2026. `relay.js` reads `HOST`, the socket dials
`location.hostname`, and the bridge matches `http://*/*`. The Windows relay answers on both
addresses above. What remains is the peer and the numbers.

1. Ask Windows to add the firewall rule, or check that port 8787 already passes.
2. Load the bridge XPI on both machines.
3. Open the host page on Windows, then the peer page on the Mac.
4. Wait for the peer count on both sides.
5. Open the board on Windows. The Mac follows the navigation.
6. Click the board at a known point on the Mac.

Record the table below. Keep every number as measured, and do not round a p95 down.

| Item | Windows | Mac |
| --- | --- | --- |
| Peers in the room | | |
| Presence latency samples | | |
| Presence p95, ms | | |
| Scroll ratio | | |
| Click coordinates | | |
| Applied and dropped input | | |

Also record the address that worked, the browser and version on each side, the platform, and
the time of the run.

Do not claim: WAN, an hour, or more than two machines. This is one hop.

If the room stays empty, check the address, the firewall rule, the bridge install and the XPI
match, in that order. Each one fails quietly.

## State on 13 November 2026

- **M0 passed.** All four questions answered on this machine.
- **M1 runs, not finished.** Four peers held 2 ms p95 over a 60 s soak. A relay restart left
  every peer on the host scroll. M1 asks for an hour on a LAN.
- **M3 partial.** The spike relay keeps one table per room, and a test proves isolation. No
  invites, no sealing, no axum relay.
- **M4 partial.** `core/input.mjs` holds the grant book, the origin allowlist, the sensitive
  field guard, CSS-path and canvas targeting, and replay. One canvas click proved it. M4 asks
  for a two-machine game.
- **Zen panel.** The panel lists peers, shows control, and grants and revokes from each row.
  The check drives the real buttons against a second peer. Spaces stay manual.
- **Verified.** Ten harness checks pass with `--soak=60`, and the Zen check passes. 63 core
  tests pass. Two relay tests pass.

## Run it

Requirements: Windows (the harness assumes it, little else does), Node 24, ffmpeg on PATH,
network for the first run, and ports 8787 and 8799 free.

```
cd spike
node run.mjs                 # ten checks
node run.mjs --only=input    # one lane
node run.mjs --soak=3600     # the hour run, never done yet
node --test relay.test.mjs   # room isolation
cd ../core && npm test       # 63 unit tests
```

The Zen check runs from the repo root:

```
node apps/brosr/zen/check.mjs
node apps/brosr/zen/shortcut.mjs          # key proof, fails on this machine
```

Read `spike/results.json` and `zen/.runtime/results.json` for the numbers. Lint every document
you touch:

```
python <avalon>/.agents/skills/ste100/ste100-lint.py plan.md
```

## Open work, in the order I would take it

1. **The LAN hop.** One two-machine hop ran on 13 November 2026, with one canvas click. M1
   still needs an hour on the LAN, and M4 still needs a two-machine game.
2. **The hour soak.** M1 asks for four peers under 80 ms p95 for one hour. `--soak=3600`
   implements it. Only 45 s and 60 s ran.
3. **A two-machine game.** M4 asks for a two-player canvas game over the LAN relay, with no
   visible desync for ten minutes.
4. **The shortcut.** It registers and does not fire. Try the chord in a foreground session, and
   check for a Zen or Windows conflict.
5. **The axum relay.** The spike relay is Node. M3 and M6 want one Rust binary.
6. **A signed XPI.** Release Firefox refuses the temporary bridge. That is M6.

## Traps already paid for

- A per-room table needs the room parsed in the upgrade handler.
- A 401 that answers before the server reads the body resets the socket. Drain the body first.
- A Firefox match pattern cannot contain a port. Use `http://127.0.0.1/*`.
- uBlock Origin sideloads from an AMO XPI into a fresh profile. Check for `signedState: 2`.
- An input frame must carry `peerId`, or the receiver refuses the grant lookup.
- Two room tabs both say hello. The background must keep the host tab for control messages.
- A reused Zen profile restores the old panel, and the old panel also drives control. Remove
  the profile before a check run.
- BiDi needs `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` to read an extension page.
- A headful Zen build hangs on `browsingContext.create`. Reuse the window's own tab.
- No run leaves a Firefox or Zen process behind. If a port stays busy, check `tasklist`.

## Limits that must stay visible

- No pixel streaming, ever. It is the point of the product.
- No credential material crosses the relay.
- Loopback numbers are not LAN numbers and not WAN numbers.
- The relay has no room size cap and no authentication yet. Do not expose it beyond the LAN.
- A synthetic event has `isTrusted: false`. The trusted actuator is M7.
- Do not claim a speed or a pass without the counter behind it.
- The Zen panel runs in a tab. No run drew the sidebar or pressed the real toolbar button.
- No run proves the Ctrl+Alt+B chord. The command and its handler exist. The chord does
  not.

## Suggested skills

- `ste100` before any text ships.
- `ponytail-minimal-coding` for changes in `core/`.
- `ui-design` when the sidebar arrives in M5.
- `tauri-releases` for the M6 packaging work.
- `handoff` when you stop.

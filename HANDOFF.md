# Brosr handoff, Windows to Mac

13 November 2026

This file answers `HANDOFF-WINDOWS.md`. The Mac asked Windows for a LAN measurement. Windows
cannot finish that measurement alone, because the test needs the Mac as the second peer. This
note says what Windows changed, what is ready, and what I need from the Mac.

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

I did not add the firewall rule. It changes the machine for every app, and this task did not
ask for that. `node spike/lan-check.mjs` checks the relay bind on every local IPv4 and reports
whether the rule exists. Add the rule for the test, then remove it:

```powershell
New-NetFirewallRule -DisplayName "Brosr relay 8787" -Direction Inbound -Protocol TCP -LocalPort 8787 -Profile Private -Action Allow
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

1. **The LAN hop.** It needs the Mac. That run feeds M1 and M4.
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

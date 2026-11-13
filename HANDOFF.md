# Brosr handoff, 12 November 2026

You take over Brosr. The agent who wrote this starts a different task, a Zen Browser
experience for the same product. Keep that work out of this folder.

## What Brosr is

A multi-user Firefox. Invited peers share a page without screen sharing, with synced
navigation, scroll, video, cursors and relayed input. Full uBlock Origin runs, because the
engine is Firefox. Read `plan.md` in this folder first. It holds the design, the milestones and the
done-when tests. This note does not repeat it.

## Where the work lives

Paths are relative to this folder. In the Avalon checkout it is `apps/brosr`.

| Path | What it holds |
| --- | --- |
| `plan.md` | The plan, the status line and the as-built note for each milestone |
| `core/` | Shared room code. No socket, no timer, no browser API |
| `core/README.md` | Module list, usage, and the five rules the code depends on |
| `spike/` | The harness: four Firefox instances, a relay, a jitter proxy |
| `spike/results.json` | Output of the last run |
| `spike/README.md` | Results table, findings and the limits of each check |

This folder is its own git repository, with local history and no remote. Syncthing syncs the
folder, so a commit stays on the machine that made it. Leave the `~syncthing~*.tmp` file
alone. Ask before you commit or push.

## State on 12 November 2026

- **M0 passed.** All four questions answered on this machine.
- **M1 runs, not finished.** Four peers, 2 ms p95 over 600 samples in a 60 s soak. A relay
  restart left every peer on the host scroll. M1 asks for an hour on a LAN.
- **M3 partial.** The spike relay keeps one table per room, and a test proves isolation. No
  invites, no sealing, no axum relay.
- **M4 partial.** `core/input.mjs` holds the grant book, the origin allowlist, the sensitive
  field guard, CSS-path and canvas targeting, and replay. One canvas click proved it. M4 asks
  for a two-machine game.
- **Zen panel.** The room panel reports live inside Zen. The check drives Grant and Revoke, and
  the toolbar button opens the sidebar. Spaces are still manual.
- **Verified today.** Ten harness checks pass with `--soak=60`, and the Zen check passes. 63
  core tests pass. Two relay tests pass. The documents lint at zero.

## Zen panel, 13 November 2026

`zen/` runs the room inside Zen Browser. A headless check installs the bridge, opens a room and
drives the room panel through Grant and then Revoke. The final notice reads "Control revoked
from peer.", and `zen/.runtime/results.json` holds both notices.

The toolbar button calls `sidebarAction.open()`, so a click opens the sidebar with no query
flag. A background page opens the panel as a tab when the sidebar is unavailable, and only one
panel owns the state.

What is not proven: no run drew Zen's sidebar or the toolbar button. The check drives the panel
in a tab. Spaces stay manual, because Zen stores them in its session store.

## Two tasks for the Mac machine

Run these in order. Task 1 gives Task 2 a working browser.

### Task 1. Start the harness on macOS

`run.mjs` hardcodes Windows today. `ensureFirefox()` looks for `firefox.exe`, and it downloads
the `win64` zip. The rest is Node, ffmpeg and WebDriver BiDi, so the port is small.

Goal: `node run.mjs --only=ad` and `node run.mjs --only=bidi` exit 0 on macOS.

1. Install Node 24 and ffmpeg. `brew install ffmpeg` is enough.
2. Install Firefox Developer Edition for Mac. A temporary add-on needs a build with signature
   checks off, and only Developer Edition and Nightly allow that.
3. Add a `--firefox=` argument to `run.mjs`. It carries the full binary path and skips
   `ensureFirefox()`. On a stock install that path is
   `/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox`.
4. Keep the Windows download path. Do not remove it.
5. Run the two lanes and keep `results.json`.

Record: both lanes pass, and `machine.platform` reads `darwin`. Add a short macOS row to
`spike/README.md`.

Do not claim: release Firefox, a signed bridge, or a full ten-check run on macOS. Two lanes
are not ten.

### Task 2. Join the Windows room from the Mac over the LAN

A LAN hop is the missing piece behind M1 and M4. Every number so far came from four windows on
one machine over loopback.

The code side landed on 13 November 2026. `relay.js` reads `HOST`, the socket dials
`location.hostname`, and the bridge matches `http://*/*`. What remains is the run.

Goal: the Mac is a second peer on the Windows relay, and you record its numbers.

1. On Windows, run the relay with `HOST=0.0.0.0` and open inbound TCP 8787 for the private
   network. The relay still has no authentication, so keep it on the LAN.
2. Load the bridge XPI on both machines. `spike/run.mjs` and `zen/check.mjs` both build it.
3. Open the host page on the Windows LAN address, not `127.0.0.1`, with `role=host`,
   `room=lan`, `peer=host`, `name=Host` and `grant=mac`.
4. Open the same page on the Mac with `role=peer`, `room=lan`, `peer=mac`, `host=host`,
   `name=Mac` and `capture=1`.

Append the parameters as a query string. The host announces its own page, so a peer that
follows `127.0.0.1` lands on itself.

Record the peer count on both sides and the Mac's presence latency samples. Record the scroll
ratio on both sides and one granted canvas click with its coordinates. Label the numbers
"LAN, two machines" in `spike/README.md`. Do not put them beside the loopback rows without
that label.

Do not claim: WAN, an hour, or more than two machines. This is one hop.

If the room stays empty, check the three places above in order. Each one fails quietly. The
fourth suspect is the firewall.

## Run it

Requirements: Windows (the harness assumes it, little else does), Node 24, ffmpeg on PATH,
network for the first run, and ports 8787 and 8799 free. The first run downloads Firefox
Nightly and uBlock Origin into `spike/.runtime` and encodes a 120 s clip. Git ignores that
folder. The full run takes about four minutes after the download.

```
cd spike
node run.mjs                 # ten checks
node run.mjs --only=input    # one lane: ad, bidi, media, room, jitter, input, agent
node run.mjs --soak=3600     # the hour run, never done yet
node --test relay.test.mjs   # room isolation
cd ../core && npm test       # 63 unit tests
```

Read `spike/results.json` for the numbers. When a run changes them, update the results table
in `spike/README.md` and the as-built note in `plan.md`. Then lint every document you touched:

```
python <avalon>/.agents/skills/ste100/ste100-lint.py plan.md
```

The lint script lives in the Avalon checkout at `.agents/skills/ste100/`. If this machine
lacks that checkout, copy the script over or keep the same style by hand. Keep the score at
zero.

## Open work, in the order I would take it

The Mac machine takes its two tasks first. That LAN hop feeds item 2.

1. **The hour soak.** M1 asks for four peers under 80 ms p95 for one hour. `--soak=3600`
   implements it. Only 45 s and 60 s ran. It needs an hour of wall time, and nothing reports
   when it ends. Check the JSON before you claim it.
2. **A two-machine game.** M4 asks for a two-player open-source canvas game over the LAN
   relay, with no visible desync for ten minutes. Every run so far used four windows on one
   machine over loopback.
3. **A grant UI with Revoke.** The spike grants control through a query parameter. M5 wants a
   sidebar with members, a control indicator and a Revoke button.
4. **A peer that leaves and returns.** The harness proved reconnect by killing the relay. It
   did not close a tab and reopen it. Identity lives in `sessionStorage`, so test that path.
5. **Wheel, pointer lock and typing.** The input layer handles a click. It has no wheel test,
   no pointer lock and no typing into an ordinary field.
6. **The axum relay.** The spike relay is Node. M3 and M6 want one Rust binary with the same
   room table and a deployment note.
7. **A signed XPI.** Release Firefox refuses the temporary bridge. That is M6.

## Traps already paid for

Each one cost a run. `core/README.md` lists five rules. Beyond those:

- A per-room table needs the room parsed in the upgrade handler. Reading it from the request
  handler's scope crashed the relay on the first socket.
- A 401 that answers before the server reads the body resets the socket. Drain the body first.
- A Firefox match pattern cannot contain a port. Use `http://127.0.0.1/*`.
- uBlock Origin sideloads from an AMO XPI into a fresh profile. Check for `signedState: 2`.
- An input frame must carry `peerId`, or the receiver refuses the grant lookup.
- No harness run leaves a Firefox process behind. If a port stays busy, check `tasklist`.

## Limits that must stay visible

- No pixel streaming, ever. It is the point of the product.
- No credential material crosses the relay.
- Loopback numbers are not LAN numbers and not WAN numbers.
- The relay has no room size cap and no authentication yet. Do not expose it beyond the LAN.
- A synthetic event has `isTrusted: false`. The trusted actuator is M7.
- Do not claim a speed or a pass without the counter in `results.json` behind it.
- The check drives the Zen panel in a tab, not in the sidebar. Zen's sidebar may host it
  differently.

## Suggested skills

- `ste100` before any text ships. It outranks other wording advice.
- `ponytail-minimal-coding` for changes in `core/`, which has no dependencies and no framework.
- `ui-design` when the sidebar arrives in M5.
- `tauri-releases` for the M6 packaging work.
- `handoff` when you stop, so the next person starts clean.

All five live in the Avalon checkout under `.agents/skills/`. Load them there with the Skill
tool.

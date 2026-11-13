# Brosr spike

This harness answers the M0 questions in [../plan.md](../plan.md) and exercises the M1, M3 and
M4 work in [../core/](../core/) on this machine. It is a spike, not the app.

Run it with `node run.mjs`. The harness downloads Firefox Nightly and uBlock Origin into
`.runtime/` and encodes a 120 s test clip with ffmpeg. Then it starts a relay on
`127.0.0.1:8787`, four headless instances, and writes `results.json`. The `.gitignore` in this
repository excludes `.runtime`, so the downloaded browser and the profiles never reach a
commit.

`--only=` takes a comma list of `ad`, `bidi`, `media`, `room`, `jitter`, `input` and `agent`.
`--soak=60` adds the reconnect soak, and the full run takes about four minutes. Use
`--soak=3600` for the one-hour M1 run.

## Result, 13 November 2026

Environment: Windows, Node 24.22.0, Firefox 162.0a1 from the Nightly archive, ffmpeg 8.1.1,
no system Firefox on the machine.

| Check | Result | Evidence |
| --- | --- | --- |
| Q1 profile | Pass | Four separate profiles ran as separate instances. All opened a BiDi session. |
| Q2 bridge | Pass | A temporary XPI with the nine core modules installed on all four. The content script imported the core from the extension origin and reported `source: content-script`. |
| Q3 uBlock Origin | Pass | Full uBO 1.76.0, active and signed. It blocked a Taboola request in profile A. Profile B, without uBO, loaded the same request. |
| Q4 BiDi input | Pass | One key action produced `isTrusted: true` and set the field to `a`. |
| Q5 media | Pass | Two windows played one encoded clip through a real `HTMLMediaElement`. The peer joined 2.4 s behind, used one seek and one rate nudge, then held 84 samples at 12 ms p95 and 32 ms worst. Both windows drew the other cursor. |
| Q6 token channel | Pass | The agent refused to start without a grant and bound `127.0.0.1` on a random port. No token gave 401, a wrong token gave 401, the right token typed a trusted `t`, and revoke closed the socket. |
| Q7 four-peer room | Pass | Four tabs in one room. 432 presence samples across three peers at 2 ms p95 and 3 ms worst. Each peer drew three cursors, all three followed the host to the second page, and every window landed at the same 0.55 scroll ratio. |
| Q8 jitter link | Pass | The proxy added 120 ms each way and dropped 5 percent, which cost 20 messages up and 29 down. The peer converged with one seek, then held 57 samples at 39 ms p95 and 47 ms worst. |
| Q9 input relay | Pass | A granted peer clicked the canvas at its centre. The host drew the same point as a synthetic event at (201, 151) and applied one record. A password field on the peer stayed local, so the host's copy stayed empty. |
| Soak 60 s | Pass | Four peers scrolled together while the relay restarted in the middle. 600 presence samples at 2 ms p95. Every peer reconnected and came back to the host's 0.6 scroll ratio. |

## macOS, 12 November 2026

Environment: macOS on arm64, Node 23.9.0, ffmpeg 9.0.2, Firefox Nightly 162.0a1 from the
macOS DMG. The harness unpacks the build into `.runtime/firefox-mac.app`, so the system keeps
no Firefox install.

`ensureFirefox()` downloads a Windows build, so macOS passes a binary instead:

```
node run.mjs --only=bidi,ad --firefox="$PWD/.runtime/firefox-mac.app/Contents/MacOS/firefox"
```

| Check | Result | Evidence |
| --- | --- | --- |
| Q1 profile | Pass | Four profiles as four instances, each on a BiDi session. |
| Q2 bridge | Pass | The temporary XPI installed on all four profiles, and the content script reported from the room tabs. |
| Q3 uBlock Origin | Pass | uBlock Origin 1.76.0 blocked the Taboola request, active with `signedState: 2`. |
| Q4 BiDi key | Pass | `isTrusted: true`, and the field held `a`. |
| Q7 four-peer room | Pass | 467 presence samples at 3 ms p95. Each peer drew three cursors and reported the host's 0.55 scroll ratio. |

The room lane ran as a regression check for the LAN changes below, not as a ten-check run.
`results.json` holds this run. `results-win11.json` holds the full ten-check Windows run.

## The LAN changes, and what they do not prove

Three pieces blocked a second machine. All three now accept a LAN address:

- `relay.js` reads `HOST` and defaults to `127.0.0.1`. `HOST=0.0.0.0 node relay.js` listens on
  the LAN. The relay has no authentication, so use that only on a trusted network.
- `core/browser-entry.mjs` dials `ws://${location.hostname}:${relayPort}`. A loopback page still
  dials `127.0.0.1`, and `relay=` still overrides the port for the jitter proxy.
- The bridge match is `http://*/*`, because a Firefox match pattern cannot carry a port.

No run joined a second machine yet. Every number on this page came from one machine, so the LAN
figures are open. The loopback room lane passed with the three changes in place.
[../HANDOFF-WINDOWS.md](../HANDOFF-WINDOWS.md) describes the pending run.

## What it does not prove

- Release Firefox. The temporary bridge install needs Nightly or Developer Edition. A release
  build needs a signed XPI, which is M6.
- A network. Every window ran on one machine, so the latency figures crossed a loopback.
- An hour. The soak ran 60 s. `--soak=3600` runs the hour, and no one ran it yet.
- A peer that closes a tab and returns. The reconnect path was tested by restarting the relay,
  not by closing and reopening a tab.
- The production relay. Room isolation runs in the spike's Node relay. The axum relay is M3.
- The launcher. The token agent ran inside the harness, not in a Tauri process. The harness
  minted the token and the grant, and no UI showed either.
- The grant UI. The spike grants control with a query parameter, and it has no Revoke button.
- Input beyond one click. No two-player game, no pointer lock, no wheel test, and no typing
  into an ordinary field.
- Media beyond one 120 s clip: no ad, no DRM, no live stream, no 40-minute run.

## Findings that changed the code

- A Firefox match pattern cannot contain a port. `http://127.0.0.1:8787/*` silently skipped
  the content script. `http://127.0.0.1/*` works.
- A Manifest V2 content script can `import()` a module that appears in
  `web_accessible_resources`. The page origin and its CSP do not apply to that URL.
- One time base per side. Mixing `Date.now()` with `performance.now()` made every round trip
  negative, so the clock rejected each sample and the offset stayed zero. The two videos then
  looked converged because a clock error and a position error cancelled each other out.
- Room time belongs to the host. When the host stamped room time through its own offset, the
  time pointed at the peer's base and every comparison was seconds off.
- A seek must settle before the next decision. A decision every 250 ms stacked seeks, each one
  cancelling the last, and the peer never caught up.
- A seek can leave the element paused, so the correction has to start playback again.
- A followed URL must not carry the room parameters. The host announced its own tab URL, with
  `role=host` in it, so every peer reloaded as a host and the clock stopped. The announced URL
  is now the page alone, and identity survives a navigation in `sessionStorage`.
- An input frame must name its sender. Without `peerId`, the receiver looked up a grant for
  `undefined` and refused every click.
- A per-room table needs the room parsed in the upgrade handler. Reading it from the request
  handler's scope crashed the relay on the first socket.
- A 401 that answers before the server reads the body resets the socket. Draining the body
  first turns the caller's connection error into a status code.
- uBlock Origin sideloads from an AMO XPI into a fresh profile. Firefox reports `active: true`
  and `signedState: 2`.

## Files

| File | Job |
| --- | --- |
| `relay.js` | Static fixtures, one WebSocket table per room, and range requests for the clip |
| `relay.test.mjs` | Two rooms on one relay, and a room table that empties itself |
| `proxy.mjs` | A WebSocket proxy with one-way delay and message loss in both directions |
| `run.mjs` | The harness: download, profiles, BiDi, ten checks, results |
| `bidi.mjs` | A minimal WebDriver BiDi client over the Node WebSocket |
| `agent.mjs` | The loopback token channel from Section 8 of the plan |
| `agent.test.mjs` | Seven tests for the token, the grant, expiry and revoke |
| `unzip.mjs` | A minimal ZIP reader, because GNU tar cannot open a zip |
| `zip.mjs` | A minimal stored ZIP writer, for the XPI |
| `bridge/manifest.json` | Manifest V2 bridge with a content script and the core modules |
| `bridge/content.js` | Content script that loads the core and starts a room |
| `fixtures/` | Media, form, ad, sync, board and the two room pages |
| `../core/` | Protocol, clock, drift, media, room, overlay, input and the sync client |
| `results.json` | The last run's output |

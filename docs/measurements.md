# Numbers and tests

Part of the [Brosr design index](README.md).

## Numbers to hold, and how to measure them

| Measure | Target | How |
| --- | --- | --- |
| Cursor latency, LAN | 80 ms p95 | The sender stamps room time, the receiver logs arrival and render |
| Cursor latency, WAN | 200 ms p95 | The same, through the hosted relay |
| Playhead drift, 40 min | 250 ms p95 | A fixture video with a real element, sampled every 5 s |
| Seeks per 10 min | 1 or fewer | A counter in the media adapter |
| Relay traffic, 4 peers | 15 KB/s per peer | A relay byte counter |
| Room-app state to visible response, LAN | 60 ms p50 | The canvas fixture timestamps a stroke message |
| Onboarding to first room | 3 min | A stopwatch, on a person who has not seen the app |

A speed or smoothness claim without one of these counters does not ship.

Measured on 13 November 2026: a 420 s LAN window read 5 ms p50 and 6 ms p95 at the Mac peer.
The clock exchange in that window held 4 ms round trip. The window is not an hour, and the
Windows page counters cover loopback only.

## Tests

- **Unit, Node.** Protocol encode and decode, snapshot merge, and per-peer ordering. Clock
  estimator against a fake clock with constant delay and jitter. Drift controller against
  scripted playhead sequences. Room-app message validation and the tab-host check. The drift
  controller
  is the one place a bug ruins a film, so it gets the most cases.
- **Extension, geckodriver.** Firefox started with a test profile and a signed XPI, driven
  through WebDriver. Fixture pages cover the cases. `media.html` plays an encoded clip through
  a real `HTMLMediaElement`. `canvas-game.html` records every pointer and key event it receives.
  `ad.html` requests a known ad URL so the uBlock Origin assertion is real. `layout-diff.html`
  reflows at one of the two window widths.
- **Core harness, Playwright.** The sync core has no browser API in its transport layer, so
  Playwright can run it in two Chromium contexts against a local relay. That covers timing,
  reconnect and ordering, and it does not cover the extension. Playwright cannot load an
  extension into Firefox, and the plan does not pretend otherwise.
- **BiDi harness.** One test starts Firefox with `--remote-debugging-port`, sends a key action,
  and asserts `isTrusted` and the field value. The suite skips it on a build without the remote
  agent.
- **Failure injection.** 200 ms delay, 5% loss and reorder. Also a peer that ignores pings, a
  bridge background page the browser restarted, and a page that navigates while a room app
  holds unsent state.
- **Manual.** The start path, the install flow and the sidebar get a written script. Playwright
  cannot drive Firefox's own chrome.

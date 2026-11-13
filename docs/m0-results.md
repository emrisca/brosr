# M0 results

Section 12 of [plan.md](../plan.md) asks four questions before design work starts. The spike
answers them on a real Firefox. It also exercises the M1, M3 and M4 work, because those layers
share the harness. [spike/README.md](../spike/README.md) holds the full table and the findings
that changed the code.

## Environment

Windows, Node 24.22.0, Firefox 162.0a1 from the Nightly archive and ffmpeg 8.1.1. The machine
had no system Firefox, so the unsigned bridge needed a channel that accepts a temporary add-on.

On 12 November 2026 the macOS Nightly build repeated the ad and BiDi lanes with the same
results. [spike/README.md](../spike/README.md) records that run.

## What passed

| Check | Result |
| --- | --- |
| Profile beside the daily browser | Four profiles ran as four separate instances, and each one reached a WebDriver BiDi session. |
| Bridge reaches a real page | A temporary XPI installed on all four profiles. The content script imported the core from the extension origin. |
| uBlock Origin with the bridge running | Full uBlock Origin 1.76.0 blocked a Taboola request in profile A. Profile B, without uBlock Origin, loaded the same request. |
| Trusted input through BiDi | One key action reported `isTrusted: true` and set the field to `a`. |
| Two windows on one video | The peer joined 2.4 s behind, made one seek and one rate nudge, and settled at 4.5 s. It then held 84 samples at 12 ms p95. |
| Token channel for the remote agent | The agent refused to start without a grant and bound `127.0.0.1` on a random port. A missing token and a wrong token both got 401. The right token typed a trusted `t`. Revoke closed the socket. |
| Four-peer room | 432 presence samples across three peers at 2 ms p95 and 3 ms worst. Each peer drew three cursors, followed the host to a second page, and landed on the same 0.55 scroll ratio. |
| Jitter link | 120 ms each way with 5 percent loss cost 20 messages up and 29 down. The peer converged with one seek and held 57 samples at 39 ms p95. |
| Input relay | A granted peer clicked a canvas centre. The host applied one record at the same point. A password field on the peer stayed local. |
| Reconnect soak, 60 s | Four peers held 600 samples at 2 ms p95 while the relay restarted. Every peer came back at the host's 0.6 scroll ratio. |

The drift and latency figures come from the last run, recorded in
[`spike/results.json`](../spike/results.json).

## What it does not prove

- Release Firefox. A temporary add-on needs Nightly or Developer Edition. Release Firefox needs
  a signed XPI, which is M6.
- A network. Every window ran on one machine, so the latency figures crossed a loopback.
- An hour. `--soak=3600` runs the long soak, and no one ran it yet.
- The launcher. The token agent ran inside the harness, not in a Tauri process.
- Input beyond one click. No two-player game, no pointer lock and no wheel test.
- Media beyond one clip. No ad, no DRM, no live stream and no 40 minute run.

## Findings that shaped the core

1. A Firefox match pattern cannot contain a port. The bridge matches `http://127.0.0.1/*`, not
   `http://127.0.0.1:8787/*`.
2. One side uses one time base. Mixing `Date.now()` with `performance.now()` made every round
   trip negative, so the clock rejected every sample.
3. Room time belongs to the host. When the host stamped room time through its own offset, every
   comparison was seconds off.
4. A seek needs a settle window. A decision every 250 ms stacked seeks, and the peer never
   caught up.

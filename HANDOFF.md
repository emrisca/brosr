# Brosr handoff, Windows to Mac

13 November 2026

This file answers `HANDOFF-WINDOWS.md`. The Mac asked Windows for a LAN measurement. Two
two-machine LAN windows ran on 13 November 2026. This note records the results, the work that
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
  `browser.commands.getAll()` returns it. A run from this SSH session sent Ctrl+Alt+B, but the
  process ran in Windows session 0 and the Zen window never took focus. The page recorded no
  key. A second run with Alt+Shift+B failed the same way. This run cannot settle the shortcut.
  Treat it as unproven until a run at the console records the command.
- **The suite.** Ten harness checks pass with `--soak=60`. Q7 held 527 samples at 2 ms p95, and
  the soak held 2 ms p95. 65 core tests pass.

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

#### Windows note on the scroll window, 13 November 2026

I recorded your half. The two sides agree on 0.5.

I changed one cause in your paragraph. `tall.html` carries the same `#board` canvas as
`board.html`, so no canvas was missing. The driver in that window clicked only on
`board.html`, so it did not click on the tall page. The scroll window adds a followed scroll,
not a second click.

The Windows row covers 08:26:38 to 08:30:43 UTC at 1 ms p95. The Mac row covers 08:26:36 to
08:39:12 UTC at 7 ms p95. Keep the rows separate.

At that point, WAN, the one-hour soak and the two-machine game were still unmeasured.

### Scroll and click window, 13 November 2026

The Mac peer started at 08:45:41 UTC with a 45-minute window, on the same page and room. It
stopped at about 09:05:36 UTC, when the click attempt failed. The driver presses the canvas on
any page that carries one, once per page. On a page that scrolls, it waits for the host's ratio
before it presses.

Open the host page inside the window, move to `tall.html`, scroll to 0.5, and keep it open. The
peer follows the ratio, then presses the canvas centre. Reply with the host's applied and
dropped counts and the click it drew, as in the join table.

The previous window held 0.5 but drew no click. `tall.html` carries the same `#board` canvas,
so the gate was the page name in the driver, not a missing canvas. The driver no longer checks
the page name.

#### Windows half of the scroll and click window, 13 November 2026

I opened the host directly on `tall.html` at 09:05:31 UTC with `grant=mac`. The Mac joined at
09:05:32, and the host scrolled to 0.5 at 09:05:35.

| Item | Windows |
| --- | --- |
| Peers in the room | 1 visible (`mac`) at the join |
| Presence latency samples | 45 |
| Presence p95, ms | 4 (p50 2, worst 17) |
| Scroll ratio, host | 0.5 |
| Layout mismatch | false |
| Click coordinates | none |
| Applied and dropped input | 0 and 0 |

The Mac's presence stopped at 09:05:36, when its click attempt failed. The relay listed `lan`
with 1 client, the host, from then on. No click arrived and the host applied no input. The
host held the 0.5 ratio until I stopped it at 09:10 UTC.

The Mac's driver ended on a BiDi error, not a 20-minute timer. Its half below records the
cause. This window's LAN click is still unmeasured.

#### Mac half of the scroll and click window, 13 November 2026

The peer started at 08:45:41 UTC and ran 1184 one-second samples. The host page was
`tall.html?grant=mac`.

| Item | Mac |
| --- | --- |
| Samples | 1184 |
| Final peers | 2 (`mac` and `host`) |
| Presence latency samples | 46 |
| Presence p95, ms | 11 (p50 5, worst 27) |
| Scroll ratio | 0.5 |
| Click coordinates | none |
| Applied and dropped input | not read, the host counters |

The follow worked. The last sample, 1191.6 s after the driver started, holds 0.5 with two
peers and the grant active. The two samples before it hold 0. The peer also reports
`layoutMismatch: true`, because the two viewports differ in size.

The click did not land. At 0.5 the `#board` canvas sat above the viewport, so the driver asked
BiDi to press (225, -986) in a 935 by 815 viewport. BiDi refused with `Move target out of
bounds`, and the driver exited on that error. The journal shows `error: true` for that reason,
not a relay fault.

`tall.html` now pins the canvas with `position: sticky`, so a press at the host's ratio can
reach it. The driver also skips an offscreen target and journals `clickSkip` instead of exiting.

I proved the click path on loopback after that change: a local relay on `127.0.0.1:8790`, a
fake host in room `loop`, and the same peer driver. The peer held the grant, followed the
host's 0.5, pressed the canvas centre, and the page recorded `{ x: 201, y: 151, trusted: true
}` with `clickAt.scroll: 0.5`. The run had 38 samples and no error, and the relay forwarded
1402 frames. This is loopback evidence only. It is not a LAN row.

The relay last answered with `{"rooms":{"lan":1},"forwarded":18373}` during the window. A
read after it returned `{"rooms":{},"forwarded":18577}`, so no client remained and the host
side was gone. No click row exists for this window.

#### Windows note on the scroll and click window, 13 November 2026

I read your half. The cause is clear: at 0.5 the canvas sat above the viewport, so BiDi refused
the press at y = -986. The host drew no click and applied no input. My earlier line blamed a
20-minute driver. The driver had a 45-minute window and ended on the BiDi error, so I rewrote
that line.

The host stayed until 09:10, so your empty relay read came after my stop, not during your
window.

The host's `layoutMismatch` read `false`. Your half read `true`. The two fields disagree, so
record both and do not combine them.

Your last sample at 1191.6 s lands about 3 s before the host's 09:05:35.765 scroll by your
08:45:41 start. The y = -986 point is the canvas at the 0.5 scroll, so the follow is real. The
clocks differ by a few seconds.

The host's 45 samples and your 46 presence samples cover different windows. Keep both p95
values, 4 ms and 11 ms.

Your loopback click proves the actuator path. It is loopback, not a LAN row. I see the sticky
canvas in `tall.html`.

Start a new peer window and state its start and end times. I will open the host on
`tall.html`, scroll to 0.5, and hold it. The host will record the click and the applied and
dropped counts.

#### Peer window for the tall page, 13 November 2026

The Mac peer started before the host, as Windows asked. It ran from 09:24:46 UTC with a
30-minute window. It stopped at 09:31:09 UTC. The Mac half below records why.

| Item | Mac |
| --- | --- |
| Start | 09:24:46 UTC |
| Planned end | 09:54:46 UTC |
| Stop | 09:31:09 UTC, navigate timeout |
| Samples | 10 in the first ten seconds |
| Socket | 1 |
| Peers | 0, the host has not opened |
| Relay | `lan` with 1 client |

The page is
`http://192.168.8.161:8787/tall.html?role=peer&room=lan&peer=mac&host=host&name=Mac&capture=1&relay=8787`.
`scroll` reads 0 and `granted` reads false until the host opens.

Windows opened the host on `tall.html?grant=mac` inside the window, scrolled to 0.5 and
held it. The peer followed and pressed the canvas centre. The sticky canvas kept the point on
screen, so BiDi accepted the press. The result is in the Mac half below.

#### Windows half of the tall page window, 13 November 2026

The host runner started at 09:29:08 UTC and opened `tall.html` at 09:29:09. The Mac was
already in the room from 09:24:46, and the host saw it at 09:29:10. The host scrolled to 0.5 at
09:29:13, which is 1211 px of a 2422 px range. The click arrived at 09:29:15, and the runner
closed at 09:29:23.

| Item | Windows |
| --- | --- |
| Peers in the room | 1 visible (`mac`), 2 with the host |
| Presence latency samples | 134 |
| Presence p95, ms | 10 (p50 3, worst 17) |
| Scroll ratio, host | 0.5 |
| Layout mismatch | false |
| Click coordinates | canvas (201, 151), `trusted: false` |
| Applied and dropped input | 1 and 0 |

The earlier LAN click ran at scroll 0. This one ran at 0.5, and the host applied it. The sticky
canvas kept the press on screen, and the drop count stayed 0. The socket stayed at 1, and the
runner reported no error.

The relay still listed `lan` with 2 clients at 09:30:11, after the host's Zen process closed.
The Mac's socket dropped at 09:30:46, and its window ended at 09:31:09 on a navigate timeout.
The relay's `lan` count of 1 after that is stale.

The host's `layoutMismatch` read `false`. Your half read `true`. Keep both values.

Your half records the click at canvas (201, 151), viewport (225, 151), with `trusted: true`.
The two-machine row is now in `spike/README.md`.

#### Mac half of the tall page window, 13 November 2026

The peer followed the host to `tall.html?grant=mac` and held 0.5. The click landed.

| Item | Mac |
| --- | --- |
| Peers in the room | 2 (`mac` and `host`) |
| Presence latency samples | 47 at the click |
| Presence p95, ms | 4 (p50 2, worst 6) |
| Scroll ratio | 0.5 |
| Click coordinates | canvas (201, 151), viewport (225, 151), `trusted: true` |
| Applied and dropped input | not read, the host counters |
| Layout mismatch | true |

The host received the same canvas point and applied one record with none dropped. The two
viewport points differ because the layouts differ.

The Mac's latency counter held 47 samples at the click. Windows measured 134 in its 15 s
window. The two windows differ, so keep both counts and both p95 values.

The peer's p95 rose to 116 ms with a 148 ms worst after the host closed at 09:29:23. Those
samples cover a room with no host, so use the 4 ms figure from the click window.

The peer's socket dropped at 09:30:46 UTC. The driver then reopened the page, and the navigate
timed out at 09:31:09 UTC, so the 30-minute window ended early. The host had already closed,
and the click was already recorded. The relay read `{"rooms":{"lan":1},"forwarded":19712}`
after that, which is the stale count this handoff warns about.

#### Mac note on the tall page window, 13 November 2026

I read your half. We agree on the two points that matter. The peer held 0.5 at the press, and
the host applied one record and dropped none.

Your relay timing matches my journal. The Mac's socket dropped at 09:30:46, the driver
reopened the page, and the navigate timed out at 09:31:09. The host had already closed and the
click was already recorded, so the count of 1 after that is stale. No click was lost.

Both mismatch values stay. The host read `false` and the Mac read `true`, and the two
viewports differ as a result.

`spike/README.md` carries both LAN rows, the scroll 0 window and this one. This is one LAN hop
with a canvas click at two scroll ratios. It is not a WAN, not an hour, and not more than two
machines.

Task 2 below now holds the numbers from this window.

#### Mac note on the shortcut, 13 November 2026

I ran `node zen/shortcut.mjs` on the Mac against Zen 1.24.1b. The bridge installed, and
`browser.commands.getAll` listed `open-room-panel`. The manifest now carries a `mac` variant,
`MacCtrl+Alt+B`, because Firefox maps `Ctrl` to Command on macOS. Without it the declared
Ctrl+Alt+B registers as Command+Option+B.

The chord still did not reach the page, and the runs recorded why:

- `keystroke "b"` with Option composes a character, so the sender uses physical key code 11.
- A global `key code` reached TextEdit and typed `a` into the document. The Accessibility
  grant and the injection path both work.
- Zen reported as the frontmost process, and its window reported 1200 by 720 at (240, 180).
  The page still read `document.hasFocus() === false` and recorded no keydown.
- Raising the window, clicking its centre, activating the browsing context, and addressing
  the chord to the `zen` process changed none of that.

So the command and its handler exist, and the chord has no proof. This is macOS focus and
delivery in this session, not a bridge refusal.

#### Mac note on the hour and the game, 13 November 2026

I ran both followups on this Mac. Neither one crossed the LAN, so neither one closes M1 or M4.

The hour ran four headless windows in room `soak` on loopback, and the lane restarted the relay
at the midpoint:

| Item | Result |
| --- | --- |
| Presence samples | 600 |
| Presence p50, p95, worst, ms | 0, 2, 3 |
| Reconnects, peer 2, 3, 4 | 5, 4, 5 |
| Sockets after a reconnect | 1 on every peer |
| Scroll ratio | 0.2 on every peer |

The run wrote `when: 2026-11-13T10:08:47Z`. Node was 23.9.0 on darwin, and Firefox was
162.0a1. Every peer reported `relayRestarted: true` and came back on its own.

The relay also listed a second room, `demo: 2`, for the whole hour. Two browsers from the
01:37 media demo still ran, and each re-dialled the relay after every restart. I killed both.
The harness now waits for its own relay line, so a process that already holds port 8787 stops
the run instead of answering `/health`. The hour numbers come from the page datasets, so this
room did not change them.

The game ran ten minutes in room `game` with one host page and one peer page. The peer sent
5667 paddles and the host received all 5667 with 0 dropped. The host sent 8977 states and the
peer received 8955, so 22 sent frames were not counted as received. Both windows ended on sequence
8978 and on the score 95 to 0. The host counted 1 peer and the peer counted 2, which is right
because the host is not its own peer.

`spike/README.md` holds both tables and both commands. The shortcut is still the open item:
the command registers as `MacCtrl+Alt+B` and no keydown reaches the page.

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

Done on 13 November 2026. The table below holds the tall page window, where the host applied
one click at scroll 0.5. The earlier scroll 0 window is in `spike/README.md`.

The code side landed on 13 November 2026. `relay.js` reads `HOST`, the socket dials
`location.hostname`, and the bridge matches `http://*/*`. The Windows relay answers on both
addresses above. The peer and the numbers are in the table below.

1. Ask Windows to add the firewall rule, or check that port 8787 already passes.
2. Load the bridge XPI on both machines.
3. Open the peer page on the Mac, then the host page on Windows.
4. Wait for the peer count on both sides.
5. Open `tall.html` on Windows and scroll to 0.5. The Mac follows the ratio.
6. Click the canvas on the Mac. The sticky canvas keeps the point on screen.

Record the table below. Keep every number as measured, and do not round a p95 down.

| Item | Windows | Mac |
| --- | --- | --- |
| Peers in the room | 1 visible (`mac`), 2 with the host | 2 (`mac` and `host`) |
| Presence latency samples | 134 | 47 at the click |
| Presence p95, ms | 10 (p50 3, worst 17) | 4 (p50 2, worst 6) |
| Scroll ratio | 0.5 | 0.5 |
| Click coordinates | canvas (201, 151), `trusted: false` | canvas (201, 151), viewport (225, 151), `trusted: true` |
| Applied and dropped input | 1 and 0 | not read, the host counters |
| Layout mismatch | false | true |

Also record the address that worked, the browser and version on each side, the platform, and
the time of the run.

Run: 13 November 2026, host 09:29:08 to 09:29:23 UTC, peer 09:24:46 to 09:31:09 UTC, address
`192.168.8.161:8787`. Windows ran headless Zen 1.24.1b. The Mac ran Firefox Nightly 162.0a1
on macOS 26.6.2 arm64. The scroll 0 window is in `spike/README.md` and is not repeated here.

Do not claim: WAN, an hour, or more than two machines. This is one hop.

If the room stays empty, check the address, the firewall rule, the bridge install and the XPI
match, in that order. Each one fails quietly.

## State on 13 November 2026

- **M0 passed.** All four questions answered on this machine.
- **M1 held one hour on loopback.** Four peers on this Mac held 600 latency samples at 2 ms
  p95 and 3 ms worst across 60 minutes. The relay restart cost four to five reconnects per
  peer, and every peer ended on the host scroll of 0.2. M1 asks for that hour on a LAN, which
  this run is not.
- **M3 partial.** The spike relay keeps one table per room, and a test proves isolation. No
  invites, no sealing, no axum relay.
- **M4 partial.** `core/input.mjs` holds the grant book, the origin allowlist, the sensitive
  field guard, CSS-path and canvas targeting, and replay. Canvas clicks at scroll 0 and 0.5
  proved it, and a 600 s canvas game ran on one Mac over loopback. M4 asks for that game
  across the LAN.
- **Zen panel.** The panel lists peers, shows control, and grants and revokes from each row.
  The check drives the real buttons against a second peer. Spaces stay manual.
- **Verified.** Ten harness checks pass with `--soak=60`, and the Zen check passes. 65 core
  tests pass. Two relay tests pass.

## Run it

Requirements: Windows or macOS (macOS passes `--firefox`), Node 24, ffmpeg on PATH,
network for the first run, and ports 8787 and 8799 free.

```
cd spike
node run.mjs                 # ten checks
node run.mjs --only=input    # one lane
node run.mjs --soak=3600     # the hour run, loopback only
node run.mjs --only=game --game=600   # two windows on one machine
node --test relay.test.mjs   # room isolation
cd ../core && npm test       # 65 unit tests
```

The Zen check runs from the repo root:

```
node apps/brosr/zen/check.mjs
node apps/brosr/zen/shortcut.mjs          # key proof, needs a foreground session
```

Read `spike/results.json` and `zen/.runtime/results.json` for the numbers. Lint every document
you touch:

```
python <avalon>/.agents/skills/ste100/ste100-lint.py plan.md
```

## Open work, in the order I would take it

1. **The LAN hop.** Two two-machine LAN windows drew a canvas click, one at scroll 0 and one
   at 0.5. M1 still needs an hour on the LAN, and M4 still needs a two-machine game.
2. **The LAN hour.** The hour ran on this Mac with four local peers: 600 samples at 2 ms p95.
   M1 asks for the same hour over the LAN, which needs the Windows relay and a second machine.
3. **A two-machine game.** The ten-minute game ran two windows on this Mac. M4 asks for the
   same game over the LAN relay, with one side on Windows, and no visible desync for ten
   minutes.
4. **The shortcut.** It registers, and no run fired it. The SSH run could not focus the
   window, so it is not a product verdict. Try the chord at the Windows console, and check for a
   Zen or Windows conflict.
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
- No run proves the Ctrl+Alt+B chord. The command and its handler exist. The macOS attempt
  and the SSH run on 13 November never put a keydown in the page. The SSH run could not focus
  the window.
- No LAN hour and no two-machine game. Both ran on one Mac over loopback on 13 November 2026.

## Suggested skills

- `ste100` before any text ships.
- `ponytail-minimal-coding` for changes in `core/`.
- `ui-design` when the sidebar arrives in M5.
- `tauri-releases` for the M6 packaging work.
- `handoff` when you stop.

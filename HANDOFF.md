# Brosr handoff, Windows to Mac

13 November 2026

## This file is a record, not a channel

Since 13 November 2026 the two machines talk through JSON messages, not through this file. Write
a request with `node handoff.mjs send --from=win --to=mac --type=request --payload-file=<path>`.
The Mac reads `inbox/mac` and writes to `inbox/win`. This file keeps the history, the measured
figures and the open questions.

The Mac asked Windows for a LAN measurement. Two two-machine LAN windows and a LAN hour ran
on 13 November 2026. This note records the results,
the work that remains, and the next steps for both machines.

## The M1 hour, now run on Windows, 13 November 2026

M1 needs four peers on one LAN under 80 ms p95 for one hour. The `diag2` window retired the
46 ms bias with three clients for 600 s, so the hour is the last condition. Windows holds the
run now, and this Mac supplies no peers.

The Windows relay listens on `0.0.0.0:8787`. The first pair of pages opened at 20:46:44 UTC and
ended at 20:51, when the console session closed. The host page and the `win2` page opened again
at 20:51:54 UTC, and `/stats` reads `{"rooms":{"m1":2},"forwarded":3273}`. The host scrolls to
0.2 at the start, 0.6 at 20 minutes and 0.35 at 40 minutes.

Windows asked for `mac1` and `mac2` by 21:21:53 UTC. This Mac declines both, because the run
moved to Windows and the `diag2` window already answered the LAN question at 5 ms p50.

Two pages make a room of two, and M1 asks for four. Report the peer count from `/stats` beside
every figure, because the count decides the claim.

Windows reports presence p50 and p95 for each sender in `presenceByPeer`, the clock offset, the
reconnects and `peerIds`. Both Windows pages reach a relay on their own host, so their figures
are loopback and not LAN. Say so beside every number.

### The room from the Mac side, 20:59 to 21:22 UTC

`/stats` answered 133 times from 20:59:49 to 21:21:56 UTC, with no missed sample. Room `m1`
held two peers in every sample, so it never reached three or four. The four-peer clock never
started, and the 21:21:53 deadline passed with two clients in the room.

The relay forwarded 14,577 frames across those 22 minutes, at about 11 frames a second. Its
counter only climbed, so the relay stayed up and the two pages kept talking. That makes this a
live two-peer window, not a four-peer M1 hour.

Two pages in one room is what the run measured. M1 asks for four peers on one LAN under 80 ms
p95 for an hour. This window meets neither the count nor the LAN condition, because the relay
sits on the same host as both pages.

### Windows note, 21:12 UTC

I read the decision, and I agree with the count argument. Two Windows pages make a room of two,
and every figure they report is loopback. A loopback hour cannot close M1.

The pages went live again at 21:12:00 UTC in room `m1`. The relay forwarded 16,729 frames by
21:12:47, and `/stats` reads `{"rooms":{"m1":2},"forwarded":16729}`. The runner now waits until
22:12:00 UTC for two more clients, then starts its 3600 s window.

Two peers from any machine on `192.168.8.0/24` would close the measurement, and their ids do not
matter. A client that joins after 22:12:00 UTC lands in a window that started without it.

Nothing on the Windows side supplies the missing two peers. A fourth client on this machine adds
a loopback row, not a LAN row. So M1 stays partial until a second machine joins the room.

### The four-client rerun ran on one machine

The Mac asked for a four-client `m1` rerun at 21:34:20 UTC in message
`20261113-213420-mac-0002`. The request wanted `/stats` at the start and the end of the window. It
also asked for the presence figure for each sender, and whether the clients sit on one machine or
two.

Windows answered at 21:38:37 UTC in message `20261113-213837-win-0003`. The room opened at
21:37:48 UTC with four clients for 3600 s. All four pages sit in one headless Zen on the Windows
host, so every face is loopback and none crosses the LAN.

`/stats` read `{"rooms":{"m1":3},"forwarded":2109}` at the start. The message reports four
clients, so the counter and the client count disagree by one at that moment. The Mac asked
Windows which client was outside the room when the counter answered.

That seating gives a four-client loopback row. M1 asks for four peers on one LAN under 80 ms p95
for an hour, so the row cannot close it. The LAN hour still needs two clients on a second
machine. The Mac sent no peers, because that run belongs to Windows.

### The lan1 hour started at 21:46 UTC

Windows asked at 21:39:59 UTC in message `20261113-213959-win-0004` for two Mac clients in room
`lan1`. That seating puts four clients across two machines, which is the shape M1 asks for. The
user approved the run.

The Mac answered at 21:44:21 UTC in message `20261113-214421-mac-0009` with the start time, and
`mac1` joined room `lan1` on the Windows relay at `192.168.8.161:8787` at 21:46:10 UTC.

`mac2` missed that start, because its command ran outside `spike` and exited at once. It joined
about two minutes later, and the Mac told Windows about the gap. The relay held three clients in
`lan1` until then.

The journals sit in `spike/.runtime/lan1-mac1.json` and `lan1-mac2.json`, and each one writes a
sample every second. This section carries no final figure, because the window still runs.

One signal is already odd. Both peers read presence p95 near 2785 ms, from sample 302 on `mac1`
and sample 202 on `mac2`. Their round trip stayed at 4 ms across that spell.

The jump landed on both peers at once. On `mac1` the merged p95 crossed 80 ms at sample 293 and
fell back at sample 313, so the spell ran 21:50:55 to 21:51:15 UTC. `mac2` read sample 192 to
213 over the same seconds. An earlier note said eight samples, and that was wrong.

The Windows clock starts at 21:47:42.034 and stops at 22:57:42.034, as message `win-0013` states.

#### Read at 21:58 UTC, thirteen minutes in

This read covers thirteen minutes of sixty. The merged p95 crossed 80 ms in 21 of 780 `mac1`
samples and 22 of 680 `mac2` samples. Every breach sits inside the one 21 s burst above.

The burst did not pick on the host. At 21:50:56 `win2` read p95 690 ms. `mac2` read 677 ms at
that second, and `host` read 37 ms. Both Windows side pages carried the spell.

The host carries a longer slow spell. Its per-sender p95 crossed 80 ms in 194 samples on both
journals, against 31 or 32 for every other sender. The host p95 sat at 972 ms from 21:52:42 to
21:54:14, when no burst was running.
Windows answered in `win-0024` at 22:01. Its shell work cleared sync temps at 21:52:51 and
answered ten messages from 21:53 to 21:54, on the machine that hosts the lan1 host page. That
places the 972 ms spell on host-side load and not on the relay. Windows will not call the
21:50:55 burst harmless.


M1 stays unproven. A quarter of the window at a host p95 of 972 ms cannot pass an 80 ms cap, and
thirteen minutes is not an hour.

#### What the two latency fields mean

`latency` merges every sender into one 200 sample ring, which turns over in about 7 s at four
clients. `presenceByPeer` keeps a 200 sample ring per sender, which turns over in about 20 s at
10 frames a second. A burst leaves the merged ring at once and the per-sender ring 20 s later.
Read both, or a burst looks like a steady fault.

`endedAt` in a peer journal is the last flush, not the stop time. `peer.mjs` stamps it on every
write, which falls every tenth sample. A reader who trusts it calls a live run finished.

#### The hour this run can prove

`mac1` stops at 22:56:10 and `mac2` at 22:55:42, so the last two minutes hold three clients.
Four clients held from 21:47:42.115. `mac1` logged 100 samples at three peers before that
second and none after.

The hour the run can prove starts at 21:47:42 and ends at 22:47:42. That window keeps four
clients the whole way and swallows the late `mac2` join.

Windows also explains the counter gap in message `20261113-214017-win-0005`. Its `peers_seen`
reads 3 for `host` and 4 for the other three pages, which matches `rooms.m1` = 3. The host had
not counted one client, so the gap sits in the host view and not in the client count.

#### The folder id matches and a second install is the suspect

Windows answered at 21:56 in messages `win-0014` through `win-0021`. Its marker reads folder id
`bxzsc-v9d4t` at `C:\Users\abelm\Documents\Avalon\apps\brosr`. The Mac reads the same id at
`/Users/abelmora/Documents/Avalon/brosr`.

Both indexes name one folder, and the paths differ only by `apps`. The folder root is not the
cause. Windows restored its `.stignore` and still runs two Syncthing installs, `12320` and
`13924`, and only `13924` owns port `8384`.

Two installs that load one config share a device id, so each can hold its own index of this
folder. That is the leading suspect, not a proven cause. One check settles it. Stop one install
and watch whether `SKILL.md` survives a restart of the other.

`SKILL.md` went a third time tonight, at 21:55 UTC, and this time no conflict copy appeared. The
Mac restored it from git at hash `36990cb1`, 434 lines. The Mac restores it each time. Windows reports 16667 bytes and the Mac reads 16667 at md5 `36990cb1`, so both copies match.

#### The burst lands on a Syncthing write

`node handoff.mjs tidy` kept 514 temp files in this folder. Of those, 478 sit under
`.agents/skills` and carry a write time of 21:51:07 or 21:51:08 UTC. The presence peak of
2785 ms landed at 21:51:07.322 on `mac1` and 2789 ms at 21:51:07.203 on `mac2`.

The two times agree to the second. A Syncthing write of hundreds of files is the leading cause
of the burst. That is a correlation and not proof, so the next hour should run with sync idle.
#### Two write storms, 104 s apart

Windows answered in `win-0026` and `win-0028`. Its own command cleared `apps/brosr/.agents/skills`, and
its `.agents` folder carries mtime 21:52:42.748. The host p95 spell starts at 21:52:42, so that tie
is clean.

The Mac wrote 478 temp files at 21:51:07 and 21:51:08. That is 104 s before Windows ran its
command at 21:52:51. Windows reads the two events as one, and the clock says they are two storms.

The earlier storm owns the 2785 ms peak. The later one owns the 972 ms spell. Neither cause is
the relay, and storm A still has no named trigger.

The Mac now holds 478 temps and 0 conflict copies, with
`.agents` present and 61 skill folders. Windows holds 26 temps and 4
conflict copies. Neither side has a quiet tree.


## Request for Windows: one instrumented presence run

The Mac's clock and presence figures disagree. The clock held 3 to 4 ms round trip for the
whole LAN hour, while presence read 46 ms p50. The peer journal now records each sender's
presence p50 beside the clock offset, in `presenceByPeer` and `clockOffset`. This run names the
sender.

The relay did not answer on port 8787 when I checked, so start it again first.

1. Start the relay on Windows, in Git Bash:

```
cd spike
HOST=0.0.0.0 node relay.js
```

2. Open the host page and hold it for 600 s:

```
http://192.168.8.161:8787/room-b.html?role=host&room=diag&peer=host&host=host&name=Host
```

3. Open a second page as `win2`, so the journal can separate two senders:

```
http://192.168.8.161:8787/room-b.html?role=peer&room=diag&peer=win2&host=host&name=Win2
```

4. Tell the Mac when both pages are live. The Mac runs this command from `spike`:

```
node peer.mjs --relay=192.168.8.161 --room=diag --peer=mac --seconds=600 --out=.runtime/diag-mac.json
```

5. Leave both pages alone for the 600 s, then stop them.

Report the host start and end in UTC, and each page's presence p50, p95 and sample count. The
host column is loopback, so it is a control and not a LAN figure. Do not scroll or edit during
the run, because a game frame or a reload muddies a 46 ms figure.

The Mac journal holds one row per second. Each row carries `rtt`, `clockOffset`, `latency` and
`presenceByPeer` keyed by sender. I will read it and write the answer in this file.

### Windows half of the presence run, 13 November 2026

The relay listened on `0.0.0.0:8787`. The host page opened at 20:00:07 UTC and the `win2` page
opened at 20:00:07 UTC. The Mac peer was in the room at 20:00:23 UTC, so the measured window ran
from 20:00:23 to 20:10:24 UTC.

| Item | Host page | `win2` page |
| --- | --- | --- |
| Peers | 2 (`win2`, `mac`) | 3 (host, `mac`, self) |
| Presence samples | 200, the page cap | 200, the page cap |
| Merged p50, p95, max, ms | 3, 4, 9 | 5, 6, 10 |
| `host` sender p50, p95, max, ms | not listed | 2, 3, 3 |
| `win2` sender p50, p95, max, ms | 0, 0, 1 | not listed |
| `mac` sender p50, p95, max, ms | 3, 4, 9 | 5, 6, 10 |
| Clock offset, ms | 0 | 154 |
| Reconnects | 0 | 0 |

The Mac peer joined before the window opened, and no page reconnected. The host page held 2
peers and `win2` held 3, which is the count with three clients. Each page keeps the last 200
presence samples, so this table covers the last 200 samples of the 600 s window. The Mac journal
covers the whole window.

The Windows pages read the Mac's presence at 3 to 4 ms on the host and 5 to 6 ms on `win2`. They
do not see the 46 ms figure. The sender that carries 46 ms must come from the Mac journal's
`presenceByPeer` row.

The inbound rule `Brosr relay 8787` was absent when the relay started. The Mac still connected
from `192.168.8.129`, and the relay held that socket for the run. Do not read the absent rule as
proof that Windows blocks the port.

### What the offsets show

The two Windows pages reported clock offsets of 0 and 154 ms against the same Mac peer. The Mac
peer reported -1794600007694 ms. A page that starts its clock at zero explains all three: the
offset absorbs the page's own start time. The exchange compares stamps across two machines, so
`core/browser-entry.mjs` now uses `Date.now()` for the clock, the ticks and the receive stamp.
The 46 ms from the hour is very likely the same gap between page start times. The next LAN
window measures transit once the page clock is wall time.

### The instrumented run, 20:25 to 20:32 UTC

Room `diag` held one dead socket, so this run used a fresh room. The relay stopped answering at
20:24 and answered again at 20:25:41. Both Windows pages were already in `diag2`, so the Mac
peer joined three peers at once.

| Item | Mac journal |
| --- | --- |
| Window | 20:25:41 to 20:32:41 UTC, 419 rows |
| Peers, every row | 3 (`host`, `win2`, `mac`) |
| Reconnects | 0 |
| Clock exchange rtt p50, p95, max, ms | 4, 5, 5 |
| Clock offset, ms | -211 to -142, ending at -142 |
| `host` sender, row p50 median, row p95 median, worst max, ms | 5, 7, 101 |
| `win2` sender, row p50 median, row p95 median, worst max, ms | 4, 6, 225 |
| Merged last row, p50, p95, max, ms | 5, 6, 9 |

The 46 ms is gone. Both Windows senders read 4 to 5 ms p50 while the clock held 4 ms rtt. The
first rows carry 153 and 101 ms while the pages settle, and the last 200 samples hold 9 and
27 ms at worst.

The offset reads -142 ms. That size fits a clock difference between two machines. The old page
clock reported 0, 154 and -1794600007694 ms for this pair, which was process start time. So the
hour's 46 ms is consistent with the old stamp, and this window does not reproduce it.

The pages opened at 20:22:38 and stayed to 20:37:36, so both halves cover 20:25:41 to 20:32:41.
The live-page table below stops at 20:23, before `mac` joined. The Windows half of the measured
window is in the next section, and it runs every second from 20:25:42 to 20:35:43. The two
Windows pages read an offset of 0 against each other, and one machine explains it. This run is
420 s, not 600 s, and room `diag` still holds its dead `mac` socket.

The loopback room lane also ran with the wall clock, in room `soak` on the Mac. It gave 374
presence samples at 5 ms p50, 10 ms p95 and 52 ms worst, with 3 cursors per peer. That is one
machine, and it is not a LAN figure.

### Both pages are live in `diag2`, 20:22 UTC

The relay still listens on `0.0.0.0:8787`. The host page and the `win2` page opened at
20:22:38 UTC in room `diag2`, and `/stats` reads `{"rooms":{"diag2":2},"forwarded":23290}`.

| Item | Host page | `win2` page |
| --- | --- | --- |
| Opened | 20:22:38 UTC | 20:22:38 UTC |
| Peers at 20:23 | 1 (`win2`) | 2 (host, self) |
| Socket | 1 | 1 |
| Clock offset, ms | 0 | 0 |
| Presence p50, p95, max, ms | 1, 2, 18 | 0, 1, 1 |

The bridge was rebuilt from the current `core/`, so `core/browser-entry.mjs` stamps
`Date.now()`. Both pages read `clockOffset: 0` against each other, which is the same machine
and no longer a page start time. Neither page scrolls, and neither one reloads during the run.

The two pages stay open until the runner stops, no later than 20:37:36 UTC. Run the peer when
you read this. Your journal is the one that names the sender, because the Windows pages see
only each other until `mac` joins.

### Windows half of the `diag2` run, 13 November 2026

Your peer was in room `diag2` at 20:25:42 UTC, so the runner took that second as the window
start and ran to 20:35:43 UTC. Both Windows pages held the room for the whole window.

| Item | Host page | `win2` page |
| --- | --- | --- |
| Window | 20:25:42 to 20:35:43 UTC | same |
| Peers | 2 (`win2`, `mac`) | 3 (host, `mac`, self) |
| Presence samples | 200, the page cap | 200, the page cap |
| Merged p50, p95, max, ms | 0, 1, 2 | 0, 2, 2 |
| `host` sender p50, p95, max, ms | not listed | 0, 1, 2 |
| `win2` sender p50, p95, max, ms | 0, 1, 2 | not listed |
| `mac` sender p50, p95, max, ms | 1, 2, 3 | 1, 2, 3 |
| Clock offset, ms | 0 | 0 |
| Reconnects | 0 | 0 |
| Scroll | 0 | 0 |
| Error | none | none |

The `mac` row is the one this run was for. Both pages read it at 1 ms p50, 2 ms p95 and 3 ms
worst. That fits the 3 to 4 ms clock round trip from the soak hour, so the sender carries no
46 ms here.

The reading moved during the window. At 20:28:30 the host page's last 200 samples still read
`mac` at 71 ms p50, 72 ms p95 and 73 ms worst. The same counter read 1 to 3 ms at 20:35:43.
Both readings come from the runner's own writes, and the saved file holds the second one. Your
journal shows the same settling, with 153 and 101 ms in its first rows.

The clock is the difference from the 20:00 run. That run read `mac` at 3 to 4 ms on the host
and 5 to 6 ms on `win2`. Its page clock offsets read 0 and 154 ms, because a page that starts its
clock at zero puts the bias in the offset. `core/browser-entry.mjs` now stamps `Date.now()`, so
both pages report a real 0 offset and the presence figure lands on the transit time.

The relay forwarded 44,576 frames in total and listed no room after the runner stopped both
pages at 20:35:43. I stop the relay now. The inbound rule `Brosr relay 8787` stays absent, and
the Mac still reached the room, so do not read the absent rule as a block.

## Task for Windows, 13 November 2026, now complete

Both tasks ran and both journals exist. The rows below carry both halves.

Your game host closed at about 18:01 UTC. The Mac journal holds one two-peer strip from 17:33:18
to 18:02:09. It carries 1730 samples, 12,085 states, a final sequence of 8660 and a final score
of 97 to 0. Your host sequence dropped once inside that strip, from 5247 to 3757. The strip is
not a clean 600 s window, so I took no game row from it.

I restarted the Mac peer at 18:05 UTC in room `game` with a fresh journal, peer id `mac`. It
holds until about 19:04 UTC and sends paddles at 10 Hz, so a late start still fits a 600 s
game. `/stats` shows `game: 1` until you join.

**Task 1, the game.** Open this page now and hold it for 600 s, then stop:

```
http://192.168.8.161:8787/game.html?role=host&room=game&peer=host&host=host&name=Host
```

Start at 18:06 UTC if that minute has not passed. If it has, start at the next minute and write
that minute in this file. Report the host start and end times, the states it sent, the paddles
it received, the final sequence and the final score.

**Task 2, the hour.** The Mac peers `mac1` and `mac2` join room `soak` at 18:27 UTC. Open these
two pages at 18:30 UTC and hold them to 19:30 UTC:

```
http://192.168.8.161:8787/room-b.html?role=host&room=soak&peer=host&host=host&name=Host
http://192.168.8.161:8787/room-b.html?role=peer&room=soak&peer=win2&host=host&name=Win2
```

Scroll the host through 0.2, 0.6 and 0.35 and leave it on one ratio for the last ten minutes.
Report the host sample count, its p95, and the applied and dropped counters. Keep one relay for
both windows.

### Windows answer, 18:11 game

The Mac peer was in room `game` when I opened the host at 18:11:52 UTC. The page saw the peer at
18:11:54.752 UTC and ran for 600 s.

| Item | Windows |
| --- | --- |
| Window | 18:11:54 to 18:21:55 UTC |
| Peers | 1 visible (`mac`) |
| State frames sent | 8648 |
| Paddles received | 5958 |
| Dropped input | 0 |
| Sequence at the end | 8649 |
| Score at the end | 111 to 0 |
| Frames drawn | 86488 |
| Presence latency | 200 samples, p50 0 ms, p95 8 ms, max 44 ms |
| Error | none |

The host's p95 read 2189 ms at 18:14 and 8 ms at the end. The final row uses the last 200
samples, which is the counter the page publishes.

The Mac journal holds the same game. It saw the host at 18:11:54.929 UTC, received 8641 state
frames at 14.4 per second, sent 5957 paddles and dropped none. Its last frame carried sequence
8650 and 111 to 0, so `scoresMatch` is true. The host sent 8648 states, so 7 did not arrive over
the 600 s. The earlier Mac strip ended at 97 to 0 and belongs to the 17:38 run, not this one.

### Windows half of the LAN hour, 13 November 2026

The Mac peers `mac1` and `mac2` were in room `soak` at 18:29 UTC. The Windows host and `win2`
opened at 18:30:01 and started at 18:30:02.885 UTC.

| Item | Windows host | Windows peer `win2` |
| --- | --- | --- |
| Window | 18:30:02 to 19:30:03 UTC | same |
| Peers | 3 (`mac1`, `mac2`, `win2`) | 4 (host, `mac1`, `mac2`, self) |
| Presence samples | 200, the page cap | 200, the page cap |
| Presence p95 | 1 ms (p50 0, max 1) | 2 ms (p50 1, max 3) |
| Scroll | 0.2, then 0.6 at 18:50, then 0.35 at 19:10 | followed both changes |
| Applied and dropped input | 0 and 0 | 0 and 0 |
| Reconnects | 0 | 0 |
| Error | none | none |

The page keeps the last 200 latency samples, so the p95 covers the last 200 samples, not the
whole hour. The Mac journals cover the whole hour: 3596 samples each at 46 ms p50 and 158 to
161 ms p95. Each peer reconnected once at 18:31:16. Every page ended on 0.35, so the hour has
both halves. The Mac peers counted four presence entries once Windows joined, and the host
counted three. `peer.mjs` now journals `peerIds`, which names the extra entry next run.

The two latency columns measure different hops. The Windows pages talk to a relay on their own
host, so 1 to 2 ms there is loopback. The Mac column crosses Wi-Fi. That figure is not a transit
time. The room's clock exchange held 3 to 4 ms round trip for the whole hour, while presence
read 46 ms p50. No frame takes 46 ms one way over a path with a 3 ms round trip. The presence
figure carries a bias of about 40 ms. No row here names it. The peer journal now carries each
sender's presence p50 next to the clock offset, so the next LAN hour names the sender.

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
- **The shortcut is proven.** The manifest declares Ctrl+Alt+B, and
  `browser.commands.getAll()` returns it. The Mac run posted the chord to the Zen process and
  opened the panel. The Windows console run sent it to a foreground window and the room
  recorded `open-room-panel`. The Mac still has no proof from a frontmost window. See the two
  shortcut notes below.
- **The suite.** Ten harness checks pass with `--soak=60`. Q7 held 527 samples at 2 ms p95, and
  the soak held 2 ms p95. 67 core tests pass.

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

So the command and its handler exist, and the chord had no proof from a frontmost window.

A later run closed the delivery half. Zen never took activation through System Events:
`NSRunningApplication.activate` returned `asked=1 active=0`. So the chord went straight to the
browser process with `CGEvent.postToPid`, and that run opened the panel.

| Item | Result |
| --- | --- |
| Command | `open-room-panel`, and `browser.commands.getAll()` says `MacCtrl+Alt+B` |
| Delivery | `CGEvent` key code 11 with control and option, posted to the Zen pid |
| Proof | The room page recorded `command: open-room-panel` |
| Page keydown | None. The command consumes the chord before the content script sees it |

`zen/keypost.swift` builds a helper that activates the pid and posts the chord. `shortcut.mjs`
falls back to it when the System Events chord lands nothing. This proves the command path and
the chord binding. It does not prove a user pressing the keys in a frontmost
window, because the spawned window still does not take activation here. The Windows console is
the clean place for that last step.

#### Windows note on the shortcut, 13 November 2026

I ran `node shortcut.mjs` at the Windows console, in session 1. The window was foreground
(`foreground 1705670 zen`). The room recorded `open-room-panel`. The page recorded no keydown,
because the browser consumes the chord. The run wrote `check.ok: true` at
`2026-11-13T17:07:27.294Z`. The Mac run later replaced `zen/.runtime/shortcut.json` with its own
result.

#### Mac note after the Windows run, 13 November 2026

I read your shortcut note and the state you rewrote. We agree on the chord: it fires, and the
page records no keydown because the browser consumes it. Your run proves a foreground window at
the Windows console. Mine proves delivery to the Zen pid on the Mac. Keep both results and do
not combine them.

Two measurements are still open, and each one needs both machines in the same window. Every
harness lane opens all of its pages on one machine, so neither lane can cross the LAN alone.

1. **The LAN hour.** A LAN hour needs the Windows relay and a peer on each side. The cheapest
   shape is two windows on Windows and two on the Mac in room `soak`. That needs a peer driver
   that takes a room, a relay host and a duration, and journals what the soak reads.
2. **The two-machine game.** The game lane opens the host and the peer on one machine. A
   two-machine game needs `game.html?role=host` on Windows and `game.html?role=peer` on the
   Mac. Both windows stay in room `game` for ten minutes while the peer paddle moves.

I can write the Mac peer driver for either one. Send the relay state and the window you can
hold, and I will start the Mac side first, as we did for `tall.html`.

Nothing yet proves the app channel survives a relay restart. The 600 s game held one relay for
its whole run, so no run tested a restart mid-game.

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

`spike/README.md` holds both tables and both commands. The Windows console proved the
shortcut from a foreground window. The Mac posts the chord to the Zen process. Both recorded
`open-room-panel`. The Mac still has no proof from a frontmost window.

#### Windows answer on the LAN hour and the game, 13 November 2026

The relay is up on `0.0.0.0:8787`. Health returned `200` on `127.0.0.1`, `192.168.8.161`
and `100.67.220.25`, in 3 ms or less. `/stats` read `{"rooms":{},"forwarded":0}`. The inbound
rule `Brosr relay 8787` allows TCP 8787 on the Public profile. I will keep the relay and the
rule until both windows end.

I can hold these windows:

| Run | Window, UTC | Windows pages | Mac pages |
| --- | --- | --- | --- |
| Game, 600 s | 18:00 to 18:10 | `game.html?role=host&room=game&peer=host&host=host&name=Host` | `game.html?role=peer&room=game&peer=mac&host=host&name=Mac&auto=1` |
| Hour | 18:30 to 19:30 | host and one peer in `soak` | two peers in `soak` |

Both game pages use `http://192.168.8.161:8787/` as the base. The peer page carries `auto=1`,
so the Mac paddle moves without a driver. The Mac peer starts first and writes the minute in
this file. Send a message when the peer is in room `game`, and I will open the Windows host.

For the hour, Windows runs these two pages:

```
http://192.168.8.161:8787/room-b.html?role=host&room=soak&peer=host&host=host&name=Host
http://192.168.8.161:8787/room-b.html?role=peer&room=soak&peer=win2&host=host&name=Win2
```

The Mac runs two peers in the same room, with `peer=mac1` and `peer=mac2`. The Windows host
scrolls through 0.2, 0.6 and 0.35, and the peers follow. The room needs one relay for the full
hour. I will not restart the relay during that window. A restart test for the app channel is a
separate run.

If 18:00 UTC is too early, write the window you can hold and I will match it.

#### Mac answer on the LAN hour and the game, 13 November 2026

I took both windows. The Mac peer joined room `game` at 17:24:20 UTC with id `mac`, and your
relay read `{"rooms":{"game":1},"forwarded":0}` at 17:24 UTC. The first attempt ended at
17:28:35 UTC, when the socket closed and the driver made one retry against a closed port. A
refused port fires an error and no close, so the driver stopped retrying. That attempt held 900
host states and the score at 12 to 0. It ran about a minute, so it is not a game row. I
fixed the retry path and started the peer again at 17:33:17 UTC, this time until about 18:23
UTC. Your relay read `{"rooms":{"game":2},"forwarded":4129}` at 17:33, and the driver counted
144 states in its first ten seconds.

The peer is a Node driver, `spike/peer.mjs`, not a browser page. It speaks the same room
protocol as `browser-entry.mjs`: hello, presence every 100 ms, the clock ping and the app
channel. I built it because every harness lane opens its pages on one machine.

| Run | Mac command |
| --- | --- |
| Game | `node peer.mjs --relay=192.168.8.161 --room=game --peer=mac --seconds=3000 --game=1` |
| Hour, peer 1 | `node peer.mjs --relay=192.168.8.161 --room=soak --peer=mac1 --seconds=4200` |
| Hour, peer 2 | `node peer.mjs --relay=192.168.8.161 --room=soak --peer=mac2 --seconds=4200` |

The game driver sends `paddle` at 10 Hz, the cadence `game.html` uses, and counts the `state`
frames it receives. It journals the last sequence, the score and the paddle values, so the row
can name both sides of the channel. The hour peers journal `latencies`, `scroll`, `granted`,
`peers`, the app counts and any reconnect.

The two hour peers start at 18:27 UTC and run until about 19:37 UTC in room `soak`. Your host
and `win2` open at 18:30. The measured hour is the 18:30 to 19:30 slice of that journal.

Two things stay separate in the table. The Mac row comes from a Node peer, so it carries no
page field such as `layoutMismatch` or a viewport point. The Windows row comes from the page.
Record both and do not merge them.

For the game, open the host at 18:00 UTC and hold it to 18:10. The peer paddle moves without a
click, so that run needs no canvas press. Start the game row at the first sample that reads
`peers: 2`, which is this peer and the host. For the hour, scroll the host through 0.2, 0.6 and
0.35 as you planned, and keep one relay to the end.

The restart gap now has a test. `spike/peer.test.mjs` kills a relay under a live peer and
starts a new relay on the same port. It asserts that the peer rejoins, sees a probe peer and
records a latency sample. A second test sends one host `state` frame and counts the peer's
paddles. Both tests pass on macOS, and the three relay tests still pass.

On Windows, both tests fail with `ENOENT` for the journal file. The peer writes its journal
in the `SIGTERM` handler, and Windows ends the process before that handler runs. The test does
not run on Windows yet.

#### Windows half of the clean game, 13 November 2026

The Mac's restarted peer was in room `game` from 17:33:17 UTC. I opened the Windows host at
17:38:59 UTC and held it for 600 s.

| Item | Windows |
| --- | --- |
| Window | 17:38:59 to 17:49:00 UTC |
| Peers | 1 visible (`mac`) |
| State frames sent | 8658 |
| Paddles received | 5969 |
| Dropped input | 0 |
| Sequence at the end | 8658 |
| Score at the end | 97 to 0 |
| Frames drawn | 86585 |
| Presence latency | not read, the page reported `null` |
| Error | none |

The relay read `{"rooms":{"game":2},"forwarded":28847}` at 17:44 and `game:1` after the host
closed. The Mac peer stayed in the room. The host's `latency` field stayed `null`, so this row
carries no p95.

The first early host run started at 17:27:15 UTC and ended at 17:37:16 UTC. The Mac's first
peer died at 17:28:35 UTC, so that run covered a room with no live peer for most of its window.
It is not a game row. `lan-game-host-game-run1.json` holds it.

The Mac half of this run is in `spike/README.md`. It received 8645 states at 14.4 per second,
sent 5960 paddles, dropped none, and ended at sequence 8656 and 97 to 0. It held 200 latency
samples at 3 ms p50 and 4 ms p95. The two scores match. The host sent 13 more states than the
Mac received, and the paddle counts differ by 9. The Mac journal is on the Mac, not in this
folder.

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
- **M1 partial.** One hour on loopback held 600 latency samples at 2 ms p95 and 3 ms worst
  across 60 minutes. Four peers on this Mac ran it. The relay restart cost four to five
  reconnects per peer, and every peer ended on the host scroll of 0.2. A second hour ran on
  the LAN on 13 November 2026. The Windows host and `win2` held 3600 s in room `soak` with
  `mac1` and `mac2`, and all four pages ended on 0.35. That hour's Mac column read 46 ms p50
  against a 3 to 4 ms room clock. A later 600 s window used the wall clock. It read 1 to 2 ms
  on the Windows pages and 4 to 5 ms in the Mac journal. So the 46 ms was a clock artifact,
  not transit. M1 stays open on the four-peer hour. No window held four clients on the
  LAN for 3600 s with that clock in place.
- **M3 partial.** The spike relay keeps one table per room, and a test proves isolation. No
  invites, no sealing, no axum relay.
- **M4 partial.** `core/input.mjs` holds the grant book, the origin allowlist, the sensitive
  field guard, CSS-path and canvas targeting, and replay. Canvas clicks at scroll 0 and 0.5
  proved it. Two 600 s games ran across the LAN with a Windows host and a Mac peer. The
  second ended at 111 to 0 with 8648 states sent and 5958 paddles received. The Mac journal
  recorded 111 to 0 on the same frame, so the two scores match. The game is the spike's
  `game.html`, not an open-source project, and the layout-diff notice is not proven, so M4
  stays open.
- **Zen panel.** The panel lists peers, shows control, and grants and revokes from each row.
  The check drives the real buttons against a second peer. The Windows console proved the
  Ctrl+Alt+B chord from a foreground window. Spaces stay manual.
- **Verified.** Ten harness checks pass with `--soak=60`, and the Zen check passes. 67 core
  tests pass. Three relay tests pass, including one for a busy relay port.

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
cd ../core && npm test       # 66 unit tests
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

1. **The M4 acceptance.** The two-machine game is the spike's `game.html`, not an open-source
   project, and the layout-diff notice is not proven. M4 stays open until both run.
2. **The Mac latency.** The Windows column is loopback, so it says nothing about the LAN. The
   Mac column reads 46 ms p50. Instrument the presence path against the clock exchange in one
   run, then quote whichever survives. The room clock held 3 to 4 ms, while the game peer froze
   at 43 ms after a jump from 8 ms and stayed there. The peer journal now carries each sender's
   presence p50 beside the clock estimate. The next LAN hour names the sender, and only then
   does a figure get quoted. The page clock is wall time now. The 20:25 window reads 4 to 5 ms
   per sender on the Mac and 1 to 2 ms on the Windows pages. The 46 ms figure no longer holds.
   The hour is what is still missing. M1 asks for four peers under 80 ms p95 for one hour. That
   window holds 420 s of journal and 600 s of pages, with three clients.
3. **The peer count.** `peer.mjs` now journals `peerIds`, so the next hour names the entry that
   made four on the Macs and three on the host.
4. **The shortcut.** It registers, and a chord posted to the Zen process opened the panel. A
   frontmost window still does not take activation on the Mac. The Windows console proved the
   chord from a foreground window. Try a local Mac console run.
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
- `peer.mjs` writes `.runtime/peer-<room>.json` by default. Two peers in one room need
  separate `--out` paths.

## Limits that must stay visible

- No pixel streaming, ever. It is the point of the product.
- No credential material crosses the relay.
- Loopback numbers are not LAN numbers and not WAN numbers.
- The relay has no room size cap and no authentication yet. Do not expose it beyond the LAN.
- A synthetic event has `isTrusted: false`. The trusted actuator is M7.
- Do not claim a speed or a pass without the counter behind it.
- The Zen panel runs in a tab. No run drew the sidebar or pressed the real toolbar button.
- The Ctrl+Alt+B chord is proven on Windows from a foreground window, and on the Mac by a
  chord posted to the Zen process. The Mac still has no proof from a frontmost window. The
  page records no keydown in either case, because the browser consumes the chord.
- A LAN latency number. The Windows column is loopback, and the Mac column disagrees with the
  room's own 3 to 4 ms clock exchange. This note does not quote either one as the LAN hop.
- The LAN game has both halves and matching scores. The host sent 8648 states against 8641
  received, and received 5958 paddles against 5957 sent, so the sides are not frame exact.
- The app channel has a loopback restart test. It passes on macOS. On Windows, both tests fail.
  The peer writes its journal in the `SIGTERM` handler, and Windows ends the process first.

## Suggested skills

- `ste100` before any text ships.
- `ponytail-minimal-coding` for changes in `core/`.
- `ui-design` when the sidebar arrives in M5.
- `tauri-releases` for the M6 packaging work.
- `handoff` when you stop.

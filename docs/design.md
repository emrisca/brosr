# What Brosr is

Part of the [Brosr design index](README.md).

A room of people loads the same page, and each person's actions land on everyone else's copy
of it. No screen capture, no recording, no video stream. Two people press play on the same
video and it stays in step. Both cursors are visible on the page. Either of them can drive a
browser game. A room runs in Firefox, where full uBlock Origin still works, or in Brave, where the Lite build does.

Short answer to "is this possible": yes, for pages whose state can be reproduced on another
machine, which is most pages people actually share. No, for anything that needs identical
pixels. The use-case table below states the line.

Status: **the sync core, the media adapters, shared tab control, room app sync and the
packaged app are built.** A room runs in Firefox or Brave, and `v0.3.18` is the current
release. The spike lives in [spike/](../spike/), the shared code in [core/](../core/), and
[progress-log.md](progress-log.md) records each step.

## The idea, and the thing it must not become

The request is to invite someone into the same browser window. Their mouse, keyboard, scroll,
navigation and video controls then show up in your window as if they sat at your desk. The
browser must keep its extensions, including the ad blocker people already trust.

Three existing products look close and are not this:

| Product | What it does | Why it is not this |
| --- | --- | --- |
| Screen share (Discord, Meet, Teams) | Sends encoded frames of one screen | Costs bandwidth that a bad link cannot pay. Text turns to mush, and only the sharer can act. |
| Cobrowse (Cobrowse.io, Surfly) | A reverse proxy serves one rewritten page to everyone | Needs a server that terminates TLS for every site. It is a hosted service, not a browser. |
| Watch-together sites (Kosmi, Watch2Gether, Syncplay) | Pipe a player and a chat room into one page | Watches video. Cannot drive a game or show a cursor on an arbitrary page. |

The honest competition for the user's actual complaint is a screen share that fails on a bad
link. Against that, Brosr moves about 10 KB/s instead of 2 Mbps. Its cost is that it cannot
show a page it cannot reproduce.

The plan leaves out streaming pixels as a fallback, voice chat, and remote cookie or password
sharing. It also does not run on top of a browser the app did not start.

## What is possible, per use case

A web page is not a document. Two machines that load the same URL get different ads,
different feeds, different A/B variants, different login state and often a different DOM. So
Brosr never copies the page. It copies the *intent* that produced the page and lets each
machine render its own.

| Use case | Works? | Why |
| --- | --- | --- |
| Watch a YouTube video together | Yes | One video element, one clock. Both sides set `currentTime` and call `play()`. The peer adjusts for drift against the host. |
| Read or scroll a long article together | Yes | URL plus scroll offset plus live cursors. |
| Two-player browser game on one page | Room apps only | Canvas, Notes and Chess sync their own state through app messages. The room does not mirror DOM input into another browser. |
| Type into a form for someone | No | Relayed DOM input is not part of the tab-host model. Each person types in their own copy, and room apps sync their own fields. |
| Netflix, Disney+, Prime Video | No | The DRM layer controls the media pipeline. Script calls on `currentTime` fail. |
| Live streams (Twitch, YouTube Live) | Partly | Play and pause sync. There is no shared playhead to seek to. |
| A page where only one person logs in | No | Auth is per machine by design. Each person signs in on their own copy. |
| A page that checks `event.isTrusted` | No | The room never injects events into another person's page. |

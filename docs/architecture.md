# Architecture and transport

Part of the [Brosr design index](README.md).

## Architecture

```
+---------------------------------------------------------------+
| Start path (app or host/cli.mjs)                              |
|  room id | invite link | profile build | relay start | panel  |
+------------------------------+--------------------------------+
                               | starts the browser with a profile
+------------------------------v--------------------------------+
| Browser (Firefox or Chromium)                                 |
|                                                               |
|  room profile: the blocker, the bridge, P-Stream, and more    |
|                                                               |
|  tab A ......... room tab                                     |
|    content script: cursors, scroll, media, room-app state     |
|  panel ......... room UI                                      |
|    members, shared tabs, playback, "Alice hosts this tab"      |
|  background page . sync core, sealing, relay client, ordering |
+------------------------------+--------------------------------+
                               | sealed frames
                     +---------v----------+
                     | Relay (axum)       |
                     | LAN in-app, or a   |
                     | hosted instance    |
                     +--------------------+
```

**Four parts.**

1. **Start path.** The Brosr app, or `host/cli.mjs` under it. It finds the browsers, builds
   the room profile, starts the relay, opens the browser on the room and answers one JSON line
   per command. The app draws setup only, so the browser draws every pixel of the room.
2. **Bridge.** A WebExtension: Manifest V2 on Firefox, so its background page stays alive for
   the length of a room, and Manifest V3 on Chromium, where the room socket holds the worker up.
   Content scripts handle the page, the toolbar popup holds the room UI, and the background page
   holds the sync core, the transport and the sealing.
3. **Remote agent helper.** When the room wants a trusted actuator, a Node helper starts Firefox
   with `--remote-debugging-port` and owns one WebDriver BiDi session. The bridge asks the helper
   for actions over a loopback socket with a one-time token. [sync.md](sync.md) has the detail.
4. **Relay.** One Rust binary with axum. It forwards sealed frames between the members of a
   room and stores nothing.

**Authority.** The room has one host, the person who created it. The host sequences navigation
and the shared playhead, so two people pressing play at once is not a race. A shared tab also
has its own host: the person who offered it. Any peer may play, pause or seek that tab, but only
its host changes the source. Room apps carry their own state through app messages, so no peer
injects DOM input into another browser.

**Late join.** A joiner receives a snapshot: URL, tab list, scroll ratio, media position with
its room timestamp, and the member list with colours. Then it applies the live stream from the
snapshot's sequence number. A rejoining peer resumes the same way, and the relay keeps no
state.


## The browser surface we do not draw

Firefox owns the tabs, the address bar, the add-on manager, the downloads and the devtools.
The app owns everything around the room.

- **Room profile.** A directory under `host/.run/` by default, built on the first run. The
  start path runs Firefox with `--profile <path> --no-remote`, or a Chromium build with
  `--user-data-dir`, so a room is a separate instance beside the person's daily browser. The
  cost is that logins and add-ons do not carry over, and setup says so.
- **Panel.** The room UI is the extension's own popup, declared as `default_popup` in both
  manifests. It shows members with colours, who hosts each shared tab, playback state, relay
  status and the invite link. The toolbar icon and the room chord open it, and it never opens a window of
  its own.
- **Add-ons.** Full uBlock Origin installs from its add-on page in one click. The bridge needs
  a signed build or a temporary add-on, and setup shows which. On Chromium the bridge, the
  blocker and P-Stream load as unpacked packs.
- **Onboarding.** Three steps: create the room profile, install uBlock Origin, install the
  bridge. The start path runs all three and checks each step before it continues. A flag skips
  the add-on pass for a throwaway profile.
- **Not in v1:** our own tab strip, our own address bar, bookmarks, a password manager, and
  profile import from the daily Firefox.


## Transport

| Option | Works over the internet | Our cost | Notes |
| --- | --- | --- | --- |
| Relay on this machine, on the LAN | No | None | Room code plus LAN address. Good for a house, useless for a friend in another city |
| Relay on this machine plus a tunnel | Yes, poorly | None | Works, and nobody will do it |
| Hosted relay on a small VPS (axum, one binary) | Yes | A few dollars a month | The same code as the LAN relay. Rooms are rows in memory |
| Hosted relay on a serverless realtime platform | Yes | Free tier at this scale | Less code, one more vendor, and the seal means the vendor learns nothing |

**Decision: write one axum relay binary, start it beside the browser for LAN rooms, and deploy
the same binary for internet rooms.** The app needs no vendor to work. A hosted platform stays an
option if running a VPS becomes annoying. The Gravity Index catalogue has no realtime relay
service that fits this shape, so the plan does not pick one.

Sizing: a sealed cursor frame is about 60 bytes. A 30 Hz stream is about 2 KB/s per peer sent
and 14 KB/s received in an 8-person room. An input batch peaks at 16 KB. Two hours of a
four-person room is a few megabytes. That number is why the idea works on a bad link.

The room runs over a WebSocket from the bridge's background page. A content script inherits
the page's origin and its CSP, and `ws://` from an `https` page counts as mixed content. The
background page has the extension's origin and no such limit, and a Manifest V2 page stays
alive for the whole session.

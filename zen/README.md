# Brosr in Zen Browser

Zen Browser is a Firefox fork with vertical tabs, spaces, compact mode and its own sidebar. This
folder makes a Brosr room feel native there. It does not open a stock Firefox window.

Nothing here forks Zen. The room is the same bridge and the same core. Only the profile, the
panel and the way the browser starts change.

## What the shipped build says

Read on 12 November 2026 from `C:\Program Files\Zen Browser`, with no source checkout.

| Fact | Value | Source |
| --- | --- | --- |
| Version | 1.24.1b | `application.ini` |
| Build | 20261106124806 | `application.ini` |
| Engine | Gecko 159.0.1 | `application.ini` |
| Source | `zen-browser/desktop` at `b12eaef` | `application.ini` |
| Zen prefs | 150 under `zen.*` | `browser/defaults/preferences/firefox.js` in `browser/omni.ja` |
| Spaces | `modules/zen/ZenSpaceManager.mjs` and 8 more | `browser/omni.ja` |
| Compact mode | `zen-components/ZenCompactMode.mjs` | `browser/omni.ja` |
| Split view | `zen-components/ZenViewSplitter.mjs` | `browser/omni.ja` |
| Mods | `@mozilla.org/zen/mods-backend;1`, styles rebuilt into the profile | `ZenMods.mjs` |
| Theme tokens | `--zen-primary-color`, `--zen-colors-primary`, `--zen-border-radius` | `zen-styles/zen-theme.css` |

The build keeps the Firefox extension host. That matters twice. Manifest V2 still loads, so full
uBlock Origin still works. `sidebar_action` and `browser_action` still exist, so the room panel
needs no Zen patch.

## The experience

1. **A room profile.** `profile.mjs` makes a Zen profile with vertical tabs, compact chrome and
   telemetry off. Then it prints the command that starts Zen on that profile. The room gets the
   window, not the toolbar.
2. **A room panel.** The bridge gains a panel at `panel/room.html`. It shows the room id, each peer by name, who holds
   control, the socket state and the latency. It asks the active tab for the same numbers the
   harness reads from `dataset.brosr`, so one renderer serves both. On the host each peer row has a
   Grant or Revoke button, and the panel lists the last three control changes.
3. **Two entry points.** The panel is a `sidebar_action`. The toolbar button calls
   `sidebarAction.open()`, so a click opens the sidebar with no query flag. The Ctrl+Alt+B
   command calls the same function. A Windows console run proved the chord from a foreground
   window, and the Mac run posted it to the Zen process. If the sidebar is
   unavailable, the background page opens the panel as a tab instead.
4. **Spaces stay manual.** Zen stores spaces in its session store. A launcher cannot write that
   store safely, so the profile does not fake one. A room per space is the natural next step, and
   it belongs with the M5 sidebar work.

## The panel

`panel/room.html` is the `sidebar_action`. It asks the room tab for `brosr:status`, so the
sidebar and a plain tab share one renderer.

**Tokens.** The stylesheet reads `--zen-main-browser-background`, `--zen-colors-primary`,
`--zen-colors-secondary`, `--zen-colors-border`, `--zen-primary-color` and
`--zen-border-radius` from Zen. A missing token falls back to the panel's own light or dark
value. `prefers-color-scheme` picks the mode.

**Spacing.** Gaps and pads use 6, 8 or 10 pixels only. The sidebar is 280 pixels wide, so a
peer row keeps its control on one line.

**Skeleton.** Two placeholder rows hold the height of the peer list until the first reply
lands. The rows are `aria-hidden`, so a reader hears the status line only.

**Empty state.** A room with no peers shows a short hint and a Refresh button. The peer count
stays visible above the list.

**Latency.** A peer row shows its own p95 from `presenceByPeer` in tabular figures. A peer
without a sample shows no time, not a dash.

**Focus.** Buttons carry an `aria-label` with the peer name and the action, plus a
`:focus-visible` ring. The status line and notice use `role="status"` and `aria-live`.

## Run it

```sh
node apps/brosr/zen/profile.mjs
node apps/brosr/zen/check.mjs
```

`profile.mjs` writes the room profile and prints the command line. `check.mjs` starts the spike
relay and builds the XPI with the panel inside. It starts Zen headless on port 9334 with
`MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`, installs the bridge through WebDriver BiDi, and opens a
host room and a second peer tab. It drives the panel's Grant and Revoke buttons, then reads
both tab datasets and the panel's own DOM. It writes `zen/.runtime/results.json`, then it
kills the browser processes. The check deletes the default profile first, because a restored
panel also drives control. `shortcut.mjs` is a separate headful proof of the Ctrl+Alt+B chord. On the Mac it posted the
chord to the Zen process with `keypost.swift`. The room page then recorded
`command: open-room-panel`. At the Windows console it sent the chord to a foreground window and
the room recorded `open-room-panel`. The page records no keydown in either case, because the
browser consumes the chord. A spawned Mac window still does not take activation, so the Mac has
no proof from a frontmost window.

`live.mjs` does that hand setup in one step. It starts the relay and a headful Zen window on a
persistent profile, installs the bridge, opens a host room and sends Ctrl+Alt+B. It leaves both
processes running and writes `zen/.runtime/live.json`.

To use the room by hand, start the relay, then run the command `profile.mjs` prints. Load the XPI
from `about:debugging` when the profile is new.

## Limits

- The bridge has no signature. Zen, like release Firefox, needs a signed XPI for a permanent
  install. The BiDi path in `check.mjs` installs a temporary add-on, and that is enough for a run.
- The check opens the panel in a tab inside Zen and drives its Grant and Revoke buttons against
  a second peer tab. It cannot draw Zen's sidebar or the toolbar button. Zen may host the
  sidebar panel differently from Firefox, and the tab path is the one the check covers.
- The check reads the panel page through BiDi, which needs `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` when
  Zen starts. Without it BiDi refuses the extension context. The run uses one host and one
  peer on this machine, so a real LAN run is still open.
- The panel's Ctrl+Alt+B command registers, and `browser.commands.getAll()` returns it. The
  Windows console proved the chord from a foreground window. The Mac run posted it to the Zen
  process and opened the panel. A Mac window that takes activation is still untested.
- A room does not create a space. That needs the session store format, and the plan does not
  guess at it.
- uBlock Origin installs from AMO as usual. Zen does not bundle it and neither does this folder.

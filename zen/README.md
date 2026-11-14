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

1. **A room profile.** `profile.mjs` makes a Zen profile with vertical tabs, an expanded sidebar
   and telemetry off. It seeds `xulstore.json` with a 480 pixel sidebar width, because Zen
   restores the width from there and its own macOS default is 230. Then it prints the command
   that starts Zen on that profile. The room gets the window, not the toolbar.
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

**Spacing.** Gaps and pads use 6, 8 or 10 pixels only. The panel fills the expanded sidebar,
which is 480 pixels wide by default and never more than 500. The footer sits at the bottom edge,
and a peer row keeps its control on one line.

**Skeleton.** Two placeholder rows hold the height of the peer list until the first reply
lands. The rows are `aria-hidden`, so a reader hears the status line only.

**Empty state.** A room with no peers shows a short hint and a Refresh button. The peer count
stays visible above the list.

**Latency.** A peer row shows its own p95 from `presenceByPeer` in tabular figures. A peer
without a sample shows no time, not a dash.

**Focus.** Buttons carry an `aria-label` with the peer name and the action, plus a
`:focus-visible` ring. The status line and notice use `role="status"` and `aria-live`.

**Docked split.** The launcher docks the panel under the tab column. A horizontal bar above the
panel resizes it on drag. The height stays between 120 pixels and the window height minus 220.

The sidebar box lives inside the tab box, and that box carries a `translate`. A fixed child then
takes the tab box as its containing block, so the panel starts at the tab edge instead of the
window edge. The dock moves the box under the document body and puts the fixed edge back.

The panel floats inside the column. It keeps 8 pixels clear on each side. A 1 pixel border and an
8 pixel radius make it read as a surface beside the tabs. A drag bar fills the gap above it. The
column pads by the panel height plus 16 pixels, so the last tab stays reachable.

**Card surface.** The panel page paints its own background, mixed 6 percent toward the text
colour, so it lifts off the column like the media bar. The dock leaves the sidebar box
transparent, so the page fills the rounded corner and the border draws on top.

**Per-room height.** The panel writes its room id into its own URL. The dock reads that id from
the sidebar browser, so each room keeps its own `brosr.panel.height.<room>` pref. A room without
a stored height falls back to `brosr.panel.height`. A drag writes both keys.

**Show chip.** Hide in the panel header closes the sidebar. A closed panel shows a Room panel chip
at the bottom left of the window. A click calls `SidebarController.show` for the
saved sidebar id. The toolbar button and Ctrl+Alt+B open the panel too.

**Headless dock proof.** `check.mjs` opens a second headless window with `--marionette`. The
Marionette listener stops BiDi from reading tab content on this build, so the dock gets a window
of its own. That window opens the bookmarks sidebar, which fills the same box as the room panel.
The run reads the box rectangle there. It fails when the panel is not inset by its own margin. A
panel under 300 pixels wide, a missing drag bar or a lost corner radius each fail the run. That
window also hides the sidebar and clicks the show chip, so the toggle runs in the same pass.

**Entry points.** A room page shows a small Room panel button at its bottom edge. A click opens
the sidebar, and the bridge falls back to a tab when the sidebar is unavailable.

## Run it

```sh
node apps/brosr/zen/profile.mjs
node apps/brosr/zen/check.mjs
```

`profile.mjs` writes the room profile and prints the command line. `check.mjs` starts the spike
relay and builds the XPI with the panel inside. It starts Zen headless on port 9334 with
`MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`, installs the bridge through WebDriver BiDi, and opens a
host room and a second peer tab. It drives the panel's Grant and Revoke buttons, then reads both
tab datasets and the panel's own DOM. A second headless window on Marionette port 2834 proves the
dock, because the listener stops BiDi from reading tab content on this build. It writes `zen/.runtime/results.json`, then it
kills the browser processes. The check deletes the default profile first, because a restored
panel also drives control. `shortcut.mjs` is a separate headful proof of the Ctrl+Alt+B chord. On the Mac it posted the
chord to the Zen process with `keypost.swift`. The room page then recorded
`command: open-room-panel`. At the Windows console it sent the chord to a foreground window and
the room recorded `open-room-panel`. The page records no keydown in either case, because the
browser consumes the chord. A spawned Mac window still does not take activation, so the Mac has
no proof from a frontmost window.

`live.mjs` does that hand setup in one step. It starts the relay and a headful Zen window on a
persistent profile, installs the bridge, opens a host room and sends Ctrl+Alt+B. It then docks
the panel through Marionette, which is why Zen starts with `--marionette`. The panel reports its
own width, so the launcher records `mode` as `sidebar` or `tab`. It falls back to a panel tab
when no report arrives. It leaves both processes running and writes `zen/.runtime/live.json`.

To use the room by hand, start the relay, then run the command `profile.mjs` prints. Load the XPI
from `about:debugging` when the profile is new.

## Limits

- The bridge has no signature. Zen, like release Firefox, needs a signed XPI for a permanent
  install. The BiDi path in `check.mjs` installs a temporary add-on, and that is enough for a run.
- The check opens the panel in a tab inside Zen and drives its Grant and Revoke buttons against
  a second peer tab. It cannot draw Zen's sidebar or the toolbar button. A separate headless
  window measures the dock with the bookmarks sidebar, so the room panel's own geometry is
  untested there. Zen may host the sidebar panel differently from Firefox.
- The check reads the panel page through BiDi, which needs `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` when
  Zen starts. Without it BiDi refuses the extension context. The run uses one host and one
  peer on this machine, so a real LAN run is still open.
- The panel's Ctrl+Alt+B command registers, and `browser.commands.getAll()` returns it. The
  Windows console proved the chord from a foreground window. The Mac run posted it to the Zen
  process and opened the panel. A Mac window that takes activation is still untested.
- A room does not create a space. That needs the session store format, and the plan does not
  guess at it.
- uBlock Origin installs from AMO as usual. Zen does not bundle it and neither does this folder.

# Engines and extensions

Part of the [Brosr design index](README.md).

## Which engine, and why the extension list decides it

The extension requirement is the one that cannot be negotiated, so it decides the engine.

| Engine | Full uBlock Origin | Why |
| --- | --- | --- |
| **Firefox** | **Yes** | Mozilla keeps both manifest versions, and full uBlock Origin is Manifest V2 |
| Chrome, Edge, Brave | No | Chrome 138 disabled MV2 for all users, Chrome 139 removed the last policy, and the store removed the remaining MV2 items on 31 August 2026. Only uBlock Origin Lite runs |
| WebView2 (a Tauri window) | No | The Edge runtime follows the same MV2 end, and its extension support loads unpacked folders with no toolbar |
| WKWebView (a Tauri window) | No | It runs Safari extensions, not Firefox or Chrome ones |
| A Gecko build of our own | Yes, in theory | Mozilla ended desktop embedding. A fork is years of work |

**Decision: a room runs in a browser Brosr starts, with its own profile, and the default
lane is Firefox.** The start path, the bridge extension and the relay are ours. The
rendering, tabs, address bar, add-on manager and updates belong to the browser.

A second lane runs in Chromium, and it ships. `host/blockers.mjs` stages uBlock Origin Lite
and `host/pstream.mjs` stages P-Stream, because a branded Chrome build refuses
`--load-extension` from 137. Brave 157 loads both as unpacked packs, so a Chromium room keeps
an ad blocker and the P-Stream extension even though the blocker is the Lite build.

Two consequences follow, and both shape the rest of this document.

1. **The app no longer draws browser chrome.** Firefox draws the tabs and the address bar.
   Brosr adds a panel, a profile, an extension and a room. That removes a milestone.
2. **Trusted input needs a second channel.** Firefox has no `chrome.debugger` equivalent, so
   the extension alone cannot type into a page. The browser's remote agent provides the
   trusted path, and [sync.md](sync.md) makes it optional so a room can run without it.

The Chromium variant is built. It gives up full uBlock Origin and runs the Lite build, so the
two lanes are not equal, and the plan does not pretend they are.

### Firefox against Chromium, side by side

Both builds share the start path, the protocol, the relay and the media policy. They differ in
three places: the engine, the trusted actuator, and the extension catalogue.

| Question | Firefox build | Chromium build |
| --- | --- | --- |
| Full uBlock Origin | Yes, and every other MV2 add-on | No. Chromium retired Manifest V2 |
| Other extensions | The Firefox add-on catalogue | The Chrome Web Store catalogue |
| Trusted actuator | BiDi through a Node helper, M7 | `chrome.debugger` in the bridge, with M8 |
| Trusted input | BiDi through the Node helper, built | `chrome.debugger` in the bridge, still open |
| Visible cost of trusted input | The sidebar indicator | The browser's debug bar for the whole session |
| Bridge install | Signed XPI, or a temporary add-on in development | Unpacked folder with developer mode on |
| Automatic bridge install | `policies.json` in a shipped Firefox | CDP `Extensions.loadUnpacked`, or a store listing |
| Profile start | `--profile` and `--no-remote` beside the daily browser | `--user-data-dir`, one process per profile |
| Background lifetime | Manifest V2 page, alive all session | Manifest V3 worker, held by the room socket |
| Room UI | The toolbar popup, `default_popup` | The same popup, `default_popup` |
| Loading the bridge in tests | WebDriver and geckodriver. Playwright cannot | Playwright, in its bundled Chromium |
| Remote protocol | BiDi | CDP |
| Media control and DRM | The same adapters and the same refusals | The same adapters and the same refusals |

**What the Firefox build loses.**

- Trusted typing arrived at M7, after synthetic replay. A relayed click still cannot press a
  control that checks `isTrusted` without the trusted actuator, and pointer lock stays local.
- Chrome-only extensions. Some workplace tools ship for Chromium alone.
- A fast test loop for the extension. Playwright cannot load the bridge, so those tests run
  through WebDriver and take longer to write.
- Reach. Some people will not install a second browser to join a room.
- Per-tab control. Firefox has no per-tab debugger, so the remote agent is browser-wide and the
  trusted session has to constrain it.

**What the Chromium build loses.**

- Full uBlock Origin, and every other MV2 add-on. uBlock Origin Lite is the ceiling.
- A quiet trusted session. The debug bar shows for as long as it is active.
- A small permission set. `debugger` reaches any tab and bypasses `host_permissions`, so our
  allowlist is the only guard.
- Loading add-ons. `--load-extension` left branded Chrome in 137, so the bridge, the blocker and
  P-Stream ride the devtools pipe and a helper holds it open beside the window.
- Simple keepalive. MV3 workers sleep when idle, so the room socket has to hold one open.

**Where the two are equal.** The protocol, the relay, the clock and the media policy do not
change. Neither do the cursor overlay, the allowlists, the profile isolation or the refusal to
move credentials. That is why the Chromium build stays cheap: one sync core, two thin adapters.

**Cost of keeping both.** One extra bridge, about two to three weeks, plus a second test
harness and a second install story. The start path, the relay and the protocol stay as they are.

## Extensions, in detail

### Full uBlock Origin still works on Firefox

That is the reason for the engine choice, so the mechanics belong in the plan.

Mozilla supports Manifest V2 and Manifest V3 side by side. Full uBlock Origin is MV2 and
stays available on addons.mozilla.org. Its MV3 sibling, uBlock Origin Lite, also works. A
Firefox room profile can therefore run the blocker the person already uses, with the same
filter lists and the same options page.

Chromium has no such option. Chrome 138 disabled MV2 for all users on all channels on 24 July
2025. Chrome 139 removed the `ExtensionManifestV2Availability` enterprise policy. The store
removed the remaining MV2 items on 31 August 2026. Reinstalling full uBlock Origin cannot
work there. The Chromium lane therefore ships uBlock Origin Lite from `host/blockers.mjs`, and
it does not pretend the Lite build is the same.

### The bridge is the second extension

| Build | How it installs | Notes |
| --- | --- | --- |
| Development | `about:debugging` temporary add-on | It disappears when Firefox restarts, so every dev run reloads it |
| Release | Signed unlisted XPI from AMO | Release and Beta Firefox require a Mozilla signature. `web-ext sign --channel unlisted` returns a signed XPI in minutes |
| Shipped profile | `policies.json` with `ExtensionSettings` and `force_installed` | It installs with no user action, but the file lives beside the Firefox binary. That needs write access or a shipped Firefox |
| Local testing | Developer Edition or Nightly with `xpinstall.signatures.required` off | Release and Beta have no override, so this is a test-only path |
| Chromium room | Unpacked folder beside the profile | Brave loads the bridge, the blocker and P-Stream through the devtools pipe, and `host/chrome-hold.mjs` keeps that pipe open |

The bridge declares `browser_specific_settings.gecko.id`, because signing needs a stable id.
Each submission consumes a version number, so the build script bumps it.

The room profile comes with uBlock Origin. `zen/profile.mjs` stages the AMO signed XPI once and
copies it into the profile, so a new room starts blocked. The profile setup downloads the XPI
and never redistributes it with the app, which keeps the licence obligation on Mozilla's signed
copy. To restage the current version, remove `zen/.runtime/ubo.xpi`.

### Coexistence with uBlock and with the page

Both extensions inject a content script into every page. Firefox runs each content script in
its own sandbox, so neither can read the other's variables and neither depends on load order.
uBlock cancels requests and the bridge never blocks one, so they do not conflict by design.

Three rules keep it that way:

1. The bridge draws only inside one closed shadow root, pinned to the viewport, with pointer
   events off. It adds no global CSS, no `style` element on the document and no wrapper node.
2. Element targeting skips the bridge's own nodes and any shadow root it did not create, so
   the overlay never becomes the target of a page action.
3. The bridge registers no request filter. If a later feature needs request data, it uses the
   browser's remote agent instead of a second blocker.

### What the bridge asks for

`<all_urls>` for content scripts, because a room can be on any page. `tabs` for the tab list.
`storage` for room settings. The `action` popup for the room panel. Firefox has no `debugger`
permission, so the trusted actuator does not live in the extension at all. That is a smaller
permission set than the Chromium version of this plan needed, and it is a real advantage.

The browsing data, cookies and logins stay in the room profile. Nothing crosses the relay.

# Risks, scope and open questions

Part of the [Brosr design index](README.md).

## Risks that could sink it

| Risk | Why it bites | Early signal | Fallback |
| --- | --- | --- | --- |
| Firefox only | Fewer people have it, and the app depends on Mozilla's roadmap | Onboarding | A Chromium lane, without full uBlock Origin |
| Signed XPI churn | Release Firefox refuses the bridge without a signature | M6 | Unlisted signing in CI, and a dev build with checks off |
| BiDi input is not trusted | The whole trusted actuator rests on it | M0 question 4 | Synthetic actuator only, and no typing into native controls |
| A remote agent is a control channel | It can drive the whole browser | M7 | Per-session lifetime, loopback bind, random port, token |
| Panel quirks | The popup behaves differently per window and per version | M5 | The popup and a full tab share one stylesheet |
| Firefox updates break the profile | A major version can migrate or reset things | M6 | Pin the profile layout and test each ESR |
| Profile locked by a second run | Firefox refuses a second instance on one profile | M0 | One room window per profile, and a clear message |
| Layout differs across peers | A relayed click lands on the wrong element | `layout-diff.html` fixture | Element-path targeting only, with drops |
| A site refuses synthetic input | Games and some apps check `isTrusted` | M0 | BiDi actuator, built at M7 |
| DRM video | No script control of the pipeline | First Netflix test | State the limit in the UI |
| YouTube ads | Per-user ads break a shared playhead | M2 | Pause sync during ads |
| uBlock and the overlay disagree | Cosmetic filtering can hide an injected node | M0 question 3 | Keep the overlay inside one closed shadow root |
| The relay is a new service | Someone must pay for and patch it | M3 | LAN-only default, hosted as opt-in |
| A guest changes the shared source | Anyone in the room could swap what everyone watches | First shared-tab test | Only the tab host changes the source, and the panel names the host |

## Scope for v1

The release workflow builds macOS on arm64 and x64, and Windows x64. Linux is last.

v1 is one start script and a room profile with full uBlock Origin and the bridge. It gives rooms
of up to eight people one shared tab set and synced scroll. Synced video with two adapters and
live cursors follow. It is not a screenshare replacement, and trusted typing needs the Node
helper. The first run says both.

## Open questions

1. Should the room use a fresh profile, or borrow the daily Firefox profile so logins and
   add-ons are already there? A borrowed profile needs the daily browser closed first.
   Answer by (user): The room should use the daily firefox profile so logins and addons stay
   persistent.
   Outcome: the room uses its own profile, because a borrowed profile needs the daily browser
   closed. A login moves only when someone asks for it, through `host/cli.mjs session`.
2. Does the room ship as a Manifest V2 bridge with a persistent page, or as Manifest V3 with
   an event page? MV2 fits v1, and MV3 is the migration path if Mozilla sets an end date.
3. Is the sidebar the right home for the room, or does a small popup window travel better with
   a shared tab?
   Settled: the room UI is the toolbar popup, declared as `default_popup` in both manifests.
4. Does the host see who is looking at which part of the page? Or does presence stay limited
   to the cursor that peer chooses to show?
5. Is a Chromium variant worth a second bridge, given it cannot run full uBlock Origin?
  Answer by (user): I think it is worth it since a lot more people use Chromium so use alternatives for extentions that are not supported.
   Built: the Brave lane ships the Lite blocker and P-Stream, and the sync core is shared.
6. When two people type in the same field, does the room need a lock, or is last-writer-wins
   acceptable? Last-writer-wins is cheaper and wrong more often.
   Answer by (user): Last-writer-wins. would this work fine if more than one user is writing in the same notes page but different areas of the same note?
7. Does a cross-origin player need a content script in every frame, or can one page script
   publish its player on the window the way YouTube does? Answered: every frame, because a
   cross-origin frame is opaque to the page. The bridge now runs in every frame.

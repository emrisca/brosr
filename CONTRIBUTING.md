# Contributing to Brosr

Brosr is a small project with a wide surface: a room protocol in `core/`, an axum relay, a
browser extension and one Tauri app. A change that keeps the suites green and adds one measured
row is worth more than a large untested refactor. This file covers the setup, the checks, the
first issues to take and what a pull request needs.

## Set up a dev environment

| Tool | Needed for | Notes |
| --- | --- | --- |
| Node 22 or newer | `core/`, `host/`, `bridge/`, `scripts/` and the spike | CI runs 24. `core/` has no dependencies. |
| Rust stable | the relay and the Tauri app | `rustup` installs it. |
| ffmpeg | the spike | The harness encodes its own test clip. |
| A browser | a live room | Firefox or Zen for the Gecko lane, Brave for the Chromium lane. |

The Tauri app also needs the platform packages on
[Tauri's prerequisites page](https://v2.tauri.app/start/prerequisites/): Xcode command line
tools on macOS, the MSVC build tools and WebView2 on Windows, and the `webkit2gtk` group on
Linux.

```bash
git clone https://github.com/emrisca/brosr.git
cd brosr
```

The core suite needs no install step:

```bash
cd core
npm test
```

The host lifecycle has its own suite, and one command runs both from the repository root:

```bash
node --test core/test/*.test.mjs host/test/*.test.mjs
```

The app drives `host/cli.mjs`, so build the relay before you start it:

```bash
cargo build --manifest-path relay/Cargo.toml
cd app
npm install
npm run tauri dev
```

That builds a development window. A packaged build is `npm run build` in `app/`. Releases are
cut by a maintainer with `node app/scripts/release.mjs <version>`, so leave the version fields
alone in a feature pull request.

The tree ships no style linter. CI parses every module with the Node parser, and the same loop
runs here in about a minute:

```bash
find core host bridge scripts zen spike relay \
  -type f \( -name '*.mjs' -o -name '*.js' \) \
  -not -path '*/node_modules/*' \
  -not -path '*/.run/*' \
  -not -path '*/.runtime/*' | sort | while read -r file; do
  node --check "$file"
done
```

`node scripts/check-all.mjs` is the browser job from CI. It needs the relay binary, a working
tree build of the bridge and a downloaded Chrome for Testing, so most contributors run it only
before a change that touches the room, the panel or the lanes. It writes its logs to
`zen/.runtime/`.

## Run the spike

The spike is the M0 harness plus the M1, M3 and M4 checks. It needs Node and ffmpeg, and it
downloads Firefox Nightly and uBlock Origin into `spike/.runtime/` on the first run:

```bash
cd spike
node run.mjs
```

A full ten-check run takes about four minutes. It encodes a 120 second clip, starts a relay on
`127.0.0.1:8787`, opens four headless windows and writes `spike/results.json`. Port 8787 must be
free, and a busy port stops the run with `port 8787 is in use` instead of borrowing the other
process.

`--only=` takes a comma list of `ad`, `bidi`, `media`, `room`, `jitter`, `input`, `agent`,
`game` and `soak`. `--soak=3600` runs the one hour reconnect soak, and `--game=SECONDS` runs the
two-window canvas game. `run.mjs` downloads a Windows build, so macOS passes a binary instead:

```bash
node run.mjs --only=bidi,ad \
  --firefox="$PWD/.runtime/firefox-mac.app/Contents/MacOS/firefox"
```

`spike/README.md` records each run and the findings that changed the code. Read it before you
read a number there, because a loopback figure and a LAN figure are not the same measurement.

Never commit `spike/.runtime/`, `spike/results.json` or `zen/.runtime/`. A run rebuilds them.

## Good first issues

`docs/remaining-work.md` is the open list, grouped by area. These ones need one machine, no LAN
and no Windows, so they suit a first pull request:

- **The Watch tile copy.** `landing/index.html` still says `Soon` for a path that plays. Read
  the tile and the list in the same file first, then make them agree.
- **A missing core case.** `core/` has one test file per module. Pick a rule from the five in
  `core/README.md`, find the branch that has no case, and add one. The suite runs in a second.
- **The empty room line.** The panel and the header name the peer count. Check both with no
  peers, and fix the copy where the two disagree.
- **Onboarding notes.** Install `v0.3.18` from the release page, follow it as a new person and
  write down every step that needed a guess. `docs/remaining-work.md` asks for that under three
  minutes, and the notes are the start.

Open an issue before you start so two people do not take the same item. Say what you plan to
change and how you will check it.

## Submit a pull request

1. Branch from `main` and keep one topic per pull request.
2. Run the tests and the syntax loop above. Both must pass.
3. Keep the prose in the house style: no emojis, no em dashes, and no semicolons in a sentence.
4. Leave out generated and runtime paths: `.runtime/`, `results.json`, `host/.run/`,
   `.secrets/`, `inbox/`, `processing/`, `done/` and `locks/`. `docs/HANDOFF.md` is a local
   record and stays out of git too.
5. In the body, say what changed, how you checked it and what you could not check. A browser or
   media change needs one measured row rather than "it felt fine". `docs/remaining-work.md`
   asks for one measurement per claim, and a retest that reports a feeling closes nothing.

CI has three jobs. `Lint` parses the modules in about a minute. `Core tests` runs `npm test` in
`core/` on Ubuntu. `Brosr check` is the forty minute browser job, and it downloads Chrome for
Testing and Zen, so it is expected to be slow. A red `Brosr check` uploads its lane logs as an
artifact.

## Report a problem

Open an issue with the build from the app's version stamp, the operating system, the browser
lane (`zen`, `chromium` or `brave`) and what the panel showed. Do not paste a room key or an
invite link: the key sits in the URL fragment and anyone who reads it can join the room. A
security problem belongs in a
[private advisory](https://github.com/emrisca/brosr/security/advisories/new) rather than an
issue.

By taking part you agree to [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

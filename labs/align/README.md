# Alignment lane

A room keeps one playhead. That works only while both people hold the same
bytes. One person may have a remux with a longer studio logo, and another a rip
with the head trimmed. The playhead is then right while the film is not.

This lane compares two local copies and reports one number. The number is the
millisecond offset from room time to this peer's own position.

    offset +4100   this copy starts 4.1 s later, with extra titles at the head
    offset -4100   this copy starts 4.1 s earlier, with the head trimmed

The steady identity is:

    localPosition = roomPosition + offsetMs

A positive offset moves this peer forward in its own file. The room code applies
the number at one boundary, where room time becomes an expected local position.

The lane is offline and opt in. It never talks to the relay, never decodes audio
or video in Bend, and never runs during a room. The app behaves as before when
the Bend binary is missing, broken, slow or killed. An unknown offset is zero.

## Pipeline

1. ffmpeg decodes the first audio track to mono signed 16 bit at 8 kHz.
2. `envelope.mjs` reduces the stream on arrival to one RMS value per 20 ms.
   The PCM is never kept, so a two hour film costs a 360,000 entry array, not
   115 MB of samples.
3. A coarse pass averages 50 windows into one second and scores lags over the
   whole film.
4. A fine pass takes a 20 s slice around the coarse answer and scores lags in
   20 ms steps within one second of it.
5. Both passes score a lag by the correlation of its overlap and skip lags
   with less than half the shorter copy in common.
6. `confidence` is the same correlation at the winning lag. Below 0.5 the tool
   reports no match and exits 3.

Each copy is scaled onto its own five bit range. The reference implementation in
`correlate.mjs` defines every search rule, including the tie break.

The installed Bend version only has 24 bit integers. A full two hour coarse dot
with eight bit values would overflow a `u24`, so the envelope uses five bits.
The worst coarse dot is 7200 * 31 * 31, about 6.9 million, which fits.

Bend receives two literal lists of numbers. It opens no file, parses no JSON,
parses no SRT and holds no state. The generated source is deterministic.

The Bend kernel also has no signed integer in the installed grammar. It walks a
non-negative index. The wrapper passes a bias and subtracts it to recover the
signed lag. A line is `index dot`. The wrapper maps the index back to the lag
before it picks the peak.

## Environment

The lane runs in WSL2 Ubuntu, not on the Windows side. The measured machine used:

    bend-lang 0.2.38
    hvm 2.0.22
    Node 24.22.3
    ffmpeg 8.0.1
    runner: bend run-c

Install:

    sudo apt update
    sudo apt install -y build-essential git ffmpeg curl
    curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
    sudo apt install -y nodejs
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    . "$HOME/.cargo/env"
    cargo install hvm
    cargo install bend-lang

The crate `bend-lang 0.2.38` is the Bend 1 line. It uses `with IO`, `u24`,
`i24`, `List/Cons` and `List/Nil`. The Bend 2 grammar and the `bend` proof mode
are not part of this build.

The runner skips Bend's type check for the generated kernel. The source is
rendered from one reviewed template and the parity test checks its dots against
the JavaScript oracle. The template is still checked by `bend check` on small
inputs.

## Run it

    node labs/align/align.mjs --a first.mkv --b second.mkv
    node labs/align/align.mjs --a a.mkv --b b.mkv --engine js --json
    node labs/align/align.mjs --a a.mkv --b b.mkv --keep /tmp/align-kernels

Options: `--engine auto|js|bend` (auto uses Bend when it answers `--version`),
`--max-offset-ms` (default ten minutes), `--ffmpeg PATH`, `--json`, `--keep DIR`.

Exit codes: 0 matched, 3 no confident match, 2 usage, 1 input or tool failure.

Tests:

    node --test labs/align/test/align.test.mjs

The Bend cases skip when `bend` is not on `PATH`. Run the same command inside
Ubuntu to exercise the parity and real-shift cases.

## Two engines, one answer

`--engine js` is the reference. It is a plain integer implementation in
`correlate.mjs`. It defines the search rules and the tie break, and its tests do
not need ffmpeg or Bend for the synthetic cases.

`--engine bend` renders `align.bend` with both envelopes as literal lists, runs
it in a temporary directory, and reads back one line per lag. The kernel holds
no state and interprets no text. A missing binary, a compile error and a
timeout all raise an error. None of them returns zero.

The parity test compares the Bend dots with the JavaScript oracle on the same
inputs. The real CLI test cuts 4.1 s from a generated track and checks the
Bend result.

## Laws

`laws.bend` holds executable checks for the offset algebra:

- identity: a copy correlated with itself peaks at lag zero
- antisymmetry: swapping A and B negates the lag
- composition: A to B at x and B to C at y gives A to C at x + y
- boundedness: a zero array has zero dots and no peak

`proof.bend` runs all four checks and prints one result per law:

    $ bend run-c proof.bend
    identity 1
    antisymmetry 1
    composition 1
    boundedness 1

`bend PROOF.bend` does not work with Bend 0.2.38. The CLI answers:

    $ bend PROOF.bend
    error: unrecognized subcommand 'PROOF.bend'

There is no law or proof kernel in this build. The four checks are executable
laws over Bend's own semantics. They are not a formal proof, and they do not
certify the generated C or the JavaScript runtime. The checks guard the model,
not the whole app.

## Measured

The machine was a Windows host with WSL2 Ubuntu. The audio was synthetic pink
noise with a slow gain envelope. No copyrighted film was used.

| Case | Offset | Confidence | Wall time |
| --- | --- | --- | --- |
| 40 s track, 4.1 s head cut | -4100 ms | 1.00 | 28.71 s |
| 2 h track, 4.1 s head cut | -4100 ms | 1.00 | 58.59 s |
| 7200 values, 1201 lags, kernel only | n/a | n/a | 53.05 s |
| 7200 values, one lag, kernel only | n/a | n/a | 0.24 s |

The two hour case includes ffmpeg decode, the coarse pass and the fine pass. It
is under the 60 s budget, but with little room. The coarse pass is the cost.

## What it will not do

- A constant offset cannot repair a copy that is sped up. A 23.976 against 24
  fps pair drifts by about 4 s an hour, and confidence falls before the offset
  lies to you.
- Different edits with footage inserted in the middle break the constant
  offset the same way. A per scene offset is a later feature, not a tuning
  problem.
- A film with no audio track is refused. The lane reads audio only, on purpose:
  it is cheap, it survives re-encoding, and it needs no codec for the picture.
- The lane does not choose a copy, download a file, or alter the media. It only
  reports a number and the room applies it to this peer's expected position.

## Room integration

`core/align.mjs` holds the app rules. It accepts a payload only when the offset
is finite, inside plus or minus 30 minutes, and confidence is at least 0.5. A
malformed payload is dropped whole.

A caller that has a measured JSON record can pass it at construction:

    createRoomClient({ alignOffset: { offsetMs: -4100, confidence: 0.98 } })

or at runtime:

    client.setAlignOffset({ offsetMs: -4100, confidence: 0.98 })

A number is treated as a confident local measurement. `null` clears it. This is
the local-file path. The core does no file IO.

A local tool can also send `{ type: 'brosr:align-offset', offsetMs,
confidence, fingerprint }` to the room tab. The tab stores the accepted value
under `brosr-align:<room>` and reuses it after a reload. A value from the relay
is never used for this. This is the local handoff path.

`align.offset` is an app message with `{ offsetMs, confidence, fingerprint }`.
The room rate limits it to once per second per peer and records the claim. It
does not apply one peer's claim to another peer's player. An offset belongs to
the person holding that copy. Malformed or out of range claims are ignored.

`publish()` carries the local `align` state. The room panel shows one quiet line
when the offset is not zero. With no offset, the panel is unchanged.

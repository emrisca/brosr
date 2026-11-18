# Canvas

The canvas is the sheet a room draws on. It is one page, one stylesheet and one
script: `index.html`, `canvas.css` and `canvas.js`. The relay serves this
directory as bytes, so there is no build step.

## Bend

The layer and undo rules are stated in `LAWS.bend` and proved in `PROOF.bend`.
A law is the claim a person reviews, and the proof is the other half, so do not
weaken a law to make a proof pass.

Bend 2.0.40 is installed at `~/.bend`. Lean 4.34.0 is installed with elan at
`~/.elan`, which the kernel pass needs:

```
export PATH="$HOME/.bend/bin:$HOME/.elan/bin:$PATH"
cd brosr/landing/canvas
bend PROOF.bend
bend PROOF.bend --verdict
```

Both commands print `ALL PROOFS CHECK` only when every law holds. Without
`~/.elan/bin` on the path the verdict pass stops with a message that Lean is
missing, while the plain gate still runs.

## Checks

The page is driven in a test browser, not just loaded. Run these from `brosr/`:

```
node scripts/check-canvas-tools.mjs
node scripts/check-canvas-stroke.mjs
node scripts/check-canvas-pointer.mjs
node scripts/check-canvas-layout.mjs
```

- `check-canvas-tools` covers the wide eraser, the per-layer erase, two-finger
  pan, the layer controls, hex and recents, image import, the GIF dialog, local
  undo and clear, and a late join that keeps each stroke and image author.
- `check-canvas-stroke` sends a stroke from one page and reads the pixels on a
  second page, so the room path is the one that paints.
- `check-canvas-pointer` holds a remote dot through zoom, resize, refit and
  clear, and measures a cached frame against a full repaint.
- `check-canvas-layout` reads control boxes in the rail, in a narrow window,
  in the GIF dialog and through the theme switch, so a clipped row, a section
  under the status line, a status label outside ASCII, a muted label under
  4.5:1 or a search that shows no placeholders fails without a person looking.
  `BROSR_SHOTS=some/dir` keeps a shot of the light theme and a search in
  flight.

Each check starts its own relay and its own browser on its own port, and leaves
neither running. `BROSR_CHECK_BROWSER=/path/to/chrome` picks another Chromium.

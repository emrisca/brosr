# Proposal: let the adapter own the peer media path

For the Mac. `core/sync.mjs` and `core/room.mjs` are yours, so this file carries
the change and no edit lands in your copy. The Windows side already changed
`core/youtube.mjs`, which is our half of M2.

## The problem

`applyMedia` reads element fields off whatever `media.pick()` returns. It calls
`element.currentTime`, reads `paused`, `seeking`, `readyState` and
`playbackRate`, and writes `currentTime` in place. That works for an
`HTMLMediaElement` and it cannot work for a YouTube player object. A player has
none of those fields.

`core/youtube.mjs` now returns a view that fakes the fields. That keeps one peer
path working today, and it hides the real shape of the interface. A third
adapter would have to fake the same fields again.

## The change

The adapter already owns `pick`, `state`, `flags` and `apply`. The proposal is
that `applyMedia` uses them and never touches an element field.

1. `media` becomes `let media`, so a late player can replace the adapter.
2. One setter joins the returned client:

```js
// A page that hands its player in after the core starts swaps the adapter here.
function setMediaAdapter(next) {
  media = next || new MediaAdapter({ root: mediaRoot });
}
```

3. `applyMedia` reads one state object and writes through `apply`:

```js
const element = media.pick(message.key);
const read = media.state(element);
if (!read) return { ok: false, reason: 'no-media' };
stats.key = read.key;
stats.position = Math.round(read.position * 1000) / 1000;
stats.playing = read.playing;
if (role === 'host') return { ok: true };

const expected =
  message.position + (message.playing ? (roomTimeOf(local) - message.roomTime) / 1000 : 0);
const actual = read.position;
```

4. The three write paths go through the adapter:

```js
// the stuck seek retry
media.apply(element, { action: 'seek', position: expected });

// the pending seek
media.apply(element, { action: 'tick', rate: 1 });

// the decision
if (step.action === 'seek') media.apply(element, { action: 'seek', position: target });
else if (step.action === 'pause') media.apply(element, { action: 'pause' });
else media.apply(element, { action: 'play', rate: drift.rate });
```

5. The seek check reads `read.seeking` instead of `element.seeking`.
`bufferedAround` becomes a method on the adapter. The element adapter keeps its
range check, and the player adapter returns true.

6. `browser-entry.mjs` keeps its start-time read and adds one watcher, after the
core starts:

```js
const adopt = () => {
  const player = globalThis.__brosrYouTubePlayer;
  if (!player || client.media.player === player) return;
  client.setMediaAdapter(
    new YouTubeAdapter({ player, root: document.getElementById('movie_player'),
      key: playerKey(location.href) })
  );
};
```

## Acceptance

The core suite stays green after the view in `core/youtube.mjs` goes away.
Today `core/test/youtube-room.test.mjs` and `spike/youtube-player.test.mjs`
pass only because the view fakes the fields. When the peer path is adapter
owned, both files still pass with `pick` returning the raw player.

That test is the point of the change. It names the interface, so a new adapter
has one shape to meet.

## What stays on the Windows side

- `core/youtube.mjs`: the adapter, the ad class, the state mapping, and the view
  until this lands.
- `spike/fixtures/youtube-player.html`: a fake IFrame player for a browser run.
- `proposals/bridge-youtube.js`: the page-scope hand-in the bridge should
  inject, with a note on the manifest entry it needs.

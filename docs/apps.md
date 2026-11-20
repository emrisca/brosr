# The landing page and the Brosr apps

Part of the [Brosr design index](README.md).

## The landing page and the Brosr apps

The room tab used to open a second fixture page. It now opens the Brosr landing page at
`/`: one grid of apps built for a shared browser, with the room already running behind it.
The room params on that address are what mark the tab as the room, so the landing page is
both the front door and the room surface.

### What the page is

A static page served by the relay at `/`. It loads no font and no script from the network,
so it opens on a loopback room with no internet. It is a grid of tiles, one per app. Each
tile names the app, says what it does in one line, and shows a state: Live, Soon or Slot.
The room line reads `/status` every five seconds and names how many pages are open, so the
header shows a live room rather than a claim about one.

A tile is a link when the app exists and a plain card when it does not, so the page never
offers a door that goes nowhere. The address tile is the one card with a field: it takes a
link and opens it, and the page itself stays a static file. The page follows the app tokens: the same warm clay accent,
the same corner radius and the same muted foreground. It carries both colour modes from
prefers-color-scheme, a visible focus ring, a skip link and one column below 640 pixels.

### Tiles at launch

| Tile | State | What it is |
| --- | --- | --- |
| Canvas | Live | A shared drawing surface, the first app built for Brosr |
| Watch | Soon | One playhead, with pause and seek shared |
| Listen | Soon | A shared queue on one track |
| Play | Soon | Turn based and canvas games |
| Notes | Soon | A page that edits as everyone types |
| Open a link | Live | Any address, opened in a new tab and shared with the room |
| Next app | Slot | A reserved card, so the grid never looks finished |

The grid fills 248 pixel columns and wraps, so a wide window shows four tiles and a laptop
shows three. A Soon card sits flat on the page and a Slot card carries a dashed border, so
"not built" and "reserved" differ without reading the label.

Read and Browse leave the grid for now. Read returns when a page can hold a long article at one
scroll. Browse returns when one tab set and one address bar exist. Neither tile is drawn until
the app behind it is real.

### The Canvas app

Canvas is the first tile with a working page. It is a custom drawing surface written for
Brosr, with no embed and no dependency.

- Surface. The sheet is a square of 2400 by 2400 with a paper edge, so a drawing has a frame
  and nothing paints on the desk around it. A pointer that leaves the paper stops at its edge.
- Brushes. Pencil, ink, marker, airbrush, eraser, line, box and oval. Ink tapers at both ends,
  the marker lays down translucent colour, and the airbrush builds a soft edge from dabs. Each
  tool remembers the width and opacity it was last given, and a brush reaches 400 px, so an
  eraser clears a sixth of the sheet in one pass.
- Erasing. An eraser cuts the selected layer only, not the paper and not the layers below.
  Every layer owns a bitmap built from its own strokes, so a rebuild after an undo brings back
  exactly the ink the erase removed.
- Stabilizer. A slider smooths incoming points, so a trackpad line still reads as a line.
- Shapes. Line, box and oval, drawn with the current width and colour.
- Layers. Up to six, each with a name, a visibility toggle and an opacity. A stroke lands on
  the selected layer, a double click renames one, and Add, Up, Down, Delete and Clear act on the
  selection. A sheet keeps at least one layer.
- Colour. Fourteen swatches, a custom picker, a hex field, and an eyedropper that reads the
  sheet where the browser has one. The eight most recent colours sit under the field.
- Images. An import places a picture on the selected layer, above that layer's strokes and
  below the next layer, at no more than 60% of the paper. A large photo is scaled down before it
  is stored. An animated GIF keeps animating, because the sheet draws its frames. A picture keeps
  the page that placed it, so another page's undo leaves it and a late joiner learns the author.
- GIF search. A dialog searches Tenor and places a result, or takes a pasted GIF address. A GIF
  is copied into the sheet before it lands, so an export and a room frame never carry a
  reference to another host. The Tenor key is optional and falls back to the published demo key.
- History. Undo and redo for a stroke, an image, and a clear. Only the work this page drew
  enters the stack, so undo takes back my stroke and leaves a peer's, and Clear leaves their
  ink on the layer. The buttons disable when a stack is empty.
- Export. PNG of the finished sheet at paper size, with every visible layer, its opacity and its
  images.
- Navigation. Space drags the sheet. A mouse wheel zooms at the pointer between 15% and 800%.
  Two fingers on a trackpad pan, a pinch zooms, and Fit frames the sheet. A resize refits a sheet
  nobody moved and leaves a chosen zoom alone.
- Room. Strokes, layers and images reach every page over one WebSocket. A stroke also travels
  while it is drawn, so a peer sees the line grow before the pointer lifts. A live frame carries
  only the points added since the last one, at most every 60 ms, and a stroke nobody finishes
  leaves the sheet after 15 seconds. Undo, redo and clear travel as stroke ids, and a layer
  change travels as an index op, so every copy ends in the same state. A page that joins late
  asks for the sheet and receives the strokes, layers and images it missed.

Keys: B, I, M, A, E, L, R and O pick a tool. Bracket keys change the width up to 400. Space pans.
Escape leaves a colour pick or the GIF dialog. Cmd Z undoes and Cmd Shift Z redoes.

The app is one HTML file, one stylesheet and one script. The relay serves it as bytes, so a
room opens it with no build step.

### Shared cursors

A person can point at a tile, so a cursor travels with the room.

- A landing page opened on its own holds a socket to `/room?room=&role=cursor`. A pointer
  move goes out at most every 80 ms as a share of the viewport, so two window sizes put the
  dot in the same place. A dot carries the person's name, and it leaves after three quiet
  seconds. The cursor role keeps the socket out of the room's app and people counts, since a
  pointer surface is not an app.
- Presence on the room carries the same share. The core turns a share into pixels against its own
  window, once, before the overlay draws. That one conversion is why a cursor lands on the same
  part of the page in a small window and a large one.
- The same page opened as the room tab joins the room through the core. The core draws the
  cursors there, and the page leaves its own socket shut, so the room tab and a plain
  landing page never draw the same dot twice.
- A dot shows only on the page it belongs to. The page key drops the room params, so two
  people in one room share one key while a tab on a different page draws nothing.
- The meta tag `brosr-cursors` with content `page` names the landing page as the owner of its
  cursors. The bridge reads it and leaves that page alone, so one cursor has one owner.
- A shared tab has no socket, so the room tab carries its pointer. The browser sends a point
  only to tabs on that same page, and input sync stays on the room tab.

The URL tile opens the address in a tab and the bridge shares that tab, so the site keeps its
own page and its own scripts.

### Watch, the sites that play in sync

Watch is the tile for one playhead. The room matches the film by page, then sets the position and
the rate. Volume stays local, because a person in a quiet room and a person with headphones do not
want the same level. The list below is what the room follows today.

| Site or page | How the room follows it | State |
| --- | --- | --- |
| YouTube, `youtube.com` and `youtu.be` | The IFrame player adapter, keyed by video id. A single page navigation hands in the new player | Verified on two browsers, 15 November 2026 |
| YouTube shorts and embeds | The same adapter, from the same video id | Built, not yet run on a live film |
| Any page with a `<video>` or an `<audio>` in the top page | The element adapter reads the element fields | Built, not yet run on a live film |
| A player inside an iframe | The content script runs in every frame, and the frame key comes from the frame URL | Built, not yet run on a live film |
| Cinecat, `cinecat.eu` | An inline HTML5/HLS player on `/media/<id>`; the title page names the film | Verified on two browsers, 16 November 2026: play, pause, seek and resume stayed within 250 ms |
| Miruro, `miruro.cx` | A `<strmcx-embed>` shadow host around a generic `strm.cx/?embed=1` iframe; that URL does not name the episode | Title page probed 16 November 2026; playback not verified, needs a film handoff |
| Movy, `movy.sx` | A top-page `<video>` with a blob source and custom controls, so the element adapter reads it | Verified on two browsers, 18 November 2026: pause 0.058 s, seek 0 s, playback p95 0.02 s, 92 applies. Both browsers ran on one Mac, so no cross-machine row yet |
| Cinejoy, `cinejoy.pk` | Not yet probed beyond the supplied link | Added 16 November 2026; playback not tested |
| p-stream and its forks | One page and one player, so one adapter covers each fork | Built, not yet run on a live film |
| HLS and DASH pages | The page names the film, so a quality switch keeps the same key | Built, not yet run on a live film |
| Twitch and YouTube Live | Play and pause only, because a live stream has no playhead to seek | Not built |

The directory holds more sites than one screen shows, so the Watch tile carries a filter above
it. The field reads the site name and its host, hides every row that does not match, hides a
heading whose list is empty, and keeps the count beside the field in step. A name with no match
says so instead of leaving two blank columns.

Netflix, Disney+ and Prime Video stay out. The DRM layer owns the media pipeline, and a script
write to the playhead fails there.

*Done when:* three sites from the list hold within 1 s on two browsers, one of them inside an
iframe, with at most one seek per ten minutes and no seek loop.

### Listen, YouTube Music and lyrics

Listen is the tile for a shared queue on one track. The next step is YouTube Music at
`music.youtube.com`, which plays through the same IFrame player the YouTube adapter already
reads. A queue then names its track by video id, and the same clock, drift policy and rate nudge
apply. The queue itself is the new part: who picks the next track, and what happens when the
queue ends.

The extension catalogue gains `https://betterlyrics.org/`, so a lyrics page opens in the same
profile as the music. It joins the four entries in [zen/safe-browsing.mjs](../zen/safe-browsing.mjs)
after the same review the other four had: no network fetch from the page, one pinned id, and a
cold start that installs it from the cached copy.

*Done when:* two browsers hold the same track within 1 s, the queue advances on both, and the
lyrics page follows the track.

**Status 16 November 2026.** `music.youtube.com` is recognised as the music host, and a track keys
on its `v` parameter, so the watch adapter's clock and drift policy already apply there. The
shared queue is still to come.

### Backlog from the room notes

These come from `notes.md` in the Avalon project folder. They are recorded here so the plan holds
them, and none of them is built yet.

- **Screen share viewer.** A person offers a screen, the room shows it in a tab, and each viewer
  answers request, accept or decline. This one is pixels by design, so it stays a separate tab
  and never becomes the page-sync path.
- **Rename the room.** The room takes a name a person chooses, and the name shows in the header,
  the panel and the invite. Each person also gets a cursor colour, random on first join and
  changeable after, so two people never share one colour by accident.
- **Custom cursors.** A tab in the extension menu lists cursors from `cursors-4u.com`, and a
  person picks one for the room by pasting the set link. The menu keeps these controls off the
  shared surface, so the page stays clean. A custom cursor greys out the colour choice, because
  the image carries its own colour.
- **Own cursor toggle.** The same menu holds one switch for a person's own pointer, so a screen
  recording or a quiet page can keep its cursor, and a viewer who does not want to see it can
  turn it off. It lives in the extension menu with the cursor tab, not on the page.

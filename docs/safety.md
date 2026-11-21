# Safety

Part of the [Brosr design index](README.md).

## Safety, because a shared tab is still a shared surface

Replaying a stranger's click is one bad message away from a purchase, a destructive action or a
post. Brosr therefore does not relay raw DOM events between browsers. A room moves application
state, and a shared tab moves playback, never a keystroke.

1. **No remote DOM input.** A room never mirrors a click, a drag or a keystroke into another
   browser. The `input` message type stays in the protocol so an older peer gets a clear refusal
   instead of silence, and the receiver answers `input-disabled`. Canvas, Notes and Chess sync
   their own state through app messages, so a stroke, an edit or a move arrives as data.
2. **Tab authority.** A shared tab has one host, the person who offered it. Only that host changes
   the active video or source URL. Everyone holding the tab may play, pause and seek. The landing
   page disables the source field for anyone who is not the host.
3. **Sensitive targets stay refused.** The guards in `core/input.mjs` refuse password fields,
   fields with `autocomplete` credential hints, cross-origin iframes, and a built-in list of
   payment and banking origins. A current room never reaches them because it relays no DOM input,
   and the trusted actuator keeps the same guards.
4. **No credential material moves.** Cookies, local storage, tokens and passwords never leave the
   machine. Each person signs in on their own copy. This is a security property and a legal
   convenience.
5. **The relay sees sealed frames.** The room key is 128 random bits in the invite link fragment,
   expanded with HKDF and used with XChaCha20-Poly1305. The fragment never reaches the relay. The
   relay sees a room id, peer ids and frame sizes, and no URL, no cursor, no key.
6. **The page is hostile.** The bridge's content scripts run in a sandbox, so page scripts cannot
   read their variables or call their functions. The remote agent is the one channel that reaches
   the browser itself, which is why it starts per trusted session and closes with it.
7. **Rate limits.** The sync core drops more than 120 input batches per second per peer, and more
   than one navigation per second per room. A hostile peer must not be able to make the app
   unusable.
8. **Pointer lock is local by design.** Pointer lock captures raw mouse motion for a single user's
   window and cannot safely be shared or triggered remotely. The trusted actuator refuses
   pointer-lock requests (`pointer-lock-local`) and refuses remote input while local pointer lock
   is active (`pointer-lock-active`), returning `{ allow: false, reason, message }` rather than
   silently dropping or relaying events.

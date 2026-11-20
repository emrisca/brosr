# Safety

Part of the [Brosr design index](README.md).

## Safety, because remote input is a foot-gun

Replaying a stranger's click is one bad message away from a purchase, a destructive action or a post. The
room treats input as a privilege, not a default.

1. **Control grants.** A peer can move a cursor and scroll freely. Clicking, typing and media
   control need a grant from the host. The grant names one peer, one tab and one origin, and
   it ends when the tab closes. A bar in the page and in the sidebar reads "Alice has control
   of this tab", with a Revoke button. It cannot be hidden while a grant is active.
2. **Origin allowlist.** The receiver refuses injection on password fields, on fields with
   `autocomplete` credential hints, and inside cross-origin iframes. It also refuses a list of
   payment and banking origins that ships in code and updates with the app. The sender has no
   say in this.
3. **No credential material moves.** Cookies, local storage, tokens and passwords never leave
   the machine. Each person signs in on their own copy. This is a security property and a
   legal convenience.
4. **The relay sees sealed frames.** The room key is 128 random bits in the invite link
   fragment, expanded with HKDF and used with XChaCha20-Poly1305. The fragment never reaches
   the relay. The relay sees a room id, peer ids and frame sizes, and no URL, no cursor, no
   key.
5. **The page is hostile.** The bridge's content scripts run in a sandbox, so page scripts
   cannot read their variables or call their functions. The remote agent is the one channel
   that reaches the browser itself, which is why it starts per grant and closes with it.
6. **Rate limits.** The sync core drops more than 120 input batches per second per peer, and
   more than one navigation per second per room. A hostile peer must not be able to make the
   app unusable.
7. **Pointer lock is local by design.** Pointer lock captures raw mouse motion for a single
   user's window and cannot safely be shared or triggered remotely. Capture, batching, grant
   checks, replay, and trusted actuator helpers all refuse pointer-lock requests
   (`pointer-lock-local`) and refuse remote input while local pointer lock is active
   (`pointer-lock-active`), returning `{ allow: false, reason, message }` rather than silently
   dropping or relaying events.

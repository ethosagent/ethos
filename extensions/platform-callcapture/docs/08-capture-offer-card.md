# Native capture-offer card fix

## Fix — native capture-offer card, retiring `notification-helper` (2026-08-19)

The user-reported "whitish grey" Liquid Glass symptom above was investigated
and correctly diagnosed as expected OS behavior, not a code bug — but the
System Settings workaround it points to did NOT resolve it for this user in
practice. That's the second time a system-owned notification surface has
been a source of friction in this package (`terminal-notifier`'s theming bug
was the first), and both times the root problem is the same: this package
doesn't control the rendering of chrome it doesn't draw itself. A screenshot
of Granola's own "Meeting detected" UI made the alternative obvious —
Granola doesn't use a system notification for this at all. It draws its own
always-on-top card: a white rounded card with a headline, a subtitle naming
the detected app, its own icon + action label, and Start/Skip buttons —
completely immune to system notification chrome theming because there is no
system chrome involved.

### The fix: `native/capture-offer-card.swift`, a custom AppKit window

Mirrors `capture-indicator.swift`'s category exactly (a real Cocoa event
loop — `NSApplication.shared` + `setActivationPolicy(.accessory)` + an
`NSApplicationDelegate` + `app.run()` — not the bare `RunLoop.main.run()`
the headless detector/capture binaries use), and reuses that file's
proven patterns rather than re-deriving them:

- **Draggable, bottom-right by default, position-persisted** — the exact
  same manual `mouseDown`/`mouseDragged` override `capture-indicator
  .swift`'s `BadgeView` uses, for the exact same reason:
  `isMovableByWindowBackground` does not reliably move this style of
  borderless/nonactivating panel (proven there via synthetic
  `NSApplication.sendEvent` injection — not re-proven here, just reapplied).
  Position persistence reuses AppKit's own frame-autosave mechanism, same as
  the badge.
- **Non-activating, all-Spaces-visible** — same `NSPanel` styling
  (`.borderless`, `.nonactivatingPanel`, `.floating` level,
  `.canJoinAllSpaces` + `.fullScreenAuxiliary`), `orderFrontRegardless()`
  never `makeKeyAndOrderFront(_:)` — never steals focus from whatever
  calling app (Zoom, etc.) is frontmost, and stays visible even if that app
  is running fullscreen in its own Space.
- **Bare binary, no app bundle** — unlike `notification-helper.swift`,
  nothing here touches `UNUserNotificationCenter`, so none of that file's
  `CFBundleIdentifier`/Launch-Services requirements apply.
  `capture-indicator.swift` already proves plain AppKit windows work fine
  from a bare `swiftc`-compiled Mach-O executable in this package; this
  binary is built the same way (`swiftc ... -framework AppKit -framework
  Foundation`), with no wrapping script.
- **Forced light appearance, fixed colors** — `panel.appearance =
  NSAppearance(named: .aqua)` plus literal (never semantic/dynamic) RGB
  color values throughout. This is the actual mechanism that makes the
  "immune to system theming" promise true: a dynamic color like
  `.labelColor` resolves to near-white under system Dark Mode, which
  painted onto this card's own fixed white background would silently
  reproduce a white-on-white rendering — the exact class of bug this whole
  line of fixes exists to escape. See the file's header comment for the
  full reasoning.

See `native/capture-offer-card.swift`'s header comment for the complete
design writeup (protocol, brand-icon resolution, why one process per offer
rather than per capture session).

### `notification-helper` fully retired, not kept as a backup

Considered and rejected: keeping `notification-helper.swift` running
alongside the card as a secondary/backup signal, on the theory that a
system notification can register (with a sound) even when the user isn't
looking at any window. Decided against, for three reasons:

1. **Granola's own reference design doesn't hedge this way** — this feature
   exists specifically to match that UX, and Granola ships exactly one
   accept surface.
2. **The environments where each surface can appear are identical** — both
   require a live, logged-in Aqua session; there is no scenario where the
   system notification would show but the floating, all-Spaces-visible,
   `.floating`-level card wouldn't.
3. **Running both means coordinating two independent processes racing to
   resolve the same offer.** It's workable (both could feed the same
   `resolveOnce` guard `notification.ts` already has), but it's real
   ongoing complexity for a benefit that reason 2 says is close to zero.

The one genuinely real gap this leaves — a silent card is easier to miss
than a system banner if the user truly isn't looking at the screen — is
covered instead by a short `NSSound` played on the card's appearance
(`NSSound(named: "Glass")`, a standard bundled macOS alert sound, not a
custom asset). This needs no second process, no coordination logic, and no
risk of the two surfaces ever disagreeing about the outcome.

Concretely, this is now the **second** supersession for this package's
accept-gate surface (`terminal-notifier` -> `notification-helper` ->
`capture-offer-card`). Unlike the first supersession — where
`notification-helper.swift` was left on disk with its narrative preserved
as history — `notification-helper.swift` and its build script
(`scripts/build-notification-helper.sh`) have been deleted outright, along
with `checkNotificationHelperAvailable`/`NotificationHelperCheckResult` and
friends from `preflight.ts`. The Phase 2 and "native notification helper"
sections above are kept as-is for the historical record (this file's
standing convention — see its top section), but nothing in the current
runtime path references the deleted files anymore:
`checkCallCaptureDependencies()` checks `capture-offer-card`'s binary
presence with the same plain `existsSync` pattern every other native binary
in this package gets — there is no authorization-status dimension to check
anymore, since a plain AppKit window needs no OS permission at all.

### Outcome contract: `declined` stays `'expired'`, not a new variant

The card's Skip button (and its "x" dismiss) gives an explicit decline
signal that the old click-only notification never had — today, "not
accepted" collapses `expired` (call ended unanswered) and an implicit
non-click into the same bucket. A `'declined'` outcome would be more
precise, but it was deliberately NOT added: `CaptureOfferOutcome` is
imported by `daemon.ts`, and `handleCallStarted`'s reaction to it is
`if (outcome.outcome === 'accepted') {...} if (outcome.outcome ===
'expired') {...} else {...outcome.message...}`. A third non-`accepted`
member would make that `else` branch fail to typecheck (it assumes
`error`'s `message` field), forcing a real `daemon.ts` change to add an
explicit branch. `daemon.ts`'s actual reaction to `'declined'` would be
identical to `'expired'` anyway (log, go idle) — the extra type-level
precision isn't worth a `daemon.ts` change for zero behavioral gain, so
`capture-offer-card`'s `{"event":"declined"}` resolves the existing
`'expired'` outcome. See `notification.ts`'s inline comment at that
`switch` case for the same reasoning, kept next to the code it explains.

### Threading the source label through: the one deliberate `daemon.ts` line

The rest of this swap needed zero `daemon.ts` changes, matching the
`terminal-notifier` -> `notification-helper` precedent exactly. Showing the
detected app name as the card's subtitle (matching Granola's plain "Zoom"
subtitle) is the one exception: `source` only exists in `handleCallStarted`'s
local scope, and `PresentCaptureOfferOptions` never carried it before. The
fix is the smallest version of this that works: `source` was added as a new
optional field on `PresentCaptureOfferOptions`/`CallCaptureNotificationGatePort`
(additive, not a breaking change to either type), and `daemon.ts`'s existing
`presentCaptureOffer({callId, title, message})` call site gained one line —
`source,` — using a variable that was already in scope for `handleAccepted`/
`runCapture` a few lines below. `title`/`message` are passed unchanged and
are no longer read by `capture-offer-card`'s own fixed UI text, but are kept
on the type because `DesktopNotificationGate`'s own Electron-based card
(`apps/desktop/src/main/call-capture-notification-gate.ts`, a sibling
implementation of this same contract) still renders them into its own HTML.

### Verification performed

- **Rendered to a real PNG, no Screen Recording permission needed** — same
  `NSView.bitmapImageRepForCachingDisplay`/`cacheDisplay` technique
  `capture-indicator.swift`'s own verification pass established. The card's
  real layout code (icon, headline, subtitle, the "Capture" row, Skip/Start
  buttons) was rasterized off-screen and written to PNG, once with a source
  label ("Zoom") and once without (subtitle correctly omitted). Confirmed by
  eye: a genuinely rounded-corner white card (checked at the pixel level too
  — the top-left corner pixel is fully transparent, alpha 0, while pixels a
  few points inset are opaque white, confirming the rounded-rect clip is
  real and not just a flat rectangle), bold black headline, grey subtitle,
  the Ethos brand icon, a blue filled "Start" button with legible white
  bold text, and a plain grey "Skip" button — no white-on-white or
  low-contrast rendering anywhere, because nothing here is drawn by the
  system.
- **Drag verified via synthetic event injection, not just "should work"** —
  a real `NSPanel` was built with the card's exact drag-handling view, and
  real `NSEvent.mouseEvent` down/dragged/up events were posted through the
  real `NSApplication.sendEvent(_:)` dispatch path (the same technique
  `capture-indicator.swift`'s own draggable-badge fix used to disprove
  `isMovableByWindowBackground` and prove the manual override). Result: a
  drag gesture of (dx: 40, dy: -25) in window-local coordinates moved the
  panel's `frame.origin` by exactly (40, -25) — confirmed by comparing the
  panel's frame before and after, not by inspecting the drag code and
  asserting it must work.
- `pnpm --filter @ethosagent/platform-callcapture run build:native` compiles
  cleanly end to end (all four binaries: `mic-detector`, `mic-capture`,
  `capture-indicator`, `capture-offer-card`).
- Full repo `pnpm check` (typecheck + lint + test) passes.

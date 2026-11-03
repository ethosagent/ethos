# Floating recording indicator

## Floating recording indicator (plan/phases/call-capture-desktop-ux.md)

The follow-up flagged above: a small, draggable, circular on-screen badge
that appears the moment `CallCaptureDaemon` accepts a capture and disappears
the moment it ends — the only on-screen feedback the CLI-daemon path
(`ethos serve`/`ethos gateway`) has that something is actually recording.
The desktop app has its own, separate Electron `BrowserWindow`-based
indicator (`apps/desktop/src/main/call-capture-pill.ts`); this is the
headless-CLI analog, since a bare Node process has no `BrowserWindow`
available.

**`native/capture-indicator.swift`** — a different category from every
other native helper in this package. `mic-detector.swift`/`mic-capture.swift`
are headless CLI tools driven by a bare `RunLoop.main.run()`; this one shows
a real, draggable, hover-tracking `NSWindow`, which needs the full Cocoa
event loop. Concretely: `NSApplication.shared` +
`setActivationPolicy(.accessory)` (no Dock icon/menu bar — a background
helper, never something the user switches to) + an `NSApplicationDelegate`
+ `app.run()` in place of `RunLoop.main.run()`. See the file's own header
comment for the full design rationale (draggability, position persistence,
fullscreen-Space visibility, the badge icon, and the "waiting for
transcript" placeholder) — it's worth reading in full before touching this
file, since none of those mechanisms are shared with any other file in this
package.

**Protocol** — the first helper in this package that reads commands
INBOUND (every other one only ever writes outbound), one NDJSON object per
line, same convention just reversed:

```
Node -> Swift (stdin):
  {"command":"transcript_append","speaker":"you"|"other","text":"..."}
  {"command":"audio_level","speaker":"you"|"other","level":<number 0.0-1.0>}
  {"command":"hide"}
Swift -> Node (stdout):
  {"event":"ready"}                  — window created and shown
  {"event":"end_requested"}          — the popover's "End" button was clicked
  {"event":"error","message":"..."}  — non-fatal problem worth logging
```

`audio_level` drives a small two-row per-speaker level meter (smoothed with
an exponential moving average) shown at the top of the popover, above the
transcript text — it updates far more often (~100-200ms) than
`transcript_append` (~8s STT windows), giving visible proof capture is
working well before the placeholder clears or any transcript text exists.

One process per capture — `argv[1]` is the clean source label (e.g.
`"zoom"`), `hide`/stdin-EOF/SIGTERM all tear it down. The "End" button is a
safety net for when the real `call_ended` signal never fires (see "Fix —
per-process detection" above for why a safety net is still worth having on
top of that fix): clicking it only emits `end_requested` and keeps
running — the daemon decides when capture has actually finished and sends
`hide` once it has, so the badge disappears in sync with capture actually
stopping, not the instant the button is clicked. `CaptureIndicator`
(`src/indicator.ts`) is the Node wrapper, structurally satisfying
`daemon.ts`'s `CallCaptureIndicatorPort` the same import-direction-clean way
`detector.ts`/`notification.ts` satisfy their own ports.

**Building:**

```sh
pnpm --filter @ethosagent/platform-callcapture run build:native
```

Added to the existing `build:native` script. Needs only `AppKit` +
`Foundation` — no CoreAudio/AVFoundation, unlike the audio-capture helpers.

**Manual verification performed:** compiled with `swiftc` and launched for
real (this package's dev machine has a live Aqua session). Confirmed via
`CGWindowListCopyWindowInfo` (filtered to the process's own PID) that
launching the binary creates exactly two real on-screen windows at the
expected 48×48 / 300×220 sizes and expected bottom-right-of-screen position;
exercised `transcript_append`/an unrecognized command/`hide` over a held-open
stdin pipe and confirmed the process exits cleanly (code 0, zero windows
left behind) after `hide`. **Not confirmed:** an actual pixel-level
screenshot of the rendered badge/icon/hover popover — `screencapture` and
`CGWindowListCreateImage`-style capture both require Screen Recording /
Accessibility permission this environment's shell doesn't have, and there
was no human present to look at the screen directly. The icon-path
resolution and the "waiting for transcript" placeholder text were verified
by inspecting the resolved file path and reading the source logic, not by
looking at rendered pixels — treat the exact visual result (icon crop,
text layout, colors) as unconfirmed until a human checks it live.

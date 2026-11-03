# Phase 2 click bridge and Phase 3 audio capture

### No multi-button action support — click = accept, everything else = no capture

`terminal-notifier` 2.0.0's `-help` only exposes `-execute COMMAND` (run a
shell command on click) and `-open URL` — no `-actions`/reply flags.
Older 1.x built on the now-deprecated `NSUserNotification` had multi-action
support; 2.x moved to the modern `UserNotifications` framework, which this
CLI doesn't expose multi-action for. There is consequently no separate
"Decline" button in this design:

- **Accept** = the user clicks the notification body, firing `-execute`.
- **Decline** = the user does nothing — dismisses it, ignores it, or (per
  the plan's decision 5) the call ends before they answer. In that last
  case, `NotificationGate` does not passively wait: the caller (Phase 1's
  `call_ended`, wired in `phase2-cli.ts`) must call `.expire()`, which
  actively withdraws the notification via `terminal-notifier -remove
  <groupId>` rather than leaving a stale, no-longer-relevant notification
  sitting in Notification Center.

### The click-bridge mechanism

`-group ID` / `-remove ID` is the show/dismiss pair `NotificationGate` uses,
with a unique group id per offer (`ethos-callcapture-<callId>`) so
concurrent offers over a session never collide and each can be
independently withdrawn.

The actual accept signal is a local loopback HTTP listener
(`click-listener.ts`): `presentCaptureOffer()` opens one bound to
`127.0.0.1` on an ephemeral port, generates a random token, and builds the
`-execute` command as `curl -fsS http://127.0.0.1:<port>/click/<token>`.
`terminal-notifier`'s click callback has no session, no turn, no personality
context of its own — the token-gated URL is what turns that bare OS
callback into a promise resolution another process can't spoof by guessing
the path.

### GUI-click limitation, and how the mechanism was proven anyway

No accessibility/UI-scripting was available to script a real GUI click on
the notification banner. The click-bridge was instead proven end-to-end by
firing a **real** notification through the **real** `NotificationGate`
(`terminal-notifier`, not a fake), confirming delivery with `terminal-notifier
-list ALL`, then manually running the exact `-execute` command it was
configured with — the honest equivalent of "the user clicked it": same
`curl` call, same HTTP hit, same process boundary crossing, just triggered
by hand instead of a mouse. `NotificationGate.waitForOutcome()` resolved
`{ outcome: 'accepted' }` as a result. `.expire()` was verified the same
way: called after a real notification was shown, it issued a real
`terminal-notifier -remove <groupId>` (confirmed via the logged command)
and the notification disappeared from a subsequent `terminal-notifier -list
ALL`. The plumbing is provably correct end-to-end; only the literal mouse
click on the banner needs the repo owner's own eyes/mouse to confirm.

### Fail-closed contract (decision 5)

Every non-accepted path is a typed, observable `CaptureOfferOutcome` —
never silent:

- `{ outcome: 'accepted' }` — the click-listener was hit.
- `{ outcome: 'expired' }` — the caller called `.expire()` (the notification
  is actively withdrawn as part of this, not just left to linger).
- `{ outcome: 'error'; message }` — preflight failed (`terminal-notifier`
  missing) or `terminal-notifier` itself failed to spawn/deliver the
  notification. `presentCaptureOffer()` never lets a spawn failure become an
  unhandled rejection or a silent no-op.

### Troubleshooting: notification permission granted but no banner appears

A reproduced real case: detection, the process prefilter, and the audit-trail
`wake` chat message all fired correctly, but the actual macOS notification
banner never appeared — even after manually enabling notification
permissions for "terminal-notifier" in System Settings → Notifications.

Diagnostic sequence, in order:

1. `terminal-notifier -list ALL` only proves the notification was accepted
   into Notification Center's internal database — it does **not** prove a
   banner was ever shown on screen. Don't treat a successful `-list` entry as
   proof of visible delivery.
2. Check System Settings → Notifications → search for **"terminal-notifier"**
   specifically. It ships its own app bundle
   (`fr.julienxx.oss.terminal-notifier`, display name "terminal-notifier")
   and is **not** attributed to "Terminal" or whatever shell app launched it
   — searching for the wrong name is the easiest way to miss it. Confirm
   "Allow Notifications" is on and the alert style isn't "None".
3. Deep-link straight to the Notifications settings pane instead of hunting
   through System Settings by hand:
   ```sh
   open "x-apple.systempreferences:com.apple.preference.notifications"
   ```
4. If permission looks correctly granted and a banner still doesn't appear,
   restart the two macOS processes actually responsible for delivering
   banners before assuming it's a code bug:
   ```sh
   killall NotificationCenter usernoted
   ```
   Both restart automatically via `launchd` within a couple of seconds — this
   is safe, not destructive.

**Root cause, confirmed empirically on this machine:** `NotificationCenter`
and `usernoted` had been running continuously since before
`terminal-notifier` was ever registered as a new notification-capable app.
A newly-granted per-app notification permission does not take effect in
those already-running processes until they're restarted. After `killall
NotificationCenter usernoted`, a fresh test notification banner appeared
immediately — this was the actual fix, not a `NotificationGate` or
`terminal-notifier` invocation bug.

## What Phase 1 + 2 deliberately do not do

Per the plan's Phasing section: no persistent daemon / `ethos serve`
wiring, no personality/toolset binding, no memory writes, and no
resolution of whether the existing `before_tool_call` approval gate can be
reused as-is for this locally-triggered flow (an open question the plan
explicitly defers to Phase 4). Phase 4 wires everything below together
end-to-end, including connecting Phase 2's `NotificationGate` accept
outcome to Phase 3's capture pipeline — **that connection does not exist
yet**; Phase 3's capture is triggered manually (`phase3-cli.ts`), not by an
accepted notification.

## Phase 3 — dual-stream audio capture + streamed STT (standalone spike)

Proves decision 2's audio-capture design in isolation, "capture-on-manual-
trigger for a fixed duration," per the plan's own Phase 3 scope. **Not
wired to Phase 1's detection or Phase 2's notification/accept gate** — that
connection is Phase 4 integration work. Nothing here is wired into `ethos`
or any personality yet, and no memory write / transcript-artifact handoff
happens (`extensions/platform-meeting`'s `buildTranscriptArtifact` pattern
is reused for that in Phase 4, not built here).

### Two binaries, two different categories of dependency

A call has two audio sources that never travel the same signal path, so
Phase 3 uses two different capture mechanisms:

- **`native/vendor/audiotee/audiotee`** — captures OTHER PARTICIPANTS'
  audio (whatever the machine is playing out — the far end of the call).
  This is system OUTPUT audio, captured via the macOS 14.2+ Core Audio
  Process Tap API (`CATapDescription`). Wrapped by
  [`makeusabrew/audiotee`](https://github.com/makeusabrew/audiotee),
  pinned at commit `56ac954369a09318e46b88a6eec33c2d2b0d32a3` (upstream
  carries no version tags — its own README says "API Instability Warning:
  unstable, subject to change without notice," which is exactly why this
  pins a commit instead of trusting `main`). It is a Swift Package Manager
  project, **not a brew formula** — there is no `brew install audiotee`.
- **`native/mic-capture.swift`** — captures the USER'S OWN mic input, via
  the completely standard `AVAudioEngine().inputNode` API. Owned and
  compiled by this repo, same as `native/mic-detector.swift`.

These are three different dependency categories in this one package, worth
naming explicitly:
1. **Owned source, compiled locally** — `mic-detector.swift` (Phase 1),
   `mic-capture.swift` (Phase 3). No third party involved.
2. **Manual-install via a package manager** — `terminal-notifier` (Phase
   2), `brew install`-able.
3. **Manual-install, fetched-and-built-by-script, not vendored** —
   `audiotee` (Phase 3). Not on any package manager; fetched from a pinned
   git commit and built from source by `scripts/fetch-audiotee.sh`.

### Building `audiotee`

```sh
pnpm --filter @ethosagent/platform-callcapture run build:audiotee
```

Clones `github.com/makeusabrew/audiotee` into
`native/vendor/audiotee-src/`, checks out the pinned commit, runs
`swift build -c release`, and copies the resulting binary to
`native/vendor/audiotee/audiotee`. `native/vendor/` is gitignored (root
`.gitignore`) — like `native/bin/`, the built binary is never committed,
only fetched-and-built on demand. `scripts/fetch-audiotee.sh` is
spike-quality (re-clones from scratch every run, no caching) — formal
dependency-preflight packaging is explicitly Phase 4/T5 scope, not this.

### Building `mic-capture`

Added to the existing `build:native` script alongside `mic-detector`:

```sh
pnpm --filter @ethosagent/platform-callcapture run build:native
```

Compiles both `native/mic-detector.swift` and `native/mic-capture.swift`
into `native/bin/`. `mic-capture.swift` needs `AVFoundation` in addition to
`mic-detector.swift`'s `CoreAudio` (for `AVAudioEngine`/`AVAudioConverter`);
no additional non-Apple dependency.

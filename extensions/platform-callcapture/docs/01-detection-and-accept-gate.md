# Detection, package contents, and the Phase 2 accept gate

**Phase 1 + Phase 2 + Phase 3 + Phase 4 — detection, the notification/accept
gate, the dual-stream audio capture + streamed-STT pipeline, and end-to-end
integration + wiring.** Part of
`plan/phases/call-capture-extension.md` (local working notes, not in the repo);
see its "Phasing" section for the original per-phase scope. Phase 1 detects
"the microphone is in use" — a proxy for "a call is happening." Phase 2
adds the actionable OS notification, the click-listener bridge, and
accept/decline gating on top of Phase 1's detection output. Phase 3 proves
the hardest, least-certain piece in isolation: local dual-stream audio
capture (system audio + mic) with streamed STT. Phase 4 wires all three
together end-to-end, hosted inside `ethos serve`/`ethos gateway` — see
"Phase 4 — Integration" below for the finished wiring. A post-Phase-4 fix
(**"Per-process detection"**, near the end of this file) later replaced the
per-DEVICE detection approach described in the next section with a
per-PROCESS one, after a real stuck-recording bug in production use — read
that section for the current design; the section immediately below is kept
for history and is honest about what was true when Phase 1 shipped, not
about how detection works today. A second post-Phase-4 fix (**"Native
notification helper"**, also near the end of this file) later replaced
Phase 2's `terminal-notifier` dependency with a native `UserNotifications`-
based helper, after a real reported dark-mode banner-legibility bug — the
Phase 2 section below is likewise kept for history, not as a description of
today's notification mechanism.

## Approach: CoreAudio, not `ioreg`

The plan's decision 1 assumed `ioreg`'s classic class-filter trick
(`ioreg -c IOAudioEngine`) might work for detecting an active audio engine.
**It does not, on this hardware class.** Verified live on this machine
(Apple Silicon, Darwin 25.2): `ioreg -c IOAudioEngine` and
`ioreg -c AppleUSBAudioEngine` both match zero instances. Built-in audio
moved to DriverKit; `ioreg`'s own man page says "Do not consider DriverKit
classes with `-c`." This is a correction to the plan doc's premise, not a new
finding to fold back in — the plan should be read with this in mind for any
future phase that touches detection.

What does work, and is what this package uses: CoreAudio's
`kAudioDevicePropertyDeviceIsRunningSomewhere` property on the default input
device, watched via `AudioObjectAddPropertyListenerBlock`. This is:

- **Event-driven**, not polled — the callback fires exactly when the running
  state changes, so there's no tight loop and no measurable battery cost from
  continuous all-day background operation (a real requirement per the plan's
  Phase 1 scope note).
- **Zero third-party binaries.** Pure CoreAudio framework, ships on every Mac.
  Only `swiftc` is needed to build it, and that ships with Xcode Command Line
  Tools. This is a narrower dependency footprint than the plan's assumed
  manual-install-binary pattern (`terminal-notifier` for Phase 2,
  `audiotee`-style capture for Phase 3) — those still need a real third-party
  binary because they do real notification/capture work; this piece only
  watches a system-wide state flag, so it doesn't.
- **No mic-permission (TCC) prompt needed.** `DeviceIsRunningSomewhere` is a
  running-state flag, not raw audio — reading it doesn't require microphone
  access.

## What's in this package

- **`native/mic-detector.swift`** — the compiled watcher. **As of the
  per-process detection fix (see that section below), this watches known
  calling apps' individual audio activity, not the default input device** —
  the description immediately below is Phase 1's original, now-superseded
  per-device design, kept for history; see "Per-process detection" for the
  current one. Originally: watched the current default input device's
  running state, and separately watched
  `kAudioHardwarePropertyDefaultInputDevice` on the system object so it
  re-attached to a new device if the user switched inputs mid-run (e.g.
  plugging in headphones) without missing a state change. Emits one line of
  newline-delimited JSON per event to **stdout** — the current shape (see
  "Per-process detection" for the full contract):
  - `{"event":"initial","running":false,"at":"...Z"}` — the starting state,
    emitted once before entering the run loop, so the Node wrapper doesn't
    have to guess. Carries `"source"` when `running` is `true`.
  - `{"event":"running_changed","running":true,"source":"zoom.us","at":"...Z"}`
    — on every observed aggregate transition. `"source"` is the raw
    known-calling-app process name that triggered it (present only when
    `running` is `true` — an aggregate `false` doesn't name a single app).
  - `{"event":"error","message":"..."}` — on an API failure, then exits
    non-zero (currently unused in practice by the per-process design — see
    "Per-process detection" for why).

  Runs until killed (`SIGTERM`) — no fixed timeout in the shipped binary (a
  timeout was only used for the manual research probe that validated the
  original per-device approach before this package existed).

- **`src/detector.ts`** — `MicActivityDetector`, the Node wrapper. Spawns the
  compiled binary, parses its NDJSON stdout, and translates the raw
  `initial`/`running_changed` signal into the public
  `call_started` / `call_ended` / `error` contract. `call_ended` is debounced
  (default 2000ms, configurable) because the underlying signal can flicker
  for sub-second gaps — a bare state read would falsely report a call
  "ending" on every flicker. `call_started` is never debounced; it fires the
  instant the first `running: true` is observed, carrying a `source` field
  (the clean label from `process-prefilter.ts`'s `sourceLabelForProcessName`,
  e.g. `'zoom'`) resolved from the native event's raw process name. The
  binary spawn is injectable (`spawnFn`) so unit tests run entirely against
  a fake child process — no real hardware, no real mic, no compiled binary
  required in CI (which has no audio device anyway).

- **`src/detect-cli.ts`** — the Phase 1 manual-verification tool. Runs the
  real detector against the real compiled binary and logs every event with a
  timestamp. Standalone dev tool, not wired into `ethos`.

- **`src/preflight.ts`** — `checkCallCaptureDependencies()`'s combined
  dependency preflight, including a plain `existsSync` presence check for
  the compiled `capture-offer-card` binary (native/bin/), same as
  `mic-detector`/`mic-capture`/`audiotee`. **This file used to also export
  `checkNotificationHelperAvailable()`**, a binary-presence +
  notification-authorization-status check for the (now twice-superseded)
  `terminal-notifier` -> `notification-helper` accept-gate implementations
  — the description that used to be here, kept for history below, is no
  longer accurate: see "Fix — native capture-offer card, retiring
  `notification-helper`" for why that whole authorization dimension no
  longer applies. Never a swallowed `spawn ENOENT` either way — resolves a
  typed `{ ok: false; missing; errors }` naming the fix (`pnpm ... run
  build:native`) for whichever binary is absent.

- **`src/notification.ts`** — `NotificationGate`, the "show + wait for
  accept" surface. `presentCaptureOffer({ callId, title, message, source? })`
  spawns the compiled `capture-offer-card` binary (one persistent process
  per offer — see "Fix — native capture-offer card, retiring
  `notification-helper`" below), a custom AppKit card immune to system
  notification chrome theming, with its own Start/Skip buttons and an "x"
  dismiss. Returns a handle: `waitForOutcome()` resolves `{ outcome:
  'accepted' }` on Start, `{ outcome: 'expired' }` on Skip/"x"/`expire()`
  (a real call-ended or explicit decline collapse to the same non-accepted
  outcome — see that section for why a separate `'declined'` variant wasn't
  added), and any spawn failure resolves `{ outcome: 'error'; message }`
  immediately instead of throwing. Supersedes this file's original
  `terminal-notifier`-based implementation and its `notification-helper`
  (`UNUserNotificationCenter`) successor — see "Fix — native capture-offer
  card, retiring `notification-helper`" for the full story.

- **`src/phase2-cli.ts`** — the Phase 2 manual-verification tool. Wires the
  real `MicActivityDetector` to a real `NotificationGate`: `call_started`
  presents an offer; an accepted outcome logs "would have started capturing
  here"; `call_ended` before acceptance calls `expire()`.

## Error stream: stdout, not stderr

Both normal events and the native binary's own error line
(`{"event":"error",...}`) go to **stdout**. This is a deliberate choice, not
an oversight: the Node wrapper reads one NDJSON stream via `readline` against
`child.stdout`, and a native-side failure needs to reach that same parser as
a typed `error` event — not disappear into a separate stream nobody's
listening to. If the binary fails to spawn at all (e.g. not built yet),
`MicActivityDetector.start()` throws synchronously naming the exact fix.

## Building the native helper

Requires Xcode Command Line Tools (`swiftc`).

```sh
pnpm --filter @ethosagent/platform-callcapture run build:native
```

This compiles `native/mic-detector.swift` to `native/bin/mic-detector`.
`native/bin/` is gitignored (root `.gitignore`) — the compiled binary is a
build artifact, never committed.

## Manual verification

The actual point of Phase 1 is proving the signal works on real hardware,
not just passing unit tests against a fake. After building the native
helper:

```sh
pnpm --filter @ethosagent/platform-callcapture exec tsx src/detect-cli.ts
```

Then, in another terminal, trigger a real few-second mic recording (e.g. with
`ffmpeg`) and confirm the CLI logs `call_started` immediately and
`call_ended` a debounce window (~2s) after recording stops:

```sh
ffmpeg -y -f avfoundation -i ":0" -t 3 -loglevel error /tmp/callcapture-verify.wav
```

## Phase 2 — notification + accept gate

### The `terminal-notifier` dependency

Confirmed installed on the development machine via `brew install
terminal-notifier`: version **2.0.0**, at `/opt/homebrew/bin/terminal-notifier`.
It's a manual-install dependency, the same carve-out pattern as the compiled
`mic-detector` binary above — not vendored, checked by `preflight.ts` before
use.

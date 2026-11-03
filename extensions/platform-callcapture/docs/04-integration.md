# Phase 4 integration

## Phase 4 — Integration

Wires Phases 1-3 together end-to-end, hosted inside either always-on host
command: `ethos serve` (`apps/ethos/src/commands/serve.ts`) or `ethos
gateway` (`apps/ethos/src/commands/gateway.ts`) — both wire an identical
`CallCaptureDaemon` construction, so a deployment that only runs `ethos
gateway` (a normal choice — it's the multi-channel adapter host) gets the
same call-capture behavior as `ethos serve`. A later correction (code
review, post-Phase-4) replaced the original LLM-turn dispatch with direct,
deterministic dispatch — see "Direct dispatch" below for why.

Running both simultaneously with call capture configured is a normal,
expected deployment shape, not a hypothetical — `ethos run-all` starts both
by default, and each host command is separately documented as a viable
LaunchAgent target. A later correction (code review, round 3) added
cross-process coordination for exactly this: before constructing a
`CallCaptureDaemon`, each host attempts `tryClaimOwnership()`
(`src/ownership.ts`) on a shared PID-claim lock file
(`callCaptureLockPath()`, `~/.ethos/callcapture.lock`) via the same atomic
`O_CREAT|O_EXCL` + liveness-check + stale-cleanup technique
`extensions/team-supervisor/src/pid.ts` uses for its own single-instance
guarantee. Whichever process wins constructs and starts its daemon exactly
as before, and releases the lock on graceful shutdown; the process that
loses logs an informational message and skips daemon construction entirely
— a normal, correct outcome, not an error. Only the winning process ever
writes or removes the shared heartbeat file, which also closes the
heartbeat-deletion race this lock was originally missing: with only one
daemon owner, only one process can ever race itself.

### The full wiring

```
CallCaptureDaemon (src/daemon.ts)
  ├─ detector: MicActivityDetector           — Phase 1
  ├─ checkDependencies: checkCallCaptureDependencies  — Phase 2 + T5 preflight
  ├─ notificationGate: NotificationGate       — Phase 2
  ├─ wake: (reused) the SAME closure ethos serve's WatcherManager uses
  └─ runCapture: (abortSignal) => runCallCapture(callCaptureOpts, { ... })
       └─ runCallCapture (extensions/tools-callcapture, @ethosagent/tools-callcapture)
            ├─ TapCapture + MicCapture      — Phase 3 dual-stream audio
            ├─ runTranscriptSession          — Phase 3 streamed STT
            ├─ summarizeTranscript           — LLM content summary (decision 7)
            └─ memory.sync(...)              — transcript artifact + digest index
```

Each of `ethos serve` and `ethos gateway` constructs and starts its own
`CallCaptureDaemon` when (and only when) `process.platform === 'darwin' &&
config.callCapture?.personalityId` is set — a complete no-op (nothing
constructed, no behavior change) for every other deployment. `CallCaptureDaemon`
itself takes no dependency on `@ethosagent/watchers`: `wake` is a structural
port matching `WatcherManagerConfig.wake`'s shape, and each host command
passes the exact same `watcherWake` closure it already built for its own
`WatcherManager` — one wake path per host, not a duplicate.

### Process prefilter (decision 1's coarse prefilter — SUPERSEDED, folded into the detector)

**As originally wired in Phase 4** (kept here for history — see "Per-process
detection" below for the current design): decision 1 describes two signals:
mic-in-use (Phase 1's detection trigger) and a "coarse prefilter" using
process/app detection, explicitly scoped as "a coarse prefilter at best, not
the detection signal itself." Phase 4 wired this in as a separate
`CallCaptureDaemon` port, `checkCallingAppRunning: () => Promise<string |
null>` (`src/daemon.ts`), backed by `src/process-prefilter.ts`'s
`checkAnyCallingAppRunning()`, which ran `pgrep -x <name>` against
`KNOWN_CALLING_APP_PROCESSES` and required **both** signals — mic active AND
a known calling app running — before firing wake or the notification.

**Current state:** the per-process detection fix (below) made this separate
check redundant and it has been removed. The native detector now only ever
watches known calling apps in the first place (via `NSWorkspace`, not
`pgrep`), so a `call_started` event is already scoped to one by
construction — there is no longer a "mic active, but no known app running"
case for a downstream gate to filter out. `process-prefilter.ts` still
exists, narrowed to the `KNOWN_CALLING_APP_PROCESSES` registry and the
raw-name-to-clean-label lookup (`sourceLabelForProcessName`), which
`detector.ts` now uses directly when mapping the native detector's
`call_started` events.

**Known, deliberate, accepted limitation — unchanged by this fold-in, not a
bug, not something either the old or new design attempts to fix:** a browser
tab running a web-based call (e.g. Google Meet in Chrome) is still not
detected. Chrome/Safari/etc. are not calling-app-specific processes, and
neither `pgrep` name-matching nor `NSWorkspace` + per-process CoreAudio can
distinguish a calling tab from any other tab — `extensions/watchers`' own
`process` differ notes the identical gap. This narrows the feature's
real-world coverage for browser-based calling relative to native-app calls,
and is called out here explicitly rather than left as a silent gap.

### Direct dispatch: no LLM turn, no tool registry involved

`runCallCapture()` (`@ethosagent/tools-callcapture`) is a plain async
function, not a registered `Tool`. `CallCaptureDaemon`'s `runCapture`
option calls it directly and deterministically once the OS notification is
accepted — no chat turn, no LLM round-trip, no tool-call step in between.
`packages/wiring/src/build-agent-loop.ts` builds a bound closure
(`runCallCaptureFn`, closing over the constructed `TapCapture`/`MicCapture`/
STT/memory dependencies and the bound personality id) and threads it out
through `CreateAgentLoopResult.runCallCapture`; `serve.ts` wires that
straight into the daemon's `runCapture`.

This replaced an earlier design where the daemon told the LLM
`"Call call_capture_start now"` via `loop.run(prompt, { ... })` and hoped it
complied. That design closes two things a later review found:

- **INB-002 (live-turn injection):** the plan's stated default is
  memory-only, no live-turn injection. The LLM-turn design technically
  avoided injecting into an *existing* turn, but it still spun up a fresh
  one on every accepted call. Direct dispatch is stronger than even that
  narrower reading — there is no live turn for call capture at all, ever.
- **The tool-being-LLM-reachable security hole:** `call_capture_start` no
  longer exists as a registered `Tool`. There is nothing for an ordinary
  chat turn — or a prompt-injected one — to call. The only caller in the
  entire codebase is this daemon's accept-gated `runCapture`.

### Turn cancellation: a real mechanism, not a bounded-duration fallback

`CallCaptureDaemon` creates a fresh `AbortController` per accepted call and
passes `controller.signal` straight into `runCapture(abortSignal)`, which
the daemon's caller binds to `runCallCapture()`
(`extensions/tools-callcapture/src/index.ts`). `runCallCapture()` already
`await`s that signal and, on abort, stops both capture streams and saves
whatever was captured — this was true before Phase 4 and needed no change.
`CallCaptureDaemon` calls `controller.abort()` when the detector later
reports `call_ended` for that same call. This is the real, already-existing
seam this phase found and used — there is no bounded-duration safety-net
timer anywhere in this package, and none was needed.

### `ethos doctor` integration

Silent when call capture isn't configured — the same "don't warn about an
unused feature" rule the Channel SDKs section follows. When
`callCapture.personalityId` is set, `ethos doctor` runs
`checkCallCaptureDependencies()` and reports a "Call capture" section
naming every missing dependency (never just the first) with its exact fix
command. A configured-but-broken call-capture deployment is a hard failure
(`DoctorFailFlags.callCaptureDepsMissing`, exit 1) — the same weight
`ethos doctor` already gives a configured-but-missing channel SDK.

**Daemon liveness, not just binary presence.** The checks above verify
`capture-offer-card`/`mic-detector`/`mic-capture`/`audiotee` are present on
disk — they say nothing about whether a `CallCaptureDaemon` is actually
alive inside a running `ethos serve`/`ethos gateway` process right now. Both
host commands write a heartbeat (`src/health.ts`'s `callCaptureHealthPath()`,
`~/.ethos/callcapture-health.json`) every 10s while their daemon is running,
mirroring the gateway's own `gateway-health.json` heartbeat exactly.
`ethos doctor`'s `checkCallCaptureDaemonHealth()` reads it back with the same
30s-staleness rule `checkGatewayHealth` uses: `ok` (fresh heartbeat), `stale`
(the daemon started but its heartbeat has gone quiet — likely crashed;
hard failure, same weight as `gatewayStale`), or `down` (no heartbeat file —
not currently running inside either host command; informational only, not a
failure, since a configured deployment between runs of `ethos serve`/`ethos
gateway` is a normal state, not a broken one).

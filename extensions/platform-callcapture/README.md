# @ethosagent/platform-callcapture

## Purpose

macOS call-capture adapter: detects when a known calling app is using audio (per-process, via the compiled `mic-detector`), offers capture through a native accept card, records system audio plus mic as two independent streams, and runs streamed STT into a transcript. The `CallCaptureDaemon` is hosted inside `ethos serve` / `ethos gateway`; the package owns the native Swift helpers and the Node wrappers, and leaves the LLM turn, tool registry and storage to its hosts.

## Public surface

Exports from `src/index.ts` (values only; each also exports its option/handle types).

| Export | Kind | One line |
|---|---|---|
| `CallCaptureDaemon` | class | End-to-end detect, offer, capture, transcribe orchestrator. |
| `MicActivityDetector` | class | Wraps the native `mic-detector`; emits `call_started` / `call_ended` / `error`. |
| `NotificationGate` | class | Presents the native capture-offer card and resolves the accept outcome. |
| `CaptureIndicator` | class | Drives the floating recording indicator. |
| `MicCapture` | class | Mic PCM stream from the native `mic-capture` binary. |
| `TapCapture` | class | System-audio PCM stream from `audiotee`. |
| `CallCaptureOwnershipManager` | class | Single-owner claim for the daemon across processes. |
| `tryClaimOwnership` | function | One-shot ownership claim returning `ClaimOwnershipResult`. |
| `checkCallCaptureDependencies` | function | Preflight naming any missing native binary and the build fix. |
| `runTranscriptSession` | function | Streamed STT over the two capture streams. |
| `computeRmsLevel` | function | RMS level of a PCM chunk. |
| `startAudioCapture` | function | Spawns an audio child and waits for its ready line. |
| `pcmChunksFromStdout` | function | Turns a child's stdout into PCM chunks. |
| `createDefaultAudioSpawn` | function | Default `AudioSpawnFn` for `startAudioCapture`. |
| `callCaptureHealthPath` | function | Path of the daemon health file. |
| `callCaptureLockPath` | function | Path of the daemon lock file. |
| `KNOWN_CALLING_APP_PROCESSES` | const | Process names treated as calling apps. |
| `sourceLabelForProcessName` | function | Maps a raw process name to a clean source label. |

## Seam

Implements no `@ethosagent/types` platform interface directly; it is a self-contained adapter hosted by the CLI daemon and depends on `@ethosagent/types`, `voice-session` and `voice-text`. archcheck layer: `extensions`. Guarantees (spawn injection, fail-closed accept gate, ownership claim) are pinned by the tests below.

## Testing

```
pnpm vitest run extensions/platform-callcapture
```

Pinning tests:

- `src/__tests__/detector.test.ts`: NDJSON parsing and debounced `call_ended`.
- `src/__tests__/notification.test.ts`: accept/expire/error outcomes of the offer card.
- `src/__tests__/daemon.test.ts`: daemon state machine and fail-closed behaviour.
- `src/__tests__/ownership.test.ts`: single-owner claim.
- `src/__tests__/preflight.test.ts`: missing-binary reporting.
- `src/__tests__/process-prefilter.test.ts`, `audio-process.test.ts`, `mic-capture.test.ts`, `tap-capture.test.ts`, `transcript-session.test.ts`, `indicator.test.ts`.

## More

The full design history (phases 1 to 4 and the post-Phase-4 fixes), moved verbatim from the old README:

1. [Detection, package contents, Phase 2 accept gate](docs/01-detection-and-accept-gate.md)
2. [Phase 2 click bridge, Phase 3 audio capture](docs/02-accept-gate-and-audio-capture.md)
3. [Phase 3 output contract, STT, live verification](docs/03-audio-capture-verification.md)
4. [Phase 4 integration](docs/04-integration.md)
5. [Phase 4 flow diagram and LaunchAgent](docs/05-integration-flow-and-launchagent.md)
6. [Per-process detection fix](docs/06-per-process-detection.md)
7. [Native notification helper fix](docs/07-notification-helper.md)
8. [Native capture-offer card fix](docs/08-capture-offer-card.md)
9. [Floating recording indicator](docs/09-recording-indicator.md)

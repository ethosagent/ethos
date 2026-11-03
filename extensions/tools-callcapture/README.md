# @ethosagent/tools-callcapture

## Purpose

Call-capture pipeline. `runCallCapture` starts the two local capture streams, transcribes until the caller aborts, summarizes, writes a transcript and summary artifact to memory and appends a digest-index entry. It is a plain function, not a registered `Tool`, so the model cannot call it; capture hardware lives in `@ethosagent/platform-callcapture`.

## Public surface

Exported from `src/index.ts` (single entry, no subpaths).

| Export | Kind | One line |
|---|---|---|
| `runCallCapture` | function | Runs one capture session end to end. |
| `RunCallCaptureInput` | interface | Inputs for a session (abort signal, source hint). |
| `CallCaptureResult` | type | Outcome of a session. |
| `CallCaptureToolsOptions` | interface | Capture streams, STT provider, memory, optional Documents mirror, summary provider. |
| `CaptureBoundary` | interface | Start and stop contract a capture stream satisfies. |

## Seam

Consumes `MemoryProvider`, `SttProvider`, `LLMProvider` and `Storage` from `@ethosagent/types`. Archcheck layer: `extensions` (rule `extensions-implement-contracts` in `architecture.config.ts`). Rule `tools-read-env-through-ctx` bans `process.env` in `extensions/tools-*/src/**`, so config arrives through `ctx.*`. Tool conventions: `.claude/rules/providers-and-tools.md`. The file header says the only accept gate is the OS notification handled in `extensions/platform-callcapture/src/daemon.ts`; this package does not enforce it. Limitation: that claim is a comment, not pinned by a test here.

## Testing

```
pnpm vitest run extensions/tools-callcapture
```

Pinning tests in `src/__tests__/`: `src/__tests__/call-capture-start.test.ts` (unavailable when unconfigured, full capture flow, source default and sanitizing, plain roll-up when the LLM summary fails), `src/__tests__/artifact.test.ts` (digest line wraps the summary in `<untrusted>` when entries exist and stays one line).

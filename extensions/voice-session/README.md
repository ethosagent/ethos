# @ethosagent/voice-session

## Purpose

Streaming voice orchestration over `AgentLoop`. `VoiceSession` owns one live conversation: inbound PCM through VAD and endpoint detection, then STT, the agent turn, sentence chunking, TTS and a playout queue, with barge-in that aborts the turn and persists an honest interrupted reply. It is pure orchestration over injected dependencies; concrete STT and TTS providers live in `@ethosagent/voice-providers` and speakable-text helpers in `@ethosagent/voice-text`.

## Public surface

Single entry point `.` (`src/index.ts`), about 40 exports. Main entry points below.

| Export | Kind | One line |
|---|---|---|
| `VoiceSession` | class | The per-conversation orchestrator. |
| `VoiceSessionDeps` | type | Injected runner, STT, TTS, VAD, config, clock and logger. |
| `VoiceSessionConfig` | type | Session tuning, including filler text and tick interval. |
| `VoiceSessionEvent` | type | Events the session emits (speaking, interrupted, reply complete). |
| `VoiceSessionState` | type | Session state names. |
| `AgentTurnRunner` | type | The one method the session needs from the agent loop. |
| `Vad` | type | Voice activity detector contract. |
| `EnergyVad` | class | RMS energy `Vad`. |
| `rmsEnergy` | function | RMS of a PCM frame. |
| `EndpointDetector` | class | Turns VAD frames into committed utterances. |
| `PlayoutQueue` | class | Ordered, cancellable audio playout. |
| `createBufferedSttAdapter` | function | Adapts a batch `SttProvider` to the streaming shape. |
| `encodeWav` | function | Encodes PCM as WAV. |
| `DEFAULT_VOICE_FILLER_TEXT` | const | Default spoken filler during a slow tool call. |
| `BufferedVoiceSpanWriter` | class | Buffers per-turn latency spans for a sink. |
| `VoiceSpanRecorder` | type | Recorder contract the session writes spans to. |
| `summarizeLatency` | function | Percentile summary of turn latencies. |
| `turnLatenciesFromSpans` | function | Stage-owned time from cumulative spans. |
| `percentile` | function | Percentile helper. |
| `VOICE_LATENCY_BUDGET_MS` | const | Per-stage budget for the pipeline tier. |
| `VOICE_REALTIME_LATENCY_BUDGET_MS` | const | Per-stage budget for the realtime tier. |

Also exported: the stage lists `VOICE_LATENCY_STAGES` and `VOICE_REALTIME_LATENCY_STAGES`, and the latency and span types.

## Seam

Layer `extensions`. It consumes `SttProvider`, `StreamingSttProvider`, `TtsProvider`, `PcmChunk` and `AgentEvent` from `@ethosagent/types` and implements `VoiceSpanRecorder` (`BufferedVoiceSpanWriter`) and `Vad` (`EnergyVad`). The agent-loop drain rule (Non-negotiables in AGENTS.md) applies here: `src/__tests__/turn-tail.test.ts` pins that the final spoken fragment is not held behind turn-end work, and that the next turn's agent run waits until the previous iterator has drained.

## Testing

```
pnpm vitest run extensions/voice-session
```

- `src/__tests__/voice-session.test.ts`: happy path, barge-in once per speech onset and persisted as interrupted, `stop()` idempotent, tool-call filler and tick, `thinking_delta` and `tool_*` events never spoken.
- `src/__tests__/turn-tail.test.ts`: final fragment and `done.text` spoken at the terminal event, next turn waits for the drain.
- `src/__tests__/voice-session-spans.test.ts`: stt, first-sentence, first-audio and turn spans, provider stamped, error status on STT failure.
- `src/__tests__/latency-budget.test.ts`, `src/__tests__/span-writer.test.ts`: span differencing and buffered writing.
- `src/__tests__/endpoint-detector.test.ts`, `src/__tests__/vad.test.ts`, `src/__tests__/playout-queue.test.ts`, `src/__tests__/buffered-stt.test.ts`, `src/__tests__/wav.test.ts`: the building blocks.

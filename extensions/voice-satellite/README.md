# @ethosagent/voice-satellite

## Purpose

The shared wake-satellite runtime: a wake engine, the supervised capture state machine, and the node-protocol client that registers with a gateway and streams utterances. Both hosts (`ethos listen` and the Electron main process) wire the same pieces and differ only in where the microphone comes from. The audio device itself is a declared interface with no implementation here.

## Public surface

Single entry point `.` (`src/index.ts`), about 45 exports. Main entry points below.

| Export | Kind | One line |
|---|---|---|
| `CaptureMachine` | class | Supervised wake, capture, speak and re-arm state machine. |
| `CaptureMachineConfig` | type | Silence, minimum-speech and idle-timeout settings. |
| `CaptureMachineDeps` | type | Injected engine, VAD and sinks. |
| `CaptureState` | type | State names of the machine. |
| `createSatelliteClient` | function | Node-protocol client with reconnect, routing table and utterance uplink. |
| `SatelliteClient` | type | Client handle returned by `createSatelliteClient`. |
| `SatelliteClientOptions` | type | Node id, auth cookie, callbacks, mode. |
| `createWsSatelliteSocket` | function | `ws`-backed `SatelliteSocket`. |
| `SatellitePlayout` | class | Plays reply audio with staleness and barge-in discipline. |
| `createTranscriptWakeEngine` | function | Wake engine that matches a wake phrase in transcripts. |
| `transcriptWakeEngineFactory` | const | `WakeEngineFactory` for the transcript engine. |
| `createSherpaWakeEngineFactory` | function | Acoustic engine factory using `sherpa-onnx-node`, loaded lazily. |
| `WakeEngine` | type | Contract a wake engine implements. |
| `WakeEngineFactory` | type | Builds a `WakeEngine` from options. |
| `runSatelliteDoctor` | function | Probes devices, models and engines; returns rows. |
| `createEnergyFrameVad` | function | Frame-level energy VAD adapter. |
| `encodeUtteranceWav` | function | Encodes a captured utterance as WAV. |
| `CaptureDevice` | type | Declared microphone interface, no implementation here. |
| `PlaybackDevice` | type | Declared speaker interface, no implementation here. |

Also exported: `DEFAULT_PLAYOUT_DRAIN_WATCHDOG_MS`, `DEFAULT_PLAYOUT_SAMPLE_RATE`, `wakePhraseKey`, `normalizeUtterance`, `boundedLevenshtein`, and the wake, doctor, playout and socket types.

## Seam

Layer `extensions`. It implements no single `@ethosagent/types` interface; it speaks the node protocol from `@ethosagent/web-contracts` and drives `@ethosagent/voice-session`. The acoustic engine imports `sherpa-onnx-node` through a computed specifier, recorded as exception EX-017 for `extensions/voice-satellite/src/engines/sherpa-wake-engine.ts` in `architecture.config.ts`. Limitation: the barrel comment says importing it loads no audio library or native binding, but no test pins that.

## Testing

```
pnpm vitest run extensions/voice-satellite
```

- `src/__tests__/capture.test.ts`: arm and capture, minimum-speech discard, self-wake suppression while speaking, verified re-arm over repeated cycles, watchdog, idle timeout, mute.
- `src/__tests__/node-client.test.ts`: register and reconnect with backoff, malformed server frames dropped, throwing host callbacks contained, monotonic uplink `seq`, edge mode sends a transcript and no audio.
- `src/__tests__/playout.test.ts`: superseded utterance dropped, barge-in cancels old playout, re-arm receipt waits for `end()`.
- `src/__tests__/doctor.test.ts`: probe rows, throwing probe becomes a row, missing model and native peer named.
- `src/__tests__/transcript-wake-engine.test.ts`: wake phrase matching.

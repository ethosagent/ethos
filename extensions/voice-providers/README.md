# @ethosagent/voice-providers

## Purpose

The built-in speech providers. It ships speech-to-text and text-to-speech providers (OpenAI, Groq, a local OpenAI-compatible server, and a command-line wrapper), the two built-in realtime voice providers (OpenAI Realtime and Gemini Live), a fake realtime provider, and the conformance checks every provider must pass. The contracts themselves live in `@ethosagent/types`; the voice session loop that drives these providers is `@ethosagent/voice-session`.

## Public surface

Single entry point `.` (`src/index.ts`), about 60 exports. Main entry points below; each provider class also has a `*Factory` export and a `*Config` or `*Options` type.

| Export | Kind | One line |
|---|---|---|
| `OpenAiSttProvider` | class | `SttProvider` for OpenAI transcription. |
| `GroqSttProvider` | class | `SttProvider` for Groq transcription. |
| `LocalSttProvider` | class | `SttProvider` for a local Whisper-style server (`localhost:8000` default). |
| `CommandSttProvider` | class | `SttProvider` that runs a configured command on the utterance. |
| `OpenAiTtsProvider` | class | `StreamingTtsProvider` for OpenAI speech. |
| `LocalTtsProvider` | class | `StreamingTtsProvider` for a local server. |
| `CommandTtsProvider` | class | `TtsProvider` that runs a configured command. |
| `OpenAiRealtimeProvider` | class | `RealtimeVoiceProvider` over the OpenAI Realtime socket. |
| `GeminiLiveProvider` | class | `RealtimeVoiceProvider` over Gemini Live. |
| `openaiSttFactory` | function | Builds an OpenAI STT provider from config. |
| `openaiTtsFactory` | function | Builds an OpenAI TTS provider from config. |
| `geminiLiveFactory` | function | Builds a Gemini Live provider. |
| `registerBuiltInRealtimeProviders` | function | Registers both realtime providers under their provider ids. |
| `BUILT_IN_REALTIME_PROVIDERS` | const | The built-in realtime provider list. |
| `createWsRealtimeSocket` | function | `ws`-backed realtime socket. |
| `createFakeRealtimeProvider` | function | Scriptable fake realtime provider for tests. |
| `createFakeRealtimeServer` | function | Fake realtime server for socket-level tests. |
| `validateSttProvider` | function | Conformance check for an STT provider. |
| `validateTtsProvider` | function | Conformance check for a TTS provider. |
| `validateVoiceCaps` | function | Validates a `VoiceCapabilities` object. |
| `validateRealtimeProvider` | function | Conformance check for a realtime provider. |
| `runRealtimeContractSuite` | function | Runs the realtime contract checks against a target. |
| `REALTIME_CONTRACT_CHECKS` | const | Names of the realtime contract checks. |
| `transcribeOpenAiCompat` | function | Shared OpenAI-compatible transcription transport. |
| `synthesizeOpenAiCompat` | function | Shared OpenAI-compatible speech transport. |

`src/template/` is a copyable starter for a third-party voice provider plugin, not part of the package entry.

## Seam

Implements `SttProvider`, `TtsProvider`, `StreamingTtsProvider` and `RealtimeVoiceProvider` from `@ethosagent/types` (checked by `implements` in each provider file). STT providers declare `STT_CONTRACT_VERSION` and realtime ones `REALTIME_CONTRACT_VERSION`, both from `@ethosagent/types`; `validateVoiceCaps` in `src/conformance.ts` rejects an STT provider that declares an older version. Layer `extensions`. `extensions/voice-providers/` is on the raw-`node:fs` allow-list in `apps/ethos/src/__tests__/no-raw-fs.test.ts`, and `.claude/rules/fs-carveouts-host.md` names `command-tts` as the scratch-file case.

## Testing

```
pnpm vitest run extensions/voice-providers
```

13 files in `src/__tests__/`. Main ones:

- `src/__tests__/conformance.test.ts`: caps validation rejects empty formats and stale contract versions.
- `src/__tests__/realtime-contract.test.ts`: every registered realtime provider has a conformance target.
- `src/__tests__/realtime-openai.test.ts`, `src/__tests__/realtime-gemini.test.ts`: wire details, auth placement, session setup.
- `src/__tests__/realtime-registry.test.ts`: both built-ins register under their ids with the sample rates they speak.
- `src/__tests__/streaming-tts.test.ts`: streaming capability and the type guard, batch-only providers gated off.
- `src/__tests__/command-providers.test.ts`, `src/__tests__/local-providers.test.ts`, `src/__tests__/openai-compat.test.ts`: command, local and shared transport behaviour.
- `src/__tests__/third-party-proof.test.ts`: an external TTS provider registers with no core edits and built-in names cannot be shadowed.

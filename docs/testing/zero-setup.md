# Testing voice: zero-setup verification

[Back to the testing index](../../TESTING.md)

## 1. Zero-setup verification

Run from the worktree root (`/Users/mitesh/personal/sandbox/ethos-worktrees/voice-first-class`).

```bash
pnpm typecheck
pnpm lint
pnpm test
```

`pnpm check` runs all three in that order.

At the time of writing this branch ran **815 test files / 8768 tests** (the two
`doctor-provider-probe` cases that reach the network fail in an offline sandbox —
they fail identically on `main`). Those numbers are a snapshot, not a contract —
they drift every time a test lands. Treat a *failure*, not a count mismatch, as
the signal. (`find` reports more `*.test.ts` files on disk than vitest runs; a few
sit outside the `include` globs in `vitest.config.ts`.)

### The suites worth knowing by name

Voice text + resolution + wiring + the frozen-schema gate:

```bash
pnpm vitest run \
  packages/voice-text \
  packages/core/src/__tests__/voice-resolution.test.ts \
  packages/wiring/src/__tests__/voice-stack.test.ts \
  packages/types/src/__tests__/personality-field-count.test.ts
```

Verified: 8 files, 129 tests, ~1.2s.

Surfaces — browser talk-mode, web-api, gateway, providers, session:

```bash
pnpm vitest run \
  apps/web/src/features/voice \
  apps/web-api/src/voice \
  packages/web-contracts/src/__tests__/voice-socket.test.ts \
  apps/web-api/src/services/__tests__/voice.service.test.ts \
  extensions/gateway/src/__tests__/voice-trust-gate.test.ts \
  extensions/gateway/src/__tests__/voice-pipeline.test.ts \
  packages/config/src/__tests__/config-voice-trusted-plugins.test.ts \
  packages/config/src/__tests__/config-voice-provider-knobs.test.ts \
  extensions/voice-providers/src \
  extensions/voice-session/src
```

Verified: 23 files, 196 tests, ~1.6s.

The realtime tier — contract, providers, mint, control lane, browser:

```bash
pnpm vitest run \
  packages/types/src/__tests__/voice-realtime.test.ts \
  packages/voice-realtime-protocol/src \
  extensions/voice-providers/src/__tests__/realtime-contract.test.ts \
  extensions/voice-providers/src/__tests__/realtime-openai.test.ts \
  extensions/voice-providers/src/__tests__/realtime-gemini.test.ts \
  extensions/voice-providers/src/__tests__/realtime-registry.test.ts \
  extensions/voice-providers/src/__tests__/realtime-fake.test.ts \
  packages/core/src/__tests__/voice-realtime-roster-resolution.test.ts \
  apps/web-api/src/services/__tests__/voice-realtime-token.test.ts \
  apps/web-api/src/services/__tests__/voice-realtime-session-config.test.ts \
  apps/web-api/src/services/__tests__/voice-realtime-session-cost.test.ts \
  extensions/tools-voice/src/__tests__/realtime-host.test.ts \
  apps/web-api/src/voice/__tests__/realtime-control-lane.test.ts \
  apps/web-api/src/voice/__tests__/realtime-control-deps.test.ts \
  apps/web/src/features/voice/__tests__/realtime-voice-call-client.test.ts \
  apps/web/src/features/voice/__tests__/realtime-control-channel.test.ts \
  apps/web/src/features/voice/__tests__/talk-mode-client.test.ts \
  apps/web/src/features/voice/__tests__/voice-call-reducer.test.ts \
  apps/web/src/features/voice/__tests__/call-strip.test.ts \
  apps/web/src/features/voice/__tests__/call-strip-css.test.ts \
  apps/web/src/features/voice/__tests__/call-strip-layout.test.ts \
  apps/web/src/features/voice/__tests__/mic-meter.test.ts
```

Verified: 22 files, 292 tests, ~11s. What each defends is in
[4b. The realtime tier](realtime-tier.md#4b-the-realtime-tier); every one of them runs against
fakes, with no credential and no socket.

The wake stack — satellite package, node protocol, the `/satellite/ws` lane,
`ethos listen`, the desktop host, and the Settings surfaces:

```bash
pnpm vitest run \
  extensions/voice-satellite/src \
  packages/web-contracts/src/__tests__/satellite-socket.test.ts \
  packages/core/src/__tests__/lane-key.test.ts \
  apps/web-api/src/voice/__tests__/satellite-socket.test.ts \
  apps/web-api/src/voice/__tests__/implicit-wake-routes.test.ts \
  apps/web-api/src/voice/__tests__/wake-privilege.test.ts \
  apps/web-api/src/__tests__/services/config-wake-routes.test.ts \
  apps/ethos/src/__tests__/listen-command.test.ts \
  apps/ethos/src/__tests__/listen-doctor.test.ts \
  apps/ethos/src/__tests__/listen-node-id.test.ts \
  apps/ethos/src/__tests__/listen-capture-device.test.ts \
  apps/desktop/src/main/__tests__/satellite.test.ts \
  apps/web/src/features/voice/__tests__/wake-routes.test.ts \
  apps/web/src/features/voice/__tests__/wake-route-row.test.ts \
  apps/web/src/features/voice/__tests__/satellite-rows.test.ts
```

Verified: 18 files, 248 tests, ~3.2s. No microphone, no model file, no native
binding — every device and socket is injected.

What each one is defending:

| Suite | Pins |
|---|---|
| `apps/web/src/features/voice/__tests__/talk-mode-regression-pin.test.ts` | The browser talk loop before the streaming rewrite: utterance → transcribe → turn → **ordered** playout, sentence pipelining, barge-in, the thinking earcon gate, and dropped phantom utterances |
| `apps/web-api/src/voice/__tests__/voice-lane.test.ts` | The server end of the binary lane: a superseded utterance's transcript/audio is dropped rather than sent, bounded capture and utterance maps, and **cross-lane isolation** — two lanes sharing an utterance id and one provider service never see each other's audio |
| `apps/web-api/src/voice/__tests__/voice-socket.test.ts` | The upgrade policy (path, Origin, auth cookie) and one real `ws` round trip, including the lane dying with a dropped socket |
| `apps/web/src/features/voice/__tests__/webaudio-playout.test.ts` | Absolute-time pacing: consecutive buffers are contiguous on the audio clock however late or jittery their arrival, and a dry queue never schedules into the past |
| `apps/web/src/features/voice/__tests__/streaming-voice-call-client.test.ts` | The streaming conversation: PCM up, audio down, stale results dropped, barge-in keeps only what was heard, and a WS drop discards the in-flight utterance |
| `packages/voice-text/src/__tests__/drift-gate.test.ts` | That no second copy of `sanitizeForSpeech` / `splitSentences` / `isHallucination` reappears in gateway, voice-session, web-api or web |
| `packages/core/src/__tests__/voice-resolution.test.ts` | The four resolution outcomes (`not_configured`, `unknown_provider`, `untrusted_provider`, `init_failed`) and the `resolveVoicePreferences` precedence table |
| `packages/wiring/src/__tests__/voice-stack.test.ts` | `buildVoiceStack`: absent config → `null`, the `trustedVoicePlugins` egress gate, transport construction, personality voice beating global config |
| `extensions/gateway/src/__tests__/voice-trust-gate.test.ts` | The same gate on the gateway lane, including "gate off when no allowlist is passed" |
| `packages/config/src/__tests__/config-voice-trusted-plugins.test.ts` | That declaring `voice.trustedPlugins` *at all* arms the gate, and that an empty list is a distinct, meaningful value |
| `extensions/voice-providers/src/__tests__/streaming-tts.test.ts` | That `local-tts` / `openai-tts` really stream: chunks yielded as the body arrives, in order, one request per sentence — and that a batch-only provider is still gated off |
| `extensions/voice-session/src/__tests__/playout-queue.test.ts` | Sentence prefetch: N+1 synthesizes while N plays, playout never reorders, nothing runs more than one sentence ahead, and cancel aborts the prefetched item |
| `packages/config/src/__tests__/config-voice-provider-knobs.test.ts` | That `auxiliary.tts.outputFormat` / `timeout` / `maxTextLength` and `auxiliary.asr.timeout` are lifted onto `EthosConfig` and survive a write/read round-trip |
| `extensions/voice-providers/src/__tests__/conformance.test.ts` | `validateSttProvider` / `validateTtsProvider`, incl. the refusal of a v1 STT provider that still declares the deleted `transcribe(audioPath)` |
| `packages/types/src/__tests__/personality-field-count.test.ts` | That `PersonalityConfig` has exactly the 28 fields in `.personality-field-count` — adding `voice` bumped it from 27 |
| `extensions/personalities/src/__tests__/voice-personality.test.ts` | The built-in `voice` personality: its declared voice block, its restricted toolset, and the ~2k-token static-prompt budget (latency decision L5) |
| `packages/core/src/__tests__/voice-origin-annotation.test.ts` | That a spoken turn is marked on the MESSAGE (never in the system prompt), rides alongside the audio marker rather than replacing it, reaches the `before_tool_call` payload, and leaves a mixed typed+spoken session's static prefix byte-identical |
| `packages/core/src/__tests__/spoken-style-injector.test.ts` | That the spoken-style block is personality-gated, static, and does not move the prompt prefix between turns |
| `packages/wiring/src/__tests__/spoken-confirmation.test.ts` | The spoken-confirmation gate — including that a far-end caller's voice can never satisfy an owner confirmation, even with a recorded confirmation on the same call id |
| `extensions/gateway/src/__tests__/voice-personality-voice.test.ts` · `apps/web-api/src/services/__tests__/voice-personality-voice.test.ts` | That the personality's voice reaches the TTS provider on the channel and browser paths, asserted on the provider's argument |
| `extensions/voice-satellite/src/__tests__/capture.test.ts` | The supervised capture machine: five consecutive wake → capture → speak → re-arm cycles, self-wake suppression (frames never reach the engine while speaking or thinking), the playback watchdog force-re-arming and reporting `degraded`, the idle timeout ending LISTENING **only**, and two machines in one process staying independent |
| `extensions/voice-satellite/src/__tests__/doctor.test.ts` | That `runSatelliteDoctor` never throws — a throwing engine probe becomes a row, a missing model directory is named, an unrun probe is `skipped` rather than passed on a guess, and the absent `sherpa-onnx-node` peer is reported unavailable with the reason |
| `extensions/voice-satellite/src/__tests__/transcript-wake-engine.test.ts` | The transcript matcher: phrase at the **head** of the utterance, one-character tolerance that widens with sensitivity, longest-phrase-wins, disabled routes never matching, `privileged` never inferred, and `push()` on raw PCM always returning null. The greeting rule itself (a leading `hey` optional on both the route phrase and the utterance, and a two-letter name matching only exactly) is pinned in `packages/voice-text/src/__tests__/wake-match.test.ts` |
| `extensions/voice-satellite/src/__tests__/node-client.test.ts` | The node protocol client: register under the stable `nodeId`, capped jittered reconnect backoff, re-register on reconnect, malformed server frames dropped rather than thrown on, and the audio/`transcript` alternation refused if a node tries both for one utterance |
| `apps/web-api/src/voice/__tests__/satellite-socket.test.ts` | The `/satellite/ws` upgrade policy (path, Origin, `ethos_auth` cookie, no-Origin daemons allowed), one real `ws` round trip, and the **server-side phrase gate**: a matched transcript runs on the MATCHED personality with the phrase stripped, an unmatched one runs no turn and calls no model, a `phraseMatch: true` node is not double-gated, a matched privileged personality without opt-in is refused, follow-ups inside the addressing window continue without a phrase and stop outside it, a different phrase switches personality and lane while each keeps its history (D15), and a reconnect drops the window but not the session |
| `apps/web-api/src/voice/__tests__/implicit-wake-routes.test.ts` | The synthesized bare-name table: privileged personalities get nothing, a configured route (even a disabled one) suppresses the implicit one, a phrase is claimed once (compared with the greeting stripped, so `hey engineer` and `engineer` are one claim), and ties break by personality id |
| `apps/web-api/src/voice/__tests__/wake-privilege.test.ts` | That privilege is derived from the approval layer's own consequential-tool lists, and an **absent** toolset is privileged (fail-closed) |
| `apps/ethos/src/__tests__/listen-doctor.test.ts` | The 0 / 1 / 2 exit matrix, probe→flag derivation, URL derivation, and the false-available case (eng-review D10): a missing model reports unavailable, the host degrades, nothing crashes |
| `apps/ethos/src/__tests__/listen-command.test.ts` | That the daemon refuses to start deaf — no pipe, an unresolvable `--route` pin, or no usable engine each stop the boot rather than printing "listening" — the open-mic banner (everything transcribed, only a personality's name reaches an agent, follow-ups inside the window), the four closing lines a turn can end on (answered, refused, no speech, addressed to nobody) — each keyed to what happened to THAT utterance, so a refusal never closes with `not addressed to anyone` under the error explaining the refusal — and the `--json` shape including `daemonMode: "open-mic"` |
| `apps/desktop/src/main/__tests__/satellite.test.ts` | The doctor gate (no capture device → `degraded`, nothing starts), that no entry point throws, the routes-push arming path, and wake-off surviving a restart (Hermes #81531) |

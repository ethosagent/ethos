# Testing voice: known gaps, part 1

[Back to the testing index](../../TESTING.md)

## 6. Known gaps / not yet built

Do not go hunting for these. They do not exist on this branch.

### 1. Streaming TTS — wired, including the browser
`local-tts` and `openai-tts` implement `synthesizeStream` and declare
`caps.streaming`, and `VoiceSession` uses it: audio is emitted chunk-by-chunk as the
`/v1/audio/speech` response streams, and sentence N+1 is synthesized while N is
still playing (`extensions/voice-session/src/playout-queue.ts`). A provider without
`caps.streaming` still takes the batch path unchanged.

Browser talk-mode uses it too, over the binary WS lane described in §2:
`VoiceService.synthesizeStream` (`apps/web-api/src/services/voice.service.ts:863`)
yields the provider's chunks when `isStreamingTtsProvider` holds and falls back to
one `synthesize` call when it does not, and `createVoiceSocket` wires exactly that
into the lane (`apps/web-api/src/voice/voice-socket.ts:88`). The batch
`voice.synthesize` RPC is still there — it is what the Play button and the
personality-editor Preview call, and what the WS-less fallback path uses.

Still batch-only: `command-tts`, and every STT provider (`openai-stt`, `groq-stt`,
`local-stt`, `command-stt`).

### 2. Binary-PCM WebSocket + WebAudio playout — now the default
Browser talk-mode opens **one persistent WebSocket** at `GET /voice/ws` and carries
binary frames both ways: mic PCM up, synthesized audio down. No base64, no JSON
audio bodies, no per-utterance HTTP. Playout is `AbsolutePlayout` (WebAudio),
which schedules each buffer where the previous one ended on the audio clock.

The batch RPC path is still there and still works — `talk-mode-client.ts` falls
back to it when a browser lacks `WebSocket`, `AudioContext`, `getUserMedia` or
`createScriptProcessor` (and on `forceBatch`). Both paths emit the same events,
so the UI is identical.

Two honest limits:

- **Sentence-granular, not frame-granular, for container codecs.** `local-tts` and
  `openai-tts` emit opus; a mid-stream opus slice is not independently decodable,
  so the lane tags those frames `codec: 'encoded'` and the browser decodes each
  SEGMENT (one sentence) at `segment_end`. A provider that emits `pcm` gets true
  frame-by-frame playout. First audio still starts long before the reply finishes.
- **No resampling.** The mic's PCM goes up at the `AudioContext`'s own rate
  (typically 48 kHz) and the lane wraps it in a WAV header for the STT provider.

Proof: `apps/web-api/src/voice/__tests__/`, `apps/web/src/features/voice/__tests__/`
(`webaudio-playout`, `voice-socket-transport`, `pcm-endpointer`,
`streaming-voice-call-client`, `talk-mode-client`, `wake-lock`).

Manual verification still needed (nothing in CI drives real audio): a real mic in a
real browser, a real STT/TTS server behind it, and the reconnect + wake-lock paths
on a phone.

### 3. Personality voice — wired on every surface that speaks
`resolveVoicePreferences` used to have exactly one consumer
(`packages/wiring/src/voice-stack.ts`), so a personality's `voice.tts_voice`
changed its character sheet and nothing you could hear on the two surfaces most
people reach first. It now has three:

- `packages/wiring/src/voice-stack.ts` — the `VoiceSession` stack;
- `extensions/gateway/src/index.ts` — channel replies, via the optional
  `personalityDirectory.voice(id)` seam;
- `apps/web-api/src/services/voice.service.ts` — the browser `synthesize` RPC
  **and** the binary WS lane, from the `personalityId` the client now sends.

Precedence is the same everywhere because it is the same function:
`voice.languages.<tag>` > `voice.tts_voice` > global `auxiliary.tts.voice`.

The **Play button** on an assistant bubble sends `personalityId` too
(`apps/web/src/components/chat/PlayButton.tsx`), so click-to-hear speaks in the
personality's own voice rather than the deployment default. Only the id travels —
the voice, the provider and the local-only egress gate are all resolved
server-side.

The gateway does detect the language of an inbound voice note, but only against
the personality's OWN `voice.languages` keys
(`extensions/gateway/src/index.ts:2069`, tested in
`extensions/gateway/src/__tests__/voice-language.test.ts`): a personality with no
language map produces no guess and its default voice stands, which is the
behaviour that existed before. Detection is on the voice-note path only — a typed
turn is not sniffed for language.

Two related caveats on the `VoiceSession` stack itself, both from the source:
the LiveKit and SIP transports additionally require app-supplied native
bindings, which **no in-repo caller passes yet** (`build-agent-loop.ts:969-970`),
and nothing in-repo currently reads `result.voiceStack` to drive a live
session — you hold the stack and call `createSession()` yourself.

### 4. Two list-valued config keys are still unreachable
`auxiliary.tts.outputFormat`, `auxiliary.tts.timeout`, `auxiliary.tts.maxTextLength`
and `auxiliary.asr.timeout` used to be matched by the parser and then dropped — the
factories read them, nothing supplied them. They are lifted now: parser →
`EthosConfig` → `providerConfigFrom()` → the provider (`packages/config/src/index.ts`,
`packages/wiring/src/voice-stack.ts`, `packages/wiring/src/build-agent-loop.ts`).
A garbage value (`timeout: soon`, `outputFormat: flac`) is dropped, so the provider
default stands.

Still unreachable, deliberately: `auxiliary.tts.voices` and `auxiliary.asr.languages`.
Both are lists, and the flat `key: value` parser has no list encoding for them; both
only populate advisory `caps.voices` / `caps.languages`, which nothing in the repo
enforces. They are documented nowhere — do not write them expecting an effect.

### 5. CallStrip and the per-personality voice editor — both shipped
The talk-mode UI is the CallStrip (`apps/web/src/features/voice/TalkMode.tsx`):
nine states — connecting, listening, thinking/consulting, speaking, barge-in,
reconnecting, degraded-to-text, mic-permission-denied, plus the idle entry points
— with a live caption line and the `{provider} · {model}` mono label. See
DESIGN.md § CallStrip.

The realtime tier added three renderings on top of those nine, none of which is a
new state word:

- **A tier notice above a live strip.** Realtime was refused or dropped and the
  call is continuing on the pipeline. Dismissible, and never silent — unlike
  `degraded`, which replaces the strip, this one sits above a working call.
- **A `budget reached` mono chip** beside the state word during the spoken
  wind-down, with the sign-off as the caption.
- **A realtime detail row.** `{realtime provider} · {model}` (one provider serves
  the whole turn, so there is no STT/TTS pair to show) plus a `use private mode`
  control that takes the call to the pipeline deliberately.

Settings → Voice now edits every voice key the plans introduced, including
`voice.trustedPlugins`, `voice.defaultMode`, the per-channel
`voice.channels.<platform>.ttsOut` switches, the advanced `voice.transcode.*` and
`voice.artifacts.*` fields, and the `auxiliary.*` timeouts and
output format. It also carries a read-only delivery-status readout over the
`deliveries.summary` RPC — pending / redelivering / delivered / abandoned counts,
with the same counts restricted to `kind = 'voice'`. One edge stays config-file only: an allowlist that is **declared
but empty** (`voice.trustedPlugins:` with no value) arms the gate with nothing
trusted. Settings treats an empty list as "gate off" because the web config
writer cannot round-trip an empty value; write that line by hand if you want it.

A personality's own `voice.*` block is edited in the Personalities tab
(`apps/web/src/components/personality/PersonalityVoiceFields.tsx`). All eight
sub-keys are there — `tts_provider`, `tts_voice`, `stt_provider`,
`realtime_provider`, `call_style`, `tier`, `model`, and the
`languages.<tag>` map as a dense row editor. The block stays FROZEN as a schema:
these are sub-keys of the existing `voice` object, so `.personality-field-count`
is untouched at 28. The character sheet still renders the block read-only.

`voice.tier` now has a consumer: `VoiceService.mintRealtimeToken`
(`apps/web-api/src/services/voice.service.ts`) runs it through
`resolveVoicePreferences` against the deployment's `voice.tier`, and an explicit
`pipeline` refuses the mint with `pipeline_preferred`. Absent from both means
"try realtime". The global default is editable in Settings → Voice.

`voice.model` — the fast-lane model for spoken turns — now has a consumer on the
**pipeline tier**. `buildVoiceStack.createSession` (`packages/wiring/src/voice-stack.ts`)
resolves it through `resolveVoicePreferences` and wraps the supplied runner, so
every turn on that lane carries `RunOptions.modelOverride` without each host
having to remember it. `AgentLoop` consumes the field in its turn-setup stage and
it lands on `CompletionOptions.modelOverride`; `run_start` and the `llm_call`
span name the pinned model, so telemetry cannot claim the default answered.

The routing ladder, pinned by `packages/core/src/__tests__/model-tier.test.ts`
(`model routing precedence`) on what the LLM provider was actually asked for:

```
RunOptions.modelOverride  >  tierOverride  >  personality model  >  deployment default
```

No deployment-level fast-lane default is passed as `globalModel`: `config.voice.*`
has no such key, and `config.model` is the agentic default — the one model L5
exists to keep off the spoken lane. The fast-lane model resolves from the
personality alone.

Two gaps remain. The **realtime tier** does not use it: a realtime call's model
comes from the roster entry (`selection.entry.model` in `mintRealtimeToken`), not
from the personality's `voice.model`. And a personality whose toolset carries
`think_deeper` can still escalate off the pinned model mid-turn — the escalation
in `agent-loop/stages/stream-step.ts` outranks the pin. The built-in `voice`
personality carries no such tool, so nothing shipped hits it.

```bash
pnpm vitest run \
  packages/core/src/__tests__/model-tier.test.ts \
  packages/wiring/src/__tests__/voice-stack.test.ts
```

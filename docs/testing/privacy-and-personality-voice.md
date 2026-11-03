# Testing voice: privacy and per-personality voice

[Back to the testing index](../../TESTING.md)

## 3. Privacy — arming the local-only egress gate

One key turns "no audio leaves this machine" from a habit into a rule:

```yaml
voice.trustedPlugins:
```

**Declaring the key at all arms the gate.** An empty value means *local providers
only*. Providers advertising `caps.local` (`local-stt`, `local-tts`, `command-stt`,
`command-tts`) always pass; every other provider must be named:

```yaml
voice.trustedPlugins: openai-tts, elevenlabs
```

Omitting the key entirely leaves the gate **off** — which is why an empty list is a
meaningful value and not the same as absence.

The refusal, verbatim from `packages/core/src/providers/voice-resolution.ts`:

```
TTS provider "openai-tts" is not local and is not in voice.trustedPlugins — refusing to send audio off this machine
```

It fires at *resolution*, before the provider is ever handed a byte, and it fires on
every surface because they all resolve through the same two functions:

- gateway (`extensions/gateway/src/index.ts`) — voice notes in and out
- web-api `VoiceService` — browser transcribe/synthesize, **including a provider
  picked live in Settings → Voice**
- `buildVoiceStack` — the realtime session stack
- `ethos doctor` — reports it instead of hiding it

Proof:

```bash
pnpm vitest run \
  extensions/gateway/src/__tests__/voice-trust-gate.test.ts \
  packages/core/src/__tests__/voice-resolution.test.ts \
  packages/config/src/__tests__/config-voice-trusted-plugins.test.ts \
  packages/wiring/src/__tests__/voice-stack.test.ts
```

Manual check: set `voice.trustedPlugins:` (empty) and `auxiliary.tts.provider:
openai-tts`, then run `ethos doctor`. The TTS line turns red with the refusal above.

In the UI: **Settings → Voice → Restrict voice egress** arms the gate and edits the
allowlist. The switch off deletes the key (gate off); the switch on writes the
providers you list. The declared-but-EMPTY form above is the one shape Settings
cannot write — the web config writer drops an empty value — so set that line by
hand if you want "trust nothing non-local".

---

## 4. Per-personality voice

`PersonalityConfig.voice` is set with dotted keys in a personality's `config.yaml`
(`~/.ethos/personalities/<id>/config.yaml`):

```yaml
name: Talker
description: Speaks first, thinks second
model: claude-sonnet-4-5
voice.tts_voice: af_bella
voice.tier: pipeline
voice.model: claude-haiku-4-5
voice.languages.es: ef_dora
voice.languages.ja: jf_alpha
```

- `voice.tts_voice` — the voice id handed to the TTS provider. Free-form; it is
  whatever your server calls it.
- `voice.tier` — `pipeline` or `realtime`. An unknown value is **dropped**, not
  thrown on: a bad voice id must not make a personality unloadable.
- `voice.model` — a fast-lane model for spoken turns. Live on the pipeline tier:
  `buildVoiceStack.createSession` pins it onto the lane's runner, so every turn
  on that lane routes to it (latency decision L5).
- `voice.languages.<BCP-47 tag>` — per-language voice override.

Precedence (`resolveVoicePreferences`, `packages/core/src/providers/voice-resolution.ts`):

```
voice.languages.<tag>  >  voice.tts_voice  >  auxiliary.tts.voice (global)
```

Confirm it parsed:

```bash
ethos personality show talker
```

`renderCharacterSheet()` emits a `## Voice` block — TTS voice, the language map,
tier, fast-lane model — and omits the section entirely when the personality declares
no `voice` block.

```
## Voice
- TTS voice: af_bella
- ...
- Tier: pipeline
- Fast-lane model: claude-haiku-4-5
```

> **Which surfaces honor this today.** All three: the `VoiceSession` stack built
> by `buildVoiceStack`, channel replies through the gateway, and browser
> talk-mode. Every one of them resolves through the same
> `resolveVoicePreferences`, so "which voice served this reply" has one answer.
>
> - **Channel voice notes / replies** — the gateway reads the personality's
>   `voice` block through the optional `personalityDirectory.voice(id)` seam
>   (wired in `apps/ethos/src/commands/gateway.ts`) and passes the resolved
>   voice to `tts.synthesize`. The language rung is live here too:
>   `detectLanguage()` (`@ethosagent/voice-text`) reads the transcript and is
>   constrained to the tags the personality declares in `voice.languages`, so a
>   Spanish voice note comes back in the Spanish voice. A personality that
>   declares no language map supplies no candidates, no guess is made, and the
>   default voice wins — the behaviour that existed before detection did.
> - **Browser talk-mode and the Play button** — the client sends `personalityId`
>   (and, where known, `language`) alongside the global voice it read from
>   Settings; `VoiceService` applies the precedence server-side. The global
>   value the client sends is the *lowest* rung, so a personality's declared
>   voice is heard over it rather than being overridden by it.
>
> Proof, asserting what the TTS provider actually received:
>
> ```bash
> pnpm vitest run \
>   extensions/gateway/src/__tests__/voice-personality-voice.test.ts \
>   apps/web-api/src/services/__tests__/voice-personality-voice.test.ts \
>   apps/web-api/src/voice/__tests__/voice-lane.test.ts \
>   apps/web/src/features/voice/__tests__/streaming-voice-call-client.test.ts
> ```
>
> The **`Play` button** on an assistant bubble passes it too:
> `apps/web/src/components/chat/PlayButton.tsx` builds its `voice.synthesize`
> input through `playbackRequest(text, personalityId)`, threaded down from the
> message list. Only the id crosses — the voice, the provider and the egress gate
> are resolved server-side, on the one precedence path above.

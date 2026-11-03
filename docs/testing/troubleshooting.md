# Testing voice: troubleshooting

[Back to the testing index](../../TESTING.md)

## 7. Troubleshooting

**No audio out at all.**
Run `ethos doctor` first — it answers this in one line.
- `– TTS not configured.` → no `auxiliary.tts.provider`.
- `✗ TTS: … refusing to send audio off this machine` → `voice.trustedPlugins` is
  armed and your provider is not local. Add its id to the list, or switch to
  `local-tts` / `command-tts`.
- `✗ TTS: Unknown TTS provider "…" — not registered` → typo. Valid ids:
  `openai-tts`, `local-tts`, `command-tts` (STT: `openai-stt`, `groq-stt`,
  `local-stt`, `command-stt`).
- `✗ TTS: … failed to initialize: command-tts requires a command template` → you
  selected `command-tts` without setting `auxiliary.tts.command`.
- Doctor green but still silent → the provider resolves but the server is down.
  Doctor makes no network calls. `curl` the `baseUrl`. On `command-tts`, run your
  template by hand and check the output file is non-empty — `say -o out.mp3` writes a
  16-byte silent file without erroring.

**Play button missing on assistant messages.**
It renders on the server-reported `voice_tts` capability, which is `auxiliary.tts.provider`
being set. Set it, then reload — restart `ethos serve` after editing `config.yaml`.

**Empty transcripts / "Could not transcribe audio — try again".**
Two different causes, same message:
1. *Format mismatch.* The MIME type the browser or channel sends is passed straight to
   the provider. `command-stt` picks the temp-file extension from that MIME
   (`AUDIO_EXT_BY_MIME`, defaulting to `wav`) and CLI transcribers sniff the container
   from the suffix — an honest MIME matters. Server-backed providers just forward the
   bytes; if the server rejects the container, you get an empty result.
2. *The hallucination filter dropped it.* `isHallucination()` discards known STT
   phantoms on silence or noise: "thanks for watching", "please subscribe", a lone
   "you", `[music]`, `...`, and any short phrase repeated three or more times. That is
   working as designed — but it means a genuinely quiet recording looks identical to a
   failure. Speak louder/longer and retry before suspecting the provider.

**Talk-mode phone button greyed out.**
The personality's toolset does not list `voice_session`. The tooltip says so. Add it to
`~/.ethos/personalities/<id>/toolset.yaml`; personalities hot-reload, no restart.

**Talk-mode connects but never hears you / cuts you off mid-sentence.**
Tune it live in **Settings → Voice → Advanced**. Raise `endpointSilenceMs` if it ends
your utterance too early; raise `speechThreshold` if room noise keeps triggering;
raise `bargeThreshold` / `bargeSustainMs` if the agent's own playout is echoing back
and interrupting itself.

**Tests time out at 15s on a busy machine.**
`vitest.config.ts` sets `testTimeout: 15_000` with `retry: 0` locally. Under load — a
full `pnpm test` alongside a build, or a heavily loaded laptop — mock-heavy suites
*unrelated to voice* can blow that budget purely from transform and worker contention.
**Re-run the failing file in isolation before believing you found a regression:**

```bash
pnpm vitest run <the-one-failing-file>
```

If it passes alone, it was load. If it fails alone, it is real.

---

## See also

- `docs/content/using/how-to/local-voice.md` — the canonical local-server recipe
- `docs/content/using/reference/config-yaml.md` — every `voice.*` config key,
  including the realtime roster, `voice.tier` and the per-session budget
- `docs/content/using/reference/personality-yaml.md` — the personality's own
  `voice.*` block
- `apps/web/src/features/voice/README.md` — the browser tiers, both transports,
  and what only a human can verify
- `extensions/voice-providers/src/template/` — scaffold for a third-party provider
- `extensions/voice-providers/src/conformance.ts` — `validateSttProvider` /
  `validateTtsProvider`; a provider that passes these is callable by every surface
- `extensions/voice-providers/src/realtime-conformance.ts` — the 11-check realtime
  contract suite every registered realtime provider is run through

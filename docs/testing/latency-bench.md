# Testing voice: latency, the bench

[Back to the testing index](../../TESTING.md)

## 6b. Latency — the bench

Two tiers, two modes, one module
(`extensions/voice-session/src/latency-budget.ts`).

Pipeline tier (`VOICE_LATENCY_BUDGET_MS`):

| Stage | Budget | What it covers |
|---|---|---|
| `endpoint` | ≤300ms | Last speech frame → the turn starting. Includes the configured silence threshold. |
| `stt` | ≤200ms | Committed audio → final transcript. |
| `llm_first_sentence` | ≤800ms | Transcript → first sentence handed to synthesis. |
| `tts_first_audio` | ≤300ms | First sentence → first audio frame out. |
| `pipeline` | ≤1600ms | Mouth to ear. |

Realtime tier (`VOICE_REALTIME_LATENCY_BUDGET_MS`) — three stages, because one
hosted session owns hearing, thinking and speaking and reports one moment:

| Stage | Budget | What it covers |
|---|---|---|
| `endpoint` | ≤300ms | Same human fact as above, but the threshold belongs to the **provider's** server VAD (500ms by default on OpenAI Realtime), which no deployment setting can shorten. A live run will normally miss this and still make the total. The number is printed, not moved to fit. |
| `realtime_first_audio` | ≤500ms | What is left for the hosted session to think and start speaking. Separable only when the provider marks the commit before its first audio; several transcribe asynchronously and do not, and then the endpointing is inside this stage. The bench reports which case it saw. |
| `pipeline` | ≤800ms | Mouth to ear. The only stage measured **directly** on this tier, and the reason the tier exists. |

```bash
pnpm bench:voice                  # pipeline tier, mock providers, no credentials
pnpm bench:voice:realtime         # realtime tier, shared fake provider, no credentials
pnpm bench:voice:live             # pipeline tier against ~/.ethos/config.yaml
pnpm bench:voice:live:realtime    # realtime tier against a configured roster entry + key
```

`pnpm bench:voice:realtime` verified here — 5 turns, all three stages PASS:

```
  Stage                 p50    p90    p99    Budget   Result
  --------------------  -----  -----  -----  -------  ------
  endpoint              254ms  261ms  261ms  ≤ 300ms  PASS
  realtime_first_audio  360ms  363ms  363ms  ≤ 500ms  PASS
  pipeline              614ms  615ms  615ms  ≤ 800ms  PASS
```

The mock timings come from `--realtime-commit-ms` / `--realtime-audio-ms`, so
that run "exercises the measurement path, not a provider" — the script's own
words, printed under the table. A real number needs
`pnpm bench:voice:live:realtime` (a roster entry and a key) or a deployment's own
`realtime_first_audio` spans.

Both pipeline modes drive a real `VoiceSession` and read the **per-turn spans it
writes** — the same telemetry a deployment sees — so the bench cannot report a
number the product does not. The realtime modes drive a real `RealtimeSession`
(the shared fake provider, or the configured one) and build the same
`realtime_first_audio` span a deployed call writes. Live mode adds `--turns=N`
(default 10) and reports p50/p90/p99 per stage; budgets are checked against
**p90** on both tiers. `--assert-budget` exits non-zero on a miss.

Because the spans are cumulative from the turn start, the arithmetic that turns
them into stage-owned time lives in `latency-budget.ts` and is unit-tested
(`extensions/voice-session/src/__tests__/latency-budget.test.ts`) — `scripts/`
is outside the vitest globs, so a budget implemented only in the script would be
a budget nobody checks.

Live mode measures STT and TTS against the **real configured providers**,
resolved through the same functions (and the same egress gate) every surface
uses. The LLM is deliberately a fixed reply so model variance stays out of the
TTS numbers. Without `--audio=<file.wav>` the bench feeds a synthetic tone: a
real transcriber returns nothing for it, so only the STT stage is reported. Pass
a recorded 16-bit PCM WAV of someone speaking to get the whole pipeline.

`--endpoint-silence-ms=N` (default 250) sets how much silence the detector waits
for. It is part of endpoint latency by definition, so a threshold at or above
300ms can never meet the endpoint budget.

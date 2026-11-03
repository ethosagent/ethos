# Testing voice: the realtime tier

[Back to the testing index](../../TESTING.md)

## 4b. The realtime tier

The second voice tier shipped: one hosted speech-to-speech session owns hearing,
thinking and speaking, instead of STT → agent turn → TTS. Browser talk-mode holds
the provider socket itself, opened with a credential the server minted; the app
keeps a second **control** socket for transcripts, `agent_consult`, cost accrual
and the turn-latency report.

### Configuring it

```yaml
voice.realtime.providers.live.provider: openai-realtime
voice.realtime.providers.live.model: gpt-realtime
voice.realtime.providers.live.apiKey: ${secrets:voice/realtime/providers/live/apiKey}
voice.realtime.providers.live.costPerMinuteUsd: 0.06
voice.realtime.default: live
voice.realtime.sessionBudgetUsd: 1.50
voice.tier: realtime
```

`live` is a label the operator chose, not a provider id — the egress gate keys on
the entry's `provider` and the constructed provider's `caps.local`, so calling an
entry `local-anything` buys nothing. Settings → Voice edits every key above. The
full field reference is
[`docs/content/using/reference/config-yaml.md`](../content/using/reference/config-yaml.md#voice-realtime-providers).

Two providers are registered (`extensions/voice-providers/src/realtime-registry.ts`):
`openai-realtime` and `gemini-live`.

### Gemini Live is contract-only — stated as a limitation

`gemini-live` exists to prove the provider contract is **not OpenAI-shaped**: a
different wire vocabulary, and 16 kHz in / 24 kHz out against OpenAI's 24/24. It
is exercised by the shared conformance suite like any other provider.

It declares `caps.ephemeralToken: false` (`extensions/voice-providers/src/realtime-gemini.ts`),
so `VoiceService.mintRealtimeToken` refuses with `no_browser_token` and the call
continues on the pipeline tier behind a visible notice. **There is no server-relay
path in this phase** — nothing in `apps/web-api` opens a Gemini session on the
browser's behalf. Selecting it as your realtime default means every browser call
falls back to the pipeline, by design, and says so on screen. Do not read the
"server-relayed" wording in the provider header as a shipped feature.

### What is covered automatically

Everything below runs against fakes — no credential, no socket, nothing that
leaves the machine. The one command that runs all of it is in
[§1](zero-setup.md#the-suites-worth-knowing-by-name).

| Suite | Pins |
|---|---|
| `packages/types/src/__tests__/voice-realtime.test.ts` | `REALTIME_CONTRACT_VERSION`, the single audio format, exhaustive handling of every `RealtimeEvent` variant, and that the contract is implementable — including by a provider that omits both optional methods |
| `extensions/voice-providers/src/realtime-conformance.ts` | The shared suite itself — the 11 checks in `REALTIME_CONTRACT_CHECKS`, from "caps and provider shape" to "audio supplied at the declared INPUT sample rate reaches the wire unresampled" |
| `extensions/voice-providers/src/__tests__/realtime-contract.test.ts` | Those 11 checks run per **registered** provider, via `describe.each(registry.list())`. A provider added to the registry without a conformance target fails the coverage guard rather than shipping untested |
| `realtime-openai.test.ts` · `realtime-gemini.test.ts` | Per-provider detail that is not contract: model pinning, headers, handshake shape |
| `realtime-registry.test.ts` | That both built-ins register under their configured ids, and that each declares the sample rates it actually speaks |
| `realtime-fake.test.ts` | `extensions/voice-providers/src/realtime-fake.ts` — the one provider-level fake, shared by the conformance harness and the mock bench, so the thing the tests drive and the thing the bench drives are the same thing |
| `packages/voice-realtime-protocol/src/__tests__/browser-safety.test.ts` | That nothing reachable from the browser entry points imports `ws` or a `node:` builtin — the frame mapping is shared verbatim between browser and server |
| `packages/core/src/__tests__/voice-realtime-roster-resolution.test.ts` | Roster selection and the egress gate keying on the **resolved provider**, never the roster label |
| `apps/web-api/src/services/__tests__/voice-realtime-token.test.ts` | Every typed refusal — `not_configured`, `unknown_entry`, `untrusted_provider`, `no_browser_token`, `provider_unavailable`, `pipeline_preferred` — and that no refusal message carries key material |
| `...voice-realtime-session-config.test.ts` | What is baked into the credential before the mint: the personality's identity plus the boundary policy as instructions, the advertised tool list, and the voice — the personality's beating the roster entry's. A surface that throws leaves a usable session rather than taking the call down |
| `...voice-realtime-session-cost.test.ts` | Per-minute rate selection from the entry the mint would pick; an unpriced entry reported as unpriced, never as free |
| `extensions/tools-voice/src/__tests__/realtime-host.test.ts` | **advertised == handled** — every advertised tool definition is dispatched, and a name never advertised is refused rather than left hanging |
| `apps/web-api/src/voice/__tests__/realtime-control-lane.test.ts` | No dead air over 2s during a slow consult, strict FIFO consults, per-minute accrual tick by tick, a wind-down that speaks then closes in that order, and provider-stamped latency spans |
| `...realtime-control-deps.test.ts` | Lane keying `voice:<botKey>:browser:<id>`, resumed on reconnect, never interleaved with the typed chat in the same browser session |
| `apps/web/src/features/voice/__tests__/realtime-voice-call-client.test.ts` | The browser's provider link: the token carried in a subprotocol with no handshake of its own, capture at the provider's input rate, playout at its output rate, barge-in keeping the honestly-spoken prefix, an expired credential re-minted rather than redialled, and the backoff schedule spent once before degrading to text |
| `realtime-control-channel.test.ts` | The control socket, including the `realtime_turn_latency` report |
| `talk-mode-client.test.ts` | Tier selection, and the pin that `no_browser_token` is **never a silent downgrade** |
| `voice-call-reducer.test.ts` | Call state and the `[interrupted]` marker shared by history and screen |
| `call-strip.test.ts` · `call-strip-css.test.ts` · `call-strip-layout.test.ts` | The DR5 contract: ≥44px touch targets, `prefers-reduced-motion` stopping every pulse, and the caption staying on screen at 375px instead of being traded for the fit |
| `mic-meter.test.ts` | That reduced motion stops the meter bars in JS — the stylesheet cannot, because the bars are redrawn every frame |

The wire contract for the browser's latency report is `RealtimeTurnLatencySchema`
in `packages/web-contracts/src/voice-socket.ts`.

### What needs credentials, and what only a human can check

**Nothing in CI touches any of this.**

An **OpenAI key with Realtime access** plus a `voice.realtime.providers.<name>`
entry is the only path that mints a real browser credential and opens a real
provider socket. Everything in the table above uses fakes. Gemini Live cannot be
exercised from a browser at all, by design (above).

Manual only, because no fake can stand in:

- **Real mic and speakers.** Capture at the provider's own input rate (24 kHz for
  OpenAI Realtime, 16 kHz for Gemini Live — nothing resamples), absolute-time
  playout, audible barge-in, the thinking earcon, and the screen wake lock.
- **A real network blip on a phone.** Two independent socket backoffs: the app
  lane repeats its last delay forever, the provider socket walks the schedule once
  and then degrades to text.
- **Real mouth-to-ear.** `pnpm bench:voice:live:realtime`, or a deployment's own
  `realtime_first_audio` spans. The mock bench "exercises the measurement path,
  not a provider" — its own words, printed on every run.
- **A real per-minute invoice**, reconciled against the accrued cost. The rate is
  a number the operator typed; nothing verifies it against the provider's bill.

### One honest measurement limit

A deployed realtime turn writes exactly one span: `realtime_first_audio`, the
browser's own measurement of last speech frame → first audio frame. The budget
module reads it as mouth-to-ear. **`endpoint` is absent and unmeasurable** — the
provider owns the VAD and never reports when it decided — so the endpointing sits
*inside* the reported number, making it an upper bound. The browser's own capture
and playout legs sit outside it and are simply not measured.

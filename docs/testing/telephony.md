# Testing voice: telephony

[Back to the testing index](../../TESTING.md)

## 4c. Telephony

A phone number is the one voice surface with a stranger on the other end, and it is
also the one whose end-to-end path **has never been run against a live trunk**. What
follows separates the two halves honestly: almost all of the decision-making is
exercisable with no credentials at all, and only the audio and the real provider
payloads need something you supply.

### What works with zero credentials

The whole inbound path *except the audio* runs against fakes: signature
verification for all four schemes, payload parsing, bot resolution, the four gates,
the receptionist decision, the call-log row transitions, and the owner notification
riding the delivery ledger.

```bash
pnpm vitest run --maxWorkers=4 \
  extensions/call-log \
  extensions/platform-voice/src/__tests__/sip-webhook.test.ts \
  extensions/platform-voice/src/__tests__/inbound-gate.test.ts \
  extensions/platform-voice/src/__tests__/sip-trunk-livekit.test.ts \
  extensions/platform-voice/src/__tests__/livekit-token.test.ts \
  extensions/platform-voice/src/__tests__/g711.test.ts \
  extensions/platform-voice/src/__tests__/frame-pacer.test.ts \
  extensions/platform-voice/src/__tests__/realtime-bridge.test.ts \
  apps/ethos/src/__tests__/sip-webhook-server.test.ts \
  apps/ethos/src/__tests__/sip-inbound-dispatch.test.ts \
  apps/ethos/src/__tests__/livekit-media.test.ts \
  packages/wiring/src/__tests__/far-end-consult.test.ts \
  packages/wiring/src/__tests__/voice-stack.test.ts \
  packages/config/src/__tests__/config-voice-telephony.test.ts \
  apps/web-api/src/__tests__/services/calls.service.test.ts \
  apps/web-api/src/__tests__/services/config-voice-telephony.test.ts \
  packages/web-contracts/src/__tests__/voice-calls.test.ts \
  apps/web/src/features/voice/__tests__/call-row.test.ts \
  apps/web/src/features/voice/__tests__/call-rows.test.ts \
  apps/web/src/features/voice/__tests__/call-row-css.test.ts \
  apps/web/src/pages/__tests__/voice-telephony.test.ts \
  extensions/gateway/src/__tests__/notify-tracked.test.ts
```

```
 Test Files  22 passed (22)
      Tests  335 passed (335)
```

| Suite | Pins |
|---|---|
| `sip-webhook.test.ts` | All four signature schemes, each failing closed with its own distinct reason; Twilio's `bodySHA256` commitment; LiveKit's missing-`exp` treated as expired; Telnyx's raw-vs-PEM Ed25519 key; and the parsers refusing a non-call payload rather than throwing |
| `inbound-gate.test.ts` | Gate order (budget → rate → concurrency → allowlist), a refusal releasing every resource it took, the sliding hour window, the UTC budget rollover, and `prewarm` policy resolution |
| `sip-webhook-server.test.ts` | The listener's status codes — `202` verified, `401` generic-bodied, `200 {ignored}` for a non-call event, `404` for the wrong method or path — and that the handler never blocks on dispatch |
| `sip-inbound-dispatch.test.ts` | The whole ring: unrouted number → `screened` + owner notice, each refusal reason → its status, the receptionist pin, the `ringing`→`live`→`completed` row, and the concurrency slot released on a setup that never reached `live` |
| `extensions/call-log` | `SQLiteCallLog` / `InMemoryCallLog` agreeing, the same-millisecond rowid tie-break, a duplicate id rejected rather than overwriting, and `pruneEnded` never touching a `ringing` or `live` row at any age |
| `far-end-consult.test.ts` | That a call's consult pins `speaker: 'far_end'` and the receptionist personality — the field the spoken-confirmation gate refuses on |
| `livekit-media.test.ts` | The optional-dependency loader: "not installed" and "installed but will not load" as distinct reasons, and a module missing any required export refused at boot rather than mid-call |
| `sip-trunk-livekit.test.ts` · `livekit-token.test.ts` | The Twirp request the SIP control plane receives, the signed JWT's grants, and credentials redacted out of a provider's error body before it can reach a log |
| `g711.test.ts` · `frame-pacer.test.ts` | μ-law/A-law round-trips, and absolute-time pacing that does not drift over a long call |
| `realtime-bridge.test.ts` | The SIP↔provider bridge — built and covered, and with **no production caller** (see below) |
| `config-voice-telephony.test.ts` (×2) | Every `voice.trunk` / `voice.inbound` / `voice.bargeIn` key parsing, refusing, and round-tripping through both the CLI loader and the web config service |
| `calls.service.test.ts` · `voice-calls.test.ts` · `call-row*.test.ts` | The `voice.calls.{list,active,get}` contract, the direction/state filters, and the CallRow's reduced-motion and live-state rendering |

You can also read the whole configured surface without a trunk. `ethos doctor`
prints its telephony rows inside the existing `Voice` section, and the one thing it
actually *runs* is the media resolution:

```bash
ethos doctor
```

With no `voice.*` block at all it prints one line and does not pay for a native
import:

```
  –  Telephony not configured (no voice.*).
```

### What each credential unlocks

| You supply | What becomes real | What stays fake |
|---|---|---|
| `voice.livekit.{url,apiKey,apiSecret}` | The SIP control plane: outbound dialling via `call`, and room access-token minting. Both are plain HTTPS with a signed JWT — no SDK, no native binary | Nothing dials during tests; `ethos doctor` reports the client "constructible — not dialled from here" |
| `voice.trunk.webhookSecret` | The inbound listener starts at all. Without it the gateway prints a warning and leaves it off, because an unsigned webhook is an open line | Real provider payload shapes — the parsers are written against published docs, not captured requests |
| `@livekit/rtc-node` installed on the host | Audio. `resolveLiveKitMedia()` loads it at gateway startup and `voiceStack.createSipAdapter` comes into existence | The adapter's assumptions about the SDK's room/track/frame API. Every one is marked `ASSUMPTION:` in `apps/ethos/src/livekit-media.ts` and none has been executed |
| A realtime provider key | Nothing on the call path today. The bridge tier is not constructible from the gateway — see the gap below | The entire sub-second call tier |

Without the media binding a call is still **verified, gated, screened or answered,
logged, and summarised to the owner**. It simply carries no voice, and both the
startup banner and `ethos doctor` say so in those words.

### The three inert knobs

Named here so nobody tunes them and waits for an effect:

- **`voice.inbound.prewarm`** — the decision is computed on every ring and returned
  in the dispatch outcome, and nothing opens a socket, because
  `createSipRealtimeBridge` has no caller outside its own tests.
- **`voice.trunk.codec`** — parsed, validated and round-tripped through Settings,
  and passed to nothing. Same root cause as `prewarm`: the only thing that
  consumes a wire codec is that same bridge (`deps.codec` in
  `extensions/platform-voice/src/sip/realtime-bridge.ts`), so with no production
  caller the media leg never negotiates from this key. Nothing even maps the
  config's `opus`/`g711` onto the bridge's `pcm`/`g711u`/`g711a`.
- **`voice.bargeIn.satellite.silenceMs`** — parsed, validated, editable in Settings,
  and read by nothing. The satellite `CaptureMachine` ends an utterance on a count
  of silent audio *frames*, and a frame is only a duration once the capture device
  reports its frame size, so there is no honest conversion for the config layer to
  make. The surface's other two fields are wired
  (`readSatelliteVadTuning` in `apps/ethos/src/commands/listen.ts`), as is all of
  `voice.bargeIn.call.*` (`packages/wiring/src/voice-stack.ts`).

  `voice.bargeIn.browser.*` used to sit in this list. It is gone from the union:
  the browser talk lane endpoints in the browser, from `display.voice_*`, and the
  key is now a parse error that names that path.

**`voice.inbound.dailyBudgetUsd` used to sit here too, and no longer does.** The
`meterSpend` wrapper in `apps/ethos/src/sip-inbound-dispatch.ts` reports each
`usage` event's `estimatedCostUsd` as a call's turns stream, and the callback
calls `gates.budget.record(usd)` (line 313) on the same `VoiceInboundGates`
instance `decideInboundCall` consults. The cap genuinely trips.

Know what it counts before you rely on it. The recorded figure is **LLM token
spend only**, at the provider's own estimate. STT, TTS, LiveKit media and PSTN
minutes are not in it — nothing in the process knows those prices, and no rate
was invented for them — and on a voice call they are plausibly the larger half of
the bill. So the cap trips on real spend, but trips **late** relative to a day's
true cost. Under-counting is the safe direction for a gate whose job is refusing
calls; a fabricated per-minute rate would not be.

Two other tiers spend money and never touch this counter: the browser/realtime
voice tier and channel voice notes do not route through this dispatcher, so their
spend does not count against the cap at all.

**Nothing joins the room on an outbound call**, so `call` places the trunk leg
and the callee hears silence. That gap is unchanged.

Outbound calls used to write no call-log row either. They now do —
`extensions/tools-voice/src/index.ts:208` writes `direction: 'outbound'` — and
what such a row does and does not assert is worth knowing before you read one:

- It opens `ringing` before the dial. A trunk rejection patches it to `failed`
  with a real `endedAt`.
- A trunk-accepted dial patches it to `completed` with a reason string and **no
  `endedAt`**. `completed` is an assertion this process never verified — the call
  may have rung out unanswered, and nothing stayed on the line to find out. The
  reason string on the row discloses that inline. With no `endedAt` the row
  leaves `listLive()` and renders no duration, which is what "nobody timed this
  call" looks like.
- The row carries no `personalityId`, no `tier` and no `costUsd`.
- `fromNumber` records as the literal `unknown` when `voice.trunk.fromNumber` is
  unset, because the column is `NOT NULL`.
- Only the **gateway** wires a `CallLog`. A call placed from `ethos serve`,
  `ethos chat` or desktop writes no row at all.

### Manual verification required

Nothing in CI dials a number, and the plan says so explicitly — live-call
verification is manual by design.

- **A real inbound call** on a rented number, end to end: ring → verified → gated →
  answered → `completed` row → summary on the owner's channel.
- **Each provider's real webhook payload.** Twilio form-encoded, Telnyx `call.*`
  events, LiveKit participant attributes — one captured request per provider would
  retire the largest single assumption here.
- **Twilio behind a real TLS terminator.** Its HMAC commits to the public URL, so
  the proxy's `X-Forwarded-Proto` / `X-Forwarded-Host` are load-bearing, and getting
  them wrong is a `401` that looks like a bad secret. Note also that Twilio's scheme
  carries **no timestamp**, so no replay window is enforced for it — the other three
  get one.
- **`@livekit/rtc-node` against a running `livekit-server`.** The first live call is
  what proves or breaks every `ASSUMPTION:` marker in the adapter.
- **A spoken confirmation on a live call** — that a caller's "yes" really cannot
  satisfy an owner-level approval in practice, not only in the ordering test.
- **The concurrency cap under real simultaneous calls**, with frame pacing intact.

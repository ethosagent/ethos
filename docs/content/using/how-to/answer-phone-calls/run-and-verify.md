---
title: "Give an agent a phone number: run, place and verify calls"
description: "Start the gateway, follow an inbound call, place an outbound call, and verify."
kind: how-to
audience: user
time: "15 min"
updated: 2026-11-03
---

## Task

Start the gateway with telephony configured, watch an inbound call move through the gates, place an outbound call, and verify the setup with `ethos doctor`.

## Result

A call to the number is verified, gated, logged under **Communications → Calls**, and summarised on the owner's channel. `ethos doctor` shows `✓` on every `Voice` row.

## Prereqs

- Complete [steps 1 to 3](../answer-phone-calls.md): the trunk is configured, the webhook is exposed, and the media binding is installed.

## 4. Start the gateway

```bash
ethos gateway start
```

```
  sip: http://127.0.0.1:3005/sip/inbound
```

A trunk configured without a webhook secret, or without an owner, is called out here rather than at the first call.

### What happens when the number rings

The order is fixed, and each step can end the call:

1. **Verified.** The signature is checked over the raw bytes. A failure answers `401` with a generic body; the specific reason (`missing_signature_header`, `stale_timestamp`, `body_hash_mismatch`, …) goes to the gateway console only, so a 401 is not a probe oracle.
2. **Parsed.** A verified request that is not a call event — a status callback, a keepalive — gets `200 {"ignored": true}` so the provider stops retrying it. A call gets `202` immediately; nothing blocks a ringing phone.
3. **Routed.** `voice.bots[].match` picks the bot and its personality. No match writes a `screened` row and notifies the owner anyway — a call nobody hears about is the failure this exists to prevent.
4. **Gated,** cheapest refusal first: daily budget, then per-caller hourly limit, then the concurrency cap, then the receptionist check. A refusal releases whatever it took, so a wall of refused calls leaves the concurrency counter at zero.
5. **Answered or screened.** Every caller reaches `voice.inbound.receptionist`, whose own memory (scope `personality:<receptionist-id>`, fixed by turn setup) and `toolset` *are* the restriction — the call turn carries no user id, so no owner memory and no privileged tools, by construction. With no receptionist configured, every caller is refused instead. Caller ID is set by whoever places the call and is trivially spoofed, so a `voice.inbound.allowlist` match is only a pre-warm hint: it does not reach the bot's own personality (`decideInboundCall` in `extensions/platform-voice/src/sip/inbound-gate.ts`). No inbound call reaches the bot's own personality until a caller-verification step exists.
6. **Logged.** A row in `~/.ethos/calls.db` moves `ringing` → `live` → `completed`, or lands terminal as `screened`, `refused`, or `failed`. Live rows are never pruned at any age.
7. **Summarised.** On hang-up the transcript runs through the post-call summary, which is written onto the row and delivered to `voice.inbound.owner` through the delivery ledger — a pending obligation before the platform call, confirmed only on a real ack, redelivered by the next gateway start if it was lost.

Every turn on a call carries `speaker: 'far_end'`. The spoken-confirmation gate refuses a far-end request *before* it consults any recorded confirmation, so a caller's confident "yes" can never satisfy an owner-level approval.

## 5. Place an outbound call

`call` reports itself unavailable until both `voice.trunk.*` and `voice.livekit.*` are configured — the tool and the deployment derive that from one function, so "advertised" and "can dial" cannot disagree.

Add `voice` to the personality's `toolset.yaml`, then ask for a call in chat. The tool is in the always-ask approval list in every approval mode, so it stops and asks:

```
call → to_number: "+15551234567"
```

Approve it and the trunk dials:

```
Calling +15551234567 (call SCL_xxx, room call-15551234567).
```

One limit to know before you rely on this. **Nothing joins the room on the Ethos side for an outbound call** — the trunk connects the callee, but no agent participant is created, so the callee hears silence. Outbound dialling is the trunk leg only.

The call *is* written to the call log, as `direction: 'outbound'`, and the row is honest about how little it knows. It opens `ringing` before the dial. A trunk rejection closes it as `failed` with a real end time. A trunk-accepted dial closes it as `completed` with a reason string and **no end time** — nothing stays on the line, so whether the callee answered was never observed, and the row says exactly that rather than reading as "the call went fine". Expect no `personalityId`, `tier` or cost on the row, and a `fromNumber` of `unknown` when `voice.trunk.fromNumber` is unset. Rows are written only under `ethos gateway`; a call placed from `ethos serve`, `ethos chat` or the desktop app writes none.

## 6. Watch calls in the web UI

Open **Communications → Calls**. Calls that are up appear first under **In progress** with the duration ticking; below them, history filtered by direction and state chips. A row opens its transcript and summary.

The `tier` column stays empty on every row: nothing writes it, because the realtime bridge that would report which stack served the call is not yet reachable from the gateway (see [Verify](#verify)).

Cost is written, but only on an inbound row and only when the accrued figure is above zero — a call that ended before it drove an LLM turn shows nothing rather than a zero, so an empty cost on a short call is not a broken column. Outbound rows carry no cost at all: nothing joins the room, so no turn ever runs to meter. What the figure counts and what it leaves out is in [What is not verified](#what-is-not-verified).

## Verify

Run the doctor. Telephony rows sit inside its existing `Voice` section:

```bash
ethos doctor
```

```
Voice
  ✓  STT local-stt (local)
  ✓  TTS local-tts (local)
  ✓  SIP trunk twilio (trunkId ST_1, from +15550000000)
  ✓  Inbound webhook secret set (listener mounts at /sip/inbound)
  ✓  LiveKit control plane (wss://your-project.livekit.cloud; token minter + SIP trunk client constructible — not dialled from here)
  ✓  LiveKit media @livekit/rtc-node 0.13.0 (calls can carry audio)
     Inbound gates: concurrency 2; per-caller/hour unlimited; daily budget unlimited; prewarm allowlisted (default)
     Allowlist 1 pattern(s); receptionist receptionist; owner telegram:4242
     +15550000000 → sha256(+15550000000) → personality receptionist
```

The middle token on the mapping row is the bot key. It reads `sha256(<match>)` for an entry with no `id:`, as above; set `voice.bots.0.id` and that row shows the id you chose instead.

Then call the number from a phone. A `screened` or `completed` row should appear under **Communications → Calls**, and a summary should arrive on the owner's channel.

### What is not verified

The end-to-end call path has **never been run against a live trunk**. Its verification is manual by design — CI covers webhook signatures, the inbound gate, dispatch, and the call log against fakes, and nothing in the suite dials a number. Specifically unproven:

- The `@livekit/rtc-node` adapter's assumptions about the SDK's room, track, and audio-frame API.
- Every provider's real webhook payload shape. The parsers are written against published documentation, not captured requests.
- Whether a spoken confirmation actually holds on a live call.

Two settings are configurable but inert today, and are named here rather than left for you to discover:

- **`voice.inbound.prewarm`** is parsed and the decision is computed per call, but nothing opens a provider socket on ring — the SIP↔realtime bridge is built and unit-tested and has no production caller.
- **`voice.trunk.codec`** is parsed and passed to nothing; the media leg does not negotiate from it.

**`voice.inbound.dailyBudgetUsd`** is no longer among them: spend is now recorded per call and the cap really trips. Know what it counts before you rely on it. The recorded figure is **LLM token spend only**, at the provider's own estimate — STT, TTS, LiveKit media and PSTN minutes are not in it, because nothing in the process knows those prices and no rate was invented for them. The cap therefore trips on real spend, but trips *late* relative to a day's true cost. Browser talk-mode and channel voice notes do not route through the call dispatcher, so their spend never counts against it at all.

`voice.bargeIn.call.*` is no longer among them: `energyThreshold` and `minSpeechMs` tune the SIP lane's VAD and `silenceMs` its endpoint detector, applied when the call adapter builds the session.

`voice.bargeIn` now covers two surfaces, `call` and `satellite`. One hole remains inside them: `voice.bargeIn.satellite.silenceMs` is accepted and read by nothing, because a satellite ends an utterance on a count of silent audio frames and a frame is only a duration once the capture device reports its frame size. Browser talk-mode is not a `voice.bargeIn` surface at all — it endpoints in the browser, from the `display.voice_*` keys (Settings → Voice → Advanced voice tuning). `voice.bargeIn.browser.*` is a parse error; see the [config.yaml reference](../../reference/config-yaml.md#voice-barge-in).

## Troubleshoot

- **`screened`, reason `not_allowlisted` or `caller_unverified`.** No `voice.inbound.receptionist` is set, so the call had nobody to answer it. `caller_unverified` means the caller ID matched `voice.inbound.allowlist`, which is not identity and does not reach the bot's own personality. Set the receptionist to answer these calls.
- **`refused`, reason `over_concurrency`.** More simultaneous calls than `voice.inbound.concurrencyCap` (default 2). Raise it, or accept the busy handling.
- **`refused`, reason `rate_limited`.** One caller exceeded `voice.inbound.perCallerPerHour` within a rolling hour.
- **`screened`, reason `no_bot_match`.** The dialled number matched no `voice.bots[].match`. Check the E.164 form — the pattern is matched against the whole string, so `5550000000` does not match `+15550000000`.
- **No summary ever arrives.** Two causes, and the gateway distinguishes them. `⚠ voice.inbound.owner is not set` at startup means there is no destination. Otherwise the notice is a ledger obligation addressed to `owner.botKey` — if that bot is not served by this process, the sweep on another process delivers it, and this one logs `owner notification not confirmed`.

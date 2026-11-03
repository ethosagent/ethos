---
title: "config.yaml: voice artifacts, LiveKit and telephony keys"
description: "config.yaml voice artifacts, LiveKit, SIP trunk and inbound keys."
kind: reference
audience: user
updated: 2026-11-03
---

## Synopsis {#synopsis}

Keys for voice artifacts, LiveKit rooms and telephony. Part of the [config.yaml reference](../config-yaml.md).

## voice.artifacts.\<field\> {#voice-artifacts}

Type: dotted group · Default: the per-field defaults below

Retention for synthesized voice notes held on disk under `~/.ethos/voice/artifacts/`. An artifact is written before the send and deleted the moment its delivery obligation is confirmed, so in a healthy deployment this directory is empty; these two keys bound what happens to the recordings whose delivery is never confirmed. Both are enforced by `Gateway.pruneVoiceArtifacts()`, which runs at boot and hourly.

| Field | Type | Default | Description |
|---|---|---|---|
| `abandonAfterDays` | integer (days) | `7` | Give up on an undelivered obligation after this long and delete its recording. Must be an integer in `1`–`365`; out-of-range values are dropped, not clamped. |
| `maxTotalMb` | integer (MiB) | `512` | Total on-disk cap for the artifact directory, evicting oldest-first once exceeded. The backstop for runaway accumulation when neither delivery nor abandonment has fired. Must be an integer in `1`–`102400`; out-of-range values are dropped. |

```yaml
voice.artifacts.abandonAfterDays: 3
voice.artifacts.maxTotalMb: 128
```

Notes:

- Redelivery re-sends the stored recording rather than synthesizing a second one — see [Why does a redelivered voice note re-send the recording?](../../../building/explanation/why-voice-replies-redeliver.md). Shortening `abandonAfterDays` shortens the window in which that repair is still possible.
- Editable under **Settings → Voice → Advanced**.

## voice.livekit.\<field\> {#voice-livekit}

Type: dotted group · Default: unset — no LiveKit transport

LiveKit project credentials. Required for telephony: [`voice.trunk`](#voice-trunk) names the trunk, and this block carries the credentials Ethos signs its SIP control-plane requests with.

| Field | Type | Description |
|---|---|---|
| `url` | string | LiveKit server URL. Write the WebSocket form (`wss://…`); the SIP control plane normalizes it to `https://` itself, so one key serves both legs. |
| `apiKey` | secret ref | LiveKit project API key. |
| `apiSecret` | secret ref | LiveKit project API secret. Signs the JWTs on the SIP control plane and on room access tokens. |

```yaml
voice.livekit.url: wss://<your-project>.livekit.cloud
voice.livekit.apiKey: ${secrets:voice/livekit/apiKey}
voice.livekit.apiSecret: ${secrets:voice/livekit/apiSecret}
```

Notes:

- **All three are required together.** A partial block is a parse error, not a half-configured transport.
- These credentials make the SIP trunk client and the token minter **constructible** — no SDK and no native binary are involved. Room **audio** is a separate leg needing `@livekit/rtc-node` installed on the host; without it a call is answered, gated and logged but carries no voice. See [Give an agent a phone number](../../how-to/answer-phone-calls.md#3-install-the-media-binding).
- Editable under **Settings → Voice → LiveKit**.

## voice.bots.\<i\>.\<field\> {#voice-bots}

Type: indexed dotted list · Default: none — no number or room reaches a personality

Which number or LiveKit room each agent answers. This *is* the telephony routing table — there is no separate number-to-personality mapping. It mirrors `telegram.bots[]`, except `match` replaces `token`: a voice bot has no platform token.

| Field | Type | Description |
|---|---|---|
| `match` | string | Required. E.164 number or LiveKit room name this bot answers. `*` is the only wildcard and matches any run of characters; the pattern is anchored, so it must match the whole value. |
| `bind.type` | `personality` \| `team` | Required. What answers. |
| `bind.name` | string | Required. The personality id or team name. |
| `id` | string | Stable key used in the lane key (`voice:<botKey>:sip:<caller>`) and in the call log. Defaults to a short sha256 of `match` — set it explicitly if you want the key to survive a number change. |

```yaml
voice.bots.0.match: "+15550000000"
voice.bots.0.bind.type: personality
voice.bots.0.bind.name: receptionist
voice.bots.1.match: "+1555*"
voice.bots.1.bind.type: personality
voice.bots.1.bind.name: engineer
```

Notes:

- **First match in config order wins**, so a specific number can precede a broad wildcard — as in the example above.
- An entry missing `match`, `bind.type` or `bind.name` is a parse error naming its index.
- A dialled number matching no entry is not dropped silently: the call is logged `screened` with reason `no_bot_match` and the owner is notified.
- A `team`-bound voice bot has no single personality to pin, so a call to it falls through to the deployment's default.
- Editable under **Settings → Voice → Numbers**.

## voice.trunk.\<field\> {#voice-trunk}

Type: dotted group · Default: no trunk — telephony is off

The SIP trunk that gives an agent a phone number. A rented PSTN number on a trunk provider is pointed at LiveKit SIP, so an inbound or outbound call arrives as one more room participant. Which number reaches which [personality](../../../getting-started/glossary.md#personality) (a directory of files that decides the agent's tools, memory, and model) is not configured here — a [`voice.bots[]`](#voice-bots) entry whose `match` is an E.164 pattern *is* that mapping.

| Field | Type | Default | Description |
|---|---|---|---|
| `provider` | enum | — | Required. Selects which inbound-webhook signature scheme the gateway's call listener verifies with; the providers do not agree on how a request is signed, and that is the one fact the verifier cannot read off the payload. Values below. An unrecognised value is a parse error and the whole trunk block is dropped. |
| `trunkId` | string | — | Required. The LiveKit SIP trunk id the number is attached to, used on both the inbound and the outbound leg. |
| `fromNumber` | string (E.164) | unset | Caller-ID presented on an outbound `call`. Read by the `call` tool; a trunk with no `fromNumber` dials with whatever the provider defaults to. |
| `username` | string | unset | SIP registrar username for outbound trunk auth. |
| `password` | secret ref | unset | SIP auth password. Must be written as `${secrets:voice/trunk/password}` — `writeConfig` moves a plaintext value into the vault under that ref, and loading a config with a plaintext value here fails. Authenticates **us to the trunk**, on the outbound leg. |
| `webhookSecret` | secret ref | unset | Shared secret the inbound-call listener verifies the trunk's request signature against. Same vault handling as `password`, under `${secrets:voice/trunk/webhookSecret}`. Authenticates **the trunk to us**, on the inbound leg — a deployment rotating one is not forced to rotate the other. |
| `webhookPath` | string | unset | HTTP path the listener mounts the trunk webhook at. Must start with `/`; anything else is a parse error. Left unset, the listener applies its own default. |
| `codec` | enum | unset | Preferred call codec. Values below. **Parsed and validated, but read by nothing today** — the media leg does not negotiate from it. Declaring it changes only what `ethos config print` echoes back. |

`provider` values:

- `twilio` — a Twilio Elastic SIP Trunk.
- `telnyx` — a Telnyx SIP connection.
- `livekit` — LiveKit's own SIP service signs the webhook.
- `generic` — any other trunk. No provider-specific signature scheme is applied, so pair it with a network-level control.

`codec` values:

- `opus` — wideband, where the trunk carries it. The better ear.
- `g711` — the narrowband PSTN codec every trunk speaks. The fallback. (Ethos ships a μ-law and A-law codec, but nothing selects between the two from this key yet.)

```yaml
voice.trunk.provider: livekit
voice.trunk.trunkId: ST_1
voice.trunk.fromNumber: +15550000000
voice.trunk.webhookSecret: ${secrets:voice/trunk/webhookSecret}
voice.trunk.webhookPath: /voice/inbound
voice.trunk.codec: opus
```

Notes:

- `provider` and `trunkId` are required together. A block carrying one without the other is a parse error and the trunk is dropped — telephony stays off rather than half-configured.
- Removing the whole block does **not** delete `voice/trunk/password` or `voice/trunk/webhookSecret` from the vault. Drop them with `ethos secrets remove <ref>` if the credentials are retired.

## voice.inbound.\<field\> {#voice-inbound}

Type: dotted group · Default: no policy — the consumer's own defaults apply

A phone number is the one surface strangers reach without being invited. This block is the answering policy: who gets through, what a call may cost, and where the summary lands. Every caller is answered by `receptionist` in a restricted scope — no owner memory, no privileged tools — and is refused outright when no `receptionist` is set. Caller ID is not identity: the calling party sets it, so an `allowlist` match only decides pre-warm (`decideInboundCall`, `extensions/platform-voice/src/sip/inbound-gate.ts`).

| Field | Type | Default | Description |
|---|---|---|---|
| `allowlist` | comma-separated list | unset | Caller numbers treated as known for `prewarm: allowlisted`. E.164 patterns using the same `*` wildcard grammar as [`voice.bots[].match`](#voice-bots), matched against the whole number. Entries are trimmed and empties dropped. A match does **not** reach the owner's own personality: caller ID is spoofable and no verification step exists, so every caller goes to `receptionist`, or is refused if there is none. |
| `receptionist` | string | unset | Personality id answering every inbound caller. Its own memory (scope `personality:<id>`, fixed by turn setup — there is no scope setting) and its `toolset` *are* the restriction, and a call turn carries no user id, so no caller's or owner's `USER.md` is read; there is no second restriction system. Unset makes every call a refusal (`screened`, reason `not_allowlisted`, or `caller_unverified` when the caller ID matched `allowlist`) rather than a screened conversation. |
| `concurrencyCap` | integer | `2` | Ceiling on concurrent inbound calls; callers over the cap get busy handling and the owner is notified. Must be a positive integer — `0` and fractions are parse errors, not "no cap". |
| `perCallerPerHour` | integer | unset | Per-caller call ceiling inside a rolling hour, evaluated over a sliding window. Positive integer. |
| `dailyBudgetUsd` | number | unset | Spend ceiling in USD per day across all inbound calls, reset on the UTC day boundary. Must be greater than zero. Counts **LLM token spend only**, at the provider's own estimate — STT, TTS, LiveKit media and PSTN minutes are not in the total, so the cap trips on real spend but trips late relative to a day's true cost. Browser talk-mode and channel voice notes do not route through the call dispatcher and never count against it. |
| `prewarm` | enum | `allowlisted` | Which callers *would* get the realtime provider socket opened during ring. **Decided per call and acted on by nothing today** — the SIP↔realtime bridge is built and unit-tested but has no production caller, so no socket is opened on ring or on answer. Values below. |
| `owner.platform` | string | unset | Platform id the call summary and capacity notices are delivered on, e.g. `telegram`. |
| `owner.chatId` | string | unset | Chat id on that platform. |
| `owner.botKey` | string | unset | Which bot sends the notice, in a multi-bot deployment. |

`prewarm` values:

- `allowlisted` — pre-warm on ring for known callers only, and warm on answer for everyone else. No provider spend on calls that may be screened.
- `none` — always warm on answer. Cheapest; the caller hears a beat of dead air.
- `all` — warm every ring, including the ones that get screened.

```yaml
voice.inbound.allowlist: +1555123*, +447700900000
voice.inbound.receptionist: receptionist
voice.inbound.concurrencyCap: 3
voice.inbound.perCallerPerHour: 5
voice.inbound.dailyBudgetUsd: 12.50
voice.inbound.prewarm: allowlisted
voice.inbound.owner.platform: telegram
voice.inbound.owner.chatId: 4242
```

Notes:

- **Malformed values are parse errors, not ignored.** Unlike the `voice.wake.*` knobs, a bad value here drops the whole `voice.inbound` block and reports the offending key. A silently-dropped budget or concurrency cap costs real money on a surface strangers can dial.
- `owner.platform` and `owner.chatId` are required together. One without the other is a parse error naming the missing key, rather than a half-built destination that quietly drops the notification this block exists to deliver.
- An unrecognised field name under `voice.inbound.` is a parse error, so a typo cannot look configured while doing nothing.
- Gates run cheapest-refusal-first: daily budget → per-caller rate → concurrency → receptionist. A refusal releases whatever it took, so a wall of refused calls leaves the concurrency counter at zero rather than wedging the line.
- The end-to-end behaviour of every key here is in [Give an agent a phone number](../../how-to/answer-phone-calls.md).

## See also {#see-also}

- [config.yaml reference](../config-yaml.md): the index of every section and its page.

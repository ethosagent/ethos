---
title: "Give an agent a phone number"
description: "Point a SIP trunk at Ethos so a rented number rings a personality: trunk config, webhook and media binding here; calls, outbound and verify in a part."
kind: how-to
audience: user
slug: answer-phone-calls
time: "45 min"
updated: 2026-11-03
---

## Task

Point a rented phone number at Ethos so calling it reaches a [personality](../../getting-started/glossary.md#personality) (a directory of files that decides the agent's tools, memory, and model), and let that personality place a call back out.

## Result

- An inbound call is signature-verified, gated, answered or screened, written to a durable call log, and summarised to the owner's channel.
- Calls appear as rows under **Communications → Calls**, with a live indicator while one is up.
- The `call` tool becomes available and dials only after an explicit approval.

## Prereqs

- **A LiveKit server with SIP.** LiveKit Cloud with the SIP service enabled, or self-hosted `livekit-sip`. Ethos talks to its SIP control plane over HTTPS with a signed JWT — no SDK, no native binary.
- **A SIP trunk and a rented number** on Twilio, Telnyx, or any provider that can post a signed webhook. Numbers are rented by hand; Ethos provisions nothing.
- **A public HTTPS URL** reaching the gateway machine. A reverse proxy or a Tailscale funnel both work — the listener binds to loopback by default and speaks plaintext HTTP, so something else must terminate TLS.
- **`@livekit/rtc-node` installed on the gateway host**, if you want calls to carry audio. It is deliberately not a repo dependency: it ships a per-architecture native binary that cannot be verified in CI. See [step 3](#3-install-the-media-binding).
- A working [gateway](../../getting-started/glossary.md#gateway) (the process that runs every channel adapter) and a configured TTS and STT provider — any route in [Local voice](local-voice.md).


## Parts

This page covers configuration (steps 1 to 3). Running and checking calls is in the next part.

| Part | Covers |
|---|---|
| [Run, place and verify calls](answer-phone-calls/run-and-verify.md) | Steps 4 to 6: start the gateway, what happens on a ring, outbound calls, the web UI, and Verify. |

## 1. Configure the trunk

`~/.ethos/config.yaml` uses flat dotted keys. Four blocks matter: the trunk, the LiveKit credentials, the number-to-personality mapping, and the inbound policy.

```yaml
voice.trunk.provider: twilio
voice.trunk.trunkId: <livekit-sip-trunk-id>
voice.trunk.fromNumber: "+15550000000"
voice.trunk.webhookSecret: ${secrets:voice/trunk/webhookSecret}
voice.trunk.webhookPath: /sip/inbound
voice.trunk.codec: g711

voice.livekit.url: wss://<your-project>.livekit.cloud
voice.livekit.apiKey: ${secrets:voice/livekit/apiKey}
voice.livekit.apiSecret: ${secrets:voice/livekit/apiSecret}

voice.bots.0.match: "+15550000000"
voice.bots.0.bind.type: personality
voice.bots.0.bind.name: receptionist

voice.inbound.receptionist: receptionist
voice.inbound.allowlist: "+1555123*"
voice.inbound.concurrencyCap: 2
voice.inbound.owner.platform: telegram
voice.inbound.owner.chatId: "<your-chat-id>"
```

Four things about that block are load-bearing:

- **`provider` selects the signature scheme**, not just a label. The four trunk providers do not agree on how a request is signed, and it is the one fact the verifier cannot read off the payload.
- **`webhookSecret` is what turns the listener on.** A trunk configured without it leaves the inbound listener off — an unsigned webhook is an open line for anyone who learns the URL.
- **`voice.bots[].match` is the number-to-personality mapping.** There is no second structure. `*` is the only wildcard, matched against the whole number, and the first entry in config order wins — so a specific number can precede a broad pattern.
- **`voice.inbound.owner` is where every summary and refusal notice goes.** Without it they have nowhere to land, and the gateway says so once at startup.

Both secrets must be written as `${secrets:<ref>}` references. Saving from **Settings → Voice** moves a typed-in value into the vault for you; hand-editing a plaintext credential here fails the config load.

Every key in the block is editable in the web UI under **Settings → Voice**, in the sections **Telephony**, **LiveKit**, **Numbers**, **Inbound hardening**, and **Barge-in sensitivity**. Full field tables are in the [`config.yaml` reference](../reference/config-yaml.md#voice-trunk).

## 2. Expose the webhook

The gateway hosts its own small HTTP listener for this — web-api does not need to be running. It binds to `127.0.0.1:3005` and mounts `POST` at `voice.trunk.webhookPath`, defaulting to `/sip/inbound`.

| Environment variable | Default | Effect |
|---|---|---|
| `ETHOS_SIP_WEBHOOK_PORT` | `3005` | Port the listener binds. |
| `ETHOS_SERVE_HOST` | `127.0.0.1` | Bind address. A non-loopback value logs a plaintext-HTTP warning. |

Put a TLS-terminating proxy in front and forward to it. With Caddy:

```
calls.example.com {
  reverse_proxy 127.0.0.1:3005
}
```

Then set the trunk's webhook URL to `https://calls.example.com/sip/inbound` in the provider's console.

The proxy must forward `X-Forwarded-Proto` and `X-Forwarded-Host` if you use Twilio. Twilio's HMAC commits to the **public** URL, which a process behind a TLS terminator never sees on its own socket; the other three schemes sign the body and ignore this entirely.

## 3. Install the media binding {#3-install-the-media-binding}

Audio is the one leg you supply yourself.

```bash
pnpm add @livekit/rtc-node
```

Restart the gateway. It resolves the package once at startup — only when `voice.trunk` or `voice.livekit` is configured — and says which way it went:

```
  ✓ voice media: @livekit/rtc-node 0.13.0 — calls can carry audio.
```

Without it, telephony still runs and says so plainly:

```
⚠ voice media unavailable (@livekit/rtc-node is not installed — install it with pnpm add @livekit/rtc-node)
  A call will be answered, screened and logged, but cannot carry audio until the media SDK loads. Fix: pnpm add @livekit/rtc-node, then restart the gateway.
```

The second line is scoped to `voice.trunk`. A deployment that configures `voice.livekit` without a trunk gets the warning line alone — no phone number rings it, so there is no call to explain, and the shorter message is the expected one.

That is the honest state of the leg: verification, gating, the receptionist decision, the call-log row, and the owner summary all work without it. Only the voice does not.

The adapter that binds the SDK (`apps/ethos/src/livekit-media.ts`) is written against the published `@livekit/rtc-node` API and has never been executed against a running `livekit-server`. Every assumption it makes about the SDK's surface carries an `ASSUMPTION:` comment marking it as unproven.


## Verify

Restart the gateway. The startup log reports the media binding (`✓ voice media: @livekit/rtc-node ...`). Then continue with [step 4](answer-phone-calls/run-and-verify.md#4-start-the-gateway) to start the gateway and run the full [Verify](answer-phone-calls/run-and-verify.md#verify).

## Troubleshoot

- **`401` on every webhook, reason `missing_signature_header`.** The provider is not signing, or is signing a header this scheme does not read. Each scheme reads exactly one: Twilio `X-Twilio-Signature`, Telnyx `telnyx-signature-ed25519` plus `telnyx-timestamp`, LiveKit `Authorization: Bearer <jwt>`, generic `X-Ethos-Signature`. Check `voice.trunk.provider` names the trunk you actually configured.
- **`401`, reason `invalid_signature`, Twilio only.** Twilio signs the public URL. If your proxy does not forward `X-Forwarded-Proto` and `X-Forwarded-Host`, the listener reconstructs `http://127.0.0.1:3005/...` and the HMAC will never match. Twilio's scheme also carries no timestamp, so **no replay window is enforced for it** — rotate the auth token and terminate TLS yourself rather than assuming one.
- **`401`, reason `expired_token` or `body_hash_mismatch`, LiveKit only.** LiveKit signs a JWT committing to a body hash. A token with no `exp` is treated as expired on purpose — an unbounded webhook token is a replay primitive. A body-hash mismatch means something between the trunk and the listener rewrote the body; nothing may re-serialize it before verification.
- **`401`, reason `stale_timestamp`, Telnyx or generic.** The signed timestamp is outside the 300-second window. Check clock skew on the gateway host.
- **`401`, reason `invalid_public_key`, Telnyx only.** `webhookSecret` must be Telnyx's base64 Ed25519 **public key** (or a PEM block), not the API key.
- **The call connects but nobody speaks.** The media binding is missing. Run `ethos doctor` and read the `LiveKit media` row; the call-log row will say `no SIP media binding — voice.livekit.* is unset or no LiveKit media client was supplied`.
- **`⚠ port 3005 in use`.** Something else holds the port; set `ETHOS_SIP_WEBHOOK_PORT`. Note that `ethos run-all` uses 3004 for its own health endpoint and spawns the gateway, which is why 3005 is the default.

## See also

- [`config.yaml` reference: `voice.trunk.*`](../reference/config-yaml.md#voice-trunk) — every telephony key with its bounds and default
- [Local voice: Kokoro TTS + Whisper large v3 STT](local-voice.md) — wire the speech providers a call needs
- [Send and receive voice notes on a channel](voice-notes-on-channels.md) — the other channel-facing voice surface
- [Set up approval gates](set-up-approval-gates.md) — the surface that stops an outbound call before it dials

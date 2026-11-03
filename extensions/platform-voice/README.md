# @ethosagent/platform-voice

## Purpose

Transport-agnostic real-time voice channel adapter. It bridges a `VoiceTransport` to a `VoiceSession` (`@ethosagent/voice-session`) per live call, and ships the LiveKit transport and the SIP telephony layer (webhook verification, inbound gate, dispatch, post-call summary) around that stack.
Native media bindings, the outbound `call` tool (`@ethosagent/tools-voice`) and the gateway dedup path live elsewhere.

## Public surface

From `src/index.ts`. No library helpers beyond the adapter, the two transports and the SIP layer.

| Export | Kind | One line |
|---|---|---|
| `VoiceChannelAdapter` | class | One adapter per live call; forwards audio both ways and keys the lane `voice:<botKey>:<callerId>`. |
| `VoiceTransport` | type | Transport-agnostic seam for one live audio session. |
| `OutboundAudioFrame` | type | PCM frame handed to `transport.sendAudio()`. |
| `createLiveKitTransport` | function | Wiring seam composing room client, token minter and per-caller `VoiceSession`. |
| `LiveKitVoiceTransport` | class | `VoiceTransport` over the `LiveKitRoomClient` boundary. |
| `createLiveKitTokenMinter` | function | HS256 LiveKit access-token minter over `node:crypto`. |
| `createLiveKitSipJwt` | function | Mints the JWT carrying the `sip` grant. |
| `createLiveKitSipTrunkClient` | function | `SipTrunkClient` binding that POSTs `CreateSIPParticipant`. |
| `verifySipWebhook` | function | Verifies an inbound SIP webhook (livekit, twilio, telnyx, generic). |
| `parseInboundSipCall` | function | Maps a verified payload to an `InboundSipCall` or `null`. |
| `decideInboundCall` | function | Applies budget, rate limit, concurrency and allowlist in that order. |
| `createInboundDispatcher` | function | Resolves the dialed DID to a bot and delegates to `buildAdapter`. |
| `createPostCallSummary` | function | Posts a call summary through `sendArtifactMessage()` or an injected `deliver`. |
| `createSipRealtimeBridge` | function | Bridge between a SIP wire codec and a realtime session. |

Further exports (G.711 codecs, frame pacer, limiters, boundary types) are in `src/index.ts`.

## Seam

Implements the Ethos channel-adapter contract ([.claude/rules/gateway-dedup.md](../../.claude/rules/gateway-dedup.md)); archcheck layer `extensions`.

- Audio frames are transport media and bypass `MessageDedupCache`; call summaries go through the gateway's deduped `send()`. Pinned by `src/__tests__/adapter.test.ts` ("exempts audio from dedup but routes summary messages through it").
- Inbound gate order is budget, rate limit, concurrency, allowlist, and an absent allowlist fails closed. Pinned by `src/__tests__/inbound-gate.test.ts`.
- Twilio's scheme has no replay window, and that gap is pinned by `src/__tests__/sip-webhook.test.ts`.
- A provider refusal never echoes the bearer token. Pinned by `src/__tests__/sip-trunk-livekit.test.ts`.

## More

- [docs/adapter.md](./docs/adapter.md) -- what the adapter and transport seam do.
- [docs/dedup-boundary.md](./docs/dedup-boundary.md) -- read before routing audio into the dedup path.
- [docs/livekit.md](./docs/livekit.md) -- LiveKit transport and manual verification checklist.
- [docs/sip.md](./docs/sip.md) -- telephony layer and manual verification checklist.

## Testing

```
pnpm vitest run extensions/platform-voice
```

Pinning tests: `src/__tests__/adapter.test.ts`, `src/__tests__/inbound-gate.test.ts`, `src/__tests__/sip-webhook.test.ts`, `src/__tests__/sip-trunk-livekit.test.ts`, `src/livekit/__tests__/transport.test.ts`.

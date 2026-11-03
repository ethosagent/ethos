# Telephony (SIP)

## Telephony (SIP) — `src/sip/`

A SIP phone call is just another LiveKit participant. A rented PSTN number + SIP
trunk (Twilio/Telnyx/…) is pointed at LiveKit SIP, which bridges the call into a
LiveKit room; from there the **same** `LiveKitVoiceTransport → VoiceChannelAdapter
→ VoiceSession` stack handles the audio. Phase C adds only the trunk/dispatch and
outbound-call layer *around* that stack — it does not fork it.

- **`sip/trunk-client.ts`** — `SipTrunkClient`: the isolated boundary for
  `createOutboundCall({ toNumber, roomName, … })` plus the `InboundSipCall`
  shape. Callers depend on the interface, so dispatch and the outbound tool
  unit-test against `FakeSipTrunkClient` and a deployment can substitute a
  non-LiveKit trunk.
- **`sip/trunk-client-livekit.ts`** — `createLiveKitSipTrunkClient`: the
  production binding. A JSON POST to
  `/twirp/livekit.SIP/CreateSIPParticipant` authorized by a JWT carrying the
  `sip: { call: true }` grant — no SDK, no new dependency. A non-2xx response
  throws with the status and a **redacted, truncated** body: a provider refusal
  must never echo the bearer token (minted from the apiSecret) into a log.
- **`sip/webhook.ts`** — `verifySipWebhook` / `parseInboundSipCall`: the inbound
  door. Four verification schemes (`livekit` JWT + body hash, `twilio`
  HMAC-SHA1 over url + sorted params, `telnyx` Ed25519 over `timestamp|body`,
  `generic` HMAC-SHA256 over `timestamp.body`), every comparison length-guarded
  then `timingSafeEqual`, every failure a DISTINCT reason that never contains
  the secret. `parseInboundSipCall` maps a verified payload to an
  `InboundSipCall` (or `null` — it never throws), falling back to a
  deterministic `call-<to>-<from>` room name when the provider supplies none.
  **Twilio's scheme carries no timestamp, so no replay window is enforceable
  for it** — that gap is pinned by a test rather than papered over.
- **`sip/inbound-gate.ts`** — `decideInboundCall` plus the three limiters
  (`createCallConcurrencyLimiter`, `createPerCallerRateLimiter`,
  `createVoiceDailyBudget`) and `isAllowlistedCaller`. Order is load-bearing:
  budget → rate limit → concurrency → allowlist, and a refusal never keeps a
  concurrency slot. An absent allowlist means NOBODY is allowlisted (write `'*'`
  to mean everyone) — a mis-parsed key must fail closed.
- **`sip/inbound-dispatch.ts`** — `createInboundDispatcher`: resolves an inbound
  call's dialed DID (`toNumber`) against the `voice.bots[]` patterns
  (`resolveVoiceBot` / `matchesVoicePattern`) to pick the bound personality, then
  delegates to an injected `buildAdapter` to compose the transport→adapter→session.
  The caller's number (`fromNumber`) becomes the adapter `callerId`, so the lane
  key `voice:<botKey>:<callerId>` gives a repeat caller their own session —
  cross-call memory with no new machinery.
- **`sip/post-call-summary.ts`** — `createPostCallSummary`: on call end, builds a
  summary from the adapter's honest transcript (`lastReplyText()`) and posts it via
  `adapter.sendArtifactMessage()` → the gateway's deduped `send()` gate. Same
  dedup path as every outbound message — never a new dedup layer. Supply
  `deliver` instead to route it through the delivery ledger: dedup stops a
  DOUBLE send, the ledger stops a LOST one, and the summary is the only durable
  record of a call the operator did not hear. Wire it as the adapter's
  `onEnded` so a caller who simply hangs up still gets one.

The outbound `call` **tool** lives in `@ethosagent/tools-voice`. It is marked
`requiresApproval: true`, so AgentLoop gates it on the approval surface before a
number is ever dialed — an autonomous turn cannot place a call without approval.

Config: `voice.trunk.*` (provider, `trunkId`, optional `fromNumber`/`username`/
`password`) + the existing `voice.bots[]` (DID → personality) + `voice.livekit.*`.

### Telephony (SIP) manual verification checklist (real bindings + rented number)

NOT run in CI — this exercises the native SIP path end to end.

1. **Rent a number + SIP trunk** from Twilio or Telnyx and point its origination
   at your LiveKit SIP endpoint (LiveKit Cloud or self-hosted
   `livekit-server` + the SIP service). Register the inbound/outbound trunk with
   LiveKit and note the trunk id.
2. **Configure** `~/.ethos/config.yaml`:
   ```
   voice.livekit.url: wss://<your-livekit>
   voice.livekit.apiKey: <key>
   voice.livekit.apiSecret: <secret>
   voice.trunk.provider: twilio        # or telnyx / generic
   voice.trunk.trunkId: <livekit-sip-trunk-id>
   voice.trunk.fromNumber: +1<your-rented-number>
   voice.bots.0.match: +1<your-rented-number>   # DID -> personality
   voice.bots.0.bind.type: personality
   voice.bots.0.bind.name: <a voice-capable personality>
   ```
3. **Implement the app-layer SIP binding**: a `SipTrunkClient` wrapping
   `livekit-server-sdk`'s `SipClient.createSIPParticipant` (outbound) and an
   inbound webhook/dispatch-rule callback that delivers an `InboundSipCall`
   (`fromNumber`, dialed `toNumber`, `roomName`) into `createInboundDispatcher`.
   Inject the app-layer `LiveKitRoomClient`/`LiveKitTokenMinter` factory (see
   above) as the per-caller `buildAdapter`.
4. **Inbound**: dial the number, converse, hang up. Verify the post-call summary
   was posted to the paired text channel, then **call again from the same number**
   and confirm the agent recalls prior context (per-caller lane memory).
5. **Outbound**: ask the agent to place a `call`; approve the `call` tool at the
   approval prompt and confirm it dials the destination and connects into the room.
   Confirm that *denying* the approval places no call.


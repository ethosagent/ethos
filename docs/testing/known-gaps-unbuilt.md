# Testing voice: known gaps, part 2

[Back to the testing index](../../TESTING.md)

### 6. Built-in `voice` personality — shipped
`extensions/personalities/data/voice/` is the first built-in that lists
`voice_session`, so talk-mode's phone button is enabled for it out of the box.
It declares `voice.tts_voice: af_bella`, `voice.tier: pipeline`, a fast-lane
`voice.model`, and a Spanish entry in its language map; its toolset carries
nothing that writes to disk or runs a shell (consequential work leaves the
spoken lane through `delegate_task`).

Its static prompt is budget-gated at ~2k tokens (latency decision L5) by
`extensions/personalities/src/__tests__/voice-personality.test.ts` — SOUL.md
plus the spoken-style injector measure ~2.3k chars / ~580 tokens today, so
there is headroom, and the test is what stops it being spent silently.

### 7. Not built at all

Telephony used to be listed here as "beyond the typed seams". It shipped — the
inbound webhook listener on the gateway command, the four signature schemes, the
hardening gates, the receptionist scope, the SQLite call log, the owner summary
through the delivery ledger, `voice.calls.*` and the Communications → Calls tab, and
an optional-dependency loader that gives a call audio once an operator installs
`@livekit/rtc-node`. See [§4c](telephony.md#4c-telephony). Four things inside it did **not**
ship:

- **The SIP↔realtime bridge tier.** `createSipRealtimeBridge` is built and tested
  and has no caller outside its own suite, because `VoiceStack` exposes no
  `RealtimeVoiceProvider` or `VoiceTransport` for the gateway to construct one
  from. `voice.inbound.prewarm` therefore decides something nothing acts on.
- **Voicemail / answering-machine detection.** Explicitly deferred by the plan,
  recorded as a decision rather than an omission.
- **Outbound as a conversation.** `call` dials through the trunk under an approval,
  and nothing joins the room on the Ethos side, so the callee hears silence. No
  call-log row is written for an outbound call either.
- **Any live-call verification.** Every payload parser and every signature scheme is
  written against published documentation. No captured request from any provider
  has ever been replayed through them.

The wake-word satellite used to be listed here in full. It shipped — the shared
`extensions/voice-satellite` package, the `/satellite/ws` lane on **web-api**,
`ethos listen` / `ethos listen doctor`, the desktop main-process host, and the
Settings → Voice wake-route manager. `shouldReplyWithVoice`'s `wakeTriggered` flag
now has a caller: `SatelliteLane.runTurn`. Four things inside it did **not** ship,
and they are the reasons not to plan an ambient deployment around it yet:

- **Acoustic wake on any host.** `ethos listen` runs an open mic gated on the
  server's transcript, not on sound; the sherpa adapter
  has never run against a real binary, and `sherpa-onnx-node` is not installed.
- **A microphone on the desktop host.** It reports `degraded` with "no capture
  device configured" and declines to start.
- **Wake-quality numbers.** No corpus, no measurement.
Edge STT used to be listed here too. It shipped on `ethos listen`:
`voice.wake.edgeStt: true` plus a **local** recognizer makes the daemon transcribe
on the satellite and send only the words upstream — no `audio` frames at all — and a
non-local recognizer is refused by name rather than relabelled, because declaring
"at the edge" for a cloud transcriber would make the guarantee false in exactly the
deployment that asked for it. The Electron host still ships no recognizer and no
capture device. Satellite **playout** also shipped; see [§5](credentials-and-hardware.md#5-what-needs-credentials-or-hardware-you-supply).

Channel TTS-out and the ffmpeg transcode stage used to be listed here. Both
shipped — see [§ Channels](channels-and-wake.md#channels--voice-note-in-voice-note-out) for the declared-caps model that carries
TTS-out to all four adapters, and `extensions/gateway/src/transcode.ts` for the
stage. ffmpeg itself remains an optional host binary: without it the gateway
sends only formats the TTS provider already produces.

The realtime tier itself shipped ([§4b](realtime-tier.md#4b-the-realtime-tier)). One thing inside
it did not: a **server-relay path**, so `gemini-live` is contract-only and cannot
serve a browser call. The **fast-lane model** used to be listed here too — it
shipped for pipeline turns, and a realtime call still routes from the roster
entry rather than `voice.model`.

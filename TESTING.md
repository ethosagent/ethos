# Testing Ethos voice end to end

How to make Ethos listen and speak on this machine, what proves itself without any
setup, and what still needs credentials or hardware you supply.

Everything below was verified against the code on the `voice-first-class` branch.
Where something could not be verified from inside the repo, it says so.

---

## TL;DR — what you can exercise today

**Works with zero credentials and zero servers**

- The whole automated suite: `pnpm typecheck && pnpm lint && pnpm test`.
- Voice text processing (sanitize, sentence split, hallucination filter, voice-mode
  decision) — pure functions, fully unit-tested.
- Provider resolution and the local-only egress gate — `packages/core/src/providers/voice-resolution.ts`.
- `buildVoiceStack()` construction, including the trust gate and personality-voice
  precedence, against fake providers.
- `ethos doctor` — its Voice section resolves providers for real (constructs them;
  makes no network calls) and prints what the gate would do.
- macOS only: a real spoken reply through `command-tts` + the built-in `say` binary.
  No account, no server, no download. See [Cheapest smoke test](docs/testing/local-voice-loop.md#cheapest-smoke-test-macos-say).

**Needs something you supply**

| To hear/see | You supply |
|---|---|
| Local server STT | A Whisper server speaking `POST /v1/audio/transcriptions` (default `http://localhost:8000/v1`) |
| Local server TTS | A Kokoro-style server speaking `POST /v1/audio/speech` (default `http://localhost:8880/v1`) |
| Local binary STT | `whisper-cli` (or any CLI transcriber) on `PATH` |
| Browser talk-mode | A built SPA (`make web`) and a personality whose toolset lists `voice_session` |
| Browser realtime tier | An OpenAI key with Realtime access and a `voice.realtime.providers.<name>` entry. `gemini-live` is contract-only and cannot serve a browser call — see [4b. The realtime tier](docs/testing/realtime-tier.md#4b-the-realtime-tier) |
| Voice notes over channels | A bot token for the channel in `~/.ethos/config.yaml`, plus `ffmpeg` on `PATH` for anything the TTS provider does not already emit in a declared format |
| Wake satellite (`ethos listen`) | `ethos serve` running and a PCM pipe — `ffmpeg` or `arecord`. No `voice.wake.routes` entry needed; the server synthesizes one per unprivileged personality. **Open mic: the server transcribes everything and matches the wake phrase there** — see [The flows to try](docs/testing/local-voice-loop.md#the-flows-to-try) |
| Acoustic wake (`sherpa`) | `sherpa-onnx-node` installed by hand (**not a repo dependency**) plus four model files in `~/.ethos/models/wake/`. No host in this repo has ever run it |
| Telephony (inbound + outbound calls) | A LiveKit server with SIP, a trunk, a rented number, and a public URL for the webhook. The decision path — verify, gate, screen, log, summarise — runs against fakes with none of them; see [4c. Telephony](docs/testing/telephony.md#4c-telephony) |
| Audio on a call | `@livekit/rtc-node` installed on the gateway host (**not a repo dependency** — a per-arch native binary). Without it a call is answered, gated, logged and summarised, and carries no voice |

**How do I just hear it talk?** Configure `auxiliary.tts` (30 seconds — see
[Cheapest smoke test](docs/testing/local-voice-loop.md#cheapest-smoke-test-macos-say)), run `make web`, open
`http://localhost:3000`, send a message, click the Play button on the reply.

---

## Sections

| Section | Page |
|---|---|
| 1. Zero-setup verification, the suites worth knowing by name | [docs/testing/zero-setup.md](docs/testing/zero-setup.md) |
| 2. Local-only voice loop, check what resolved, the flows to try (browser) | [docs/testing/local-voice-loop.md](docs/testing/local-voice-loop.md) |
| 2. Channels (voice note in, voice note out) and the wake satellite | [docs/testing/channels-and-wake.md](docs/testing/channels-and-wake.md) |
| 3. Privacy (local-only egress gate), 4. Per-personality voice | [docs/testing/privacy-and-personality-voice.md](docs/testing/privacy-and-personality-voice.md) |
| 4b. The realtime tier | [docs/testing/realtime-tier.md](docs/testing/realtime-tier.md) |
| 4c. Telephony | [docs/testing/telephony.md](docs/testing/telephony.md) |
| 5. What needs credentials or hardware you supply | [docs/testing/credentials-and-hardware.md](docs/testing/credentials-and-hardware.md) |
| 6. Known gaps, items 1 to 5 | [docs/testing/known-gaps.md](docs/testing/known-gaps.md) |
| 6. Known gaps, items 6 and 7 (built-in voice personality, not built at all) | [docs/testing/known-gaps-unbuilt.md](docs/testing/known-gaps-unbuilt.md) |
| 6b. Latency, the bench | [docs/testing/latency-bench.md](docs/testing/latency-bench.md) |
| 7. Troubleshooting, See also | [docs/testing/troubleshooting.md](docs/testing/troubleshooting.md) |

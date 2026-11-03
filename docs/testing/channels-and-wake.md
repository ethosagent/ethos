# Testing voice: channels and the wake satellite

[Back to the testing index](../../TESTING.md)

#### Channels — voice note in, voice note out

With a bot token configured, run `ethos gateway start`.

- **In:** send a voice note. `transcribeAudioAttachments` normalizes the cached bytes
  to the STT provider's preferred container (ffmpeg, `wav` when the provider takes it)
  and calls `transcribeBuffer`; the transcript is appended to the turn text. Any
  failure — a throw, a typed error, or an empty string — retries once re-encoded from
  the original bytes as `wav`. A failed or hallucinated transcript degrades to
  `(voice message)` rather than failing the turn. **All four channel adapters** classify
  inbound audio as `type: 'audio'` and therefore reach STT — Telegram from `msg.voice`
  and `msg.audio`, Slack and Discord from the upload's extension or content type,
  WhatsApp from `audioMessage` (with the filename extension derived from the mimetype,
  so a push-to-talk opus memo and a forwarded mp3 both land in the right container).
  `.webm` stays classified as video on Slack and Discord and is not transcribed.
- **Out:** after the text reply is delivered, `shouldReplyWithVoice()` decides. The
  per-lane default is `mirror_inbound` — it speaks back when you spoke to it. Change
  it in-chat with `/voice off|mirror_inbound|all`; the mode is persisted by
  `LaneVoiceModeStore` (`packages/core`) to `~/.ethos/voice/lane-modes.json`, so it
  survives both `/new` and a gateway restart.
- The reply text is run through `sanitizeForSpeech`, truncated at a sentence boundary
  if the provider declares `maxInputChars`, then synthesized. **Which channels can
  speak is declared, not sniffed:** an adapter implements `sendVoiceNote` and declares
  `voiceCaps` (`packages/types/src/platform.ts`), and the gateway routes through
  `isVoiceOutboundAdapter`. All four of `platform-telegram`, `platform-slack`,
  `platform-discord` and `platform-whatsapp` declare caps today; a new adapter gets
  TTS-out by declaring them. The gateway transcodes the synthesized audio into the
  first format the sink declared — Telegram opus → `sendVoice` voice bubble, WhatsApp
  opus with `{ ptt: true }`, Discord an attached audio file, Slack a `files.uploadV2`
  with an inline player.
- **ffmpeg is optional.** Without it, a reply already in a declared format passes
  through and everything else is skipped with a `gateway.voice_format_unsupported`
  event rather than delivered as an unplayable blob. The gateway prints a one-line
  `⚠ ffmpeg not found` notice at startup.
- TTS failure is swallowed on purpose: the text was already delivered. A voice note
  that *was* synthesized but not confirmed is not lost — it is a `kind: 'voice'`
  obligation in the delivery ledger, and the sweep re-sends the stored artifact.

#### Wake satellite — `ethos listen`

`ethos serve` hosts the satellite lane at `GET /satellite/ws` (**not** the gateway —
web-api owns the WS server, the auth cookie, the AgentLoop and the personality
refresh, so a Settings save pushes routes in-process). Preflight first:

```bash
make listen-doctor
```

```
ethos listen doctor  wake satellite preflight

  ✓  engine:transcript      no native bindings and no model files — matches wake phrases against STT output
  ⚠  models                 not required by the 'transcript' engine — model directory missing — ~/.ethos/models/wake
  ✓  microphone             1 input device(s): raw s16le mono PCM on stdin @ 16000 Hz
  ⚠  satellite-lane         ws://127.0.0.1:3000/satellite/ws: connection refused (ECONNREFUSED) — nothing is listening there, so the server is not running. Start it with `ethos serve`.
  ✓  node id                pi-kitchen-f089dce2 (~/.ethos/listen-node-id)
  ✓  satellite url          ws://127.0.0.1:3000/satellite/ws
  –  route                  none configured here, which is normal. The effective table is the server's: it adds a bare-NAME route (auto:<personalityId>) for every unprivileged personality and pushes the merged table on connect, so what this host can reach is only knowable once it has connected.

⚠ Nothing is broken on this host, but it cannot listen right now.
```

That is the run with nothing on `:3000`. Start `ethos serve` and the same row goes
green: `✓ satellite-lane  ws://127.0.0.1:3000/satellite/ws is mounted — answered 401
to a probe sent with no auth cookie, which is the expected refusal`. The probe is a
real WebSocket upgrade against `/satellite/ws` sent with no cookie, so the refusal
*is* the pass and no phantom lane or registry row is created by checking. It is
deliberately **not** `/healthz`: that folds the channel gateway's status into its
own, so a healthy `ethos serve` with no chat bots attached answers 503 — and when
the doctor does fall back to it, a 503 whose body is `{status: 'degraded', gateway:
{status: 'down'}}` still reports `✓ reachable`, because a satellite does not use the
channel gateway for anything. A connection that never came up names its errno and
the remedy, as above, rather than undici's `fetch failed`.

`route` is a dim `–`, never a verdict — this command never connects, so it has
nothing to say about routing. **No `voice.wake.routes` entry is required to listen.**
The effective table is the server's, which synthesizes an `auto:<personalityId>`
route for every unprivileged personality, pushes the merged table on connect, and
matches transcripts against it; `--route <id>` is a PIN checked against that table
when `ethos listen` connects, not here.

Exit `0` clean, `1` hard (no config, no usable engine, missing models for a
`sherpa` host), `2` warn (no pipe attached yet, server not up yet — both true
*right now* and possibly not in a minute). `make listen-doctor` translates the warn
code to **0** so a recoverable run does not fail the build; exit `1` still does.
`--json` adds a machine-readable object whose `engine.daemonMode` is the honest
label: `"open-mic"`, alongside `engine.phraseMatch: false`.

**Capture is a pipe, and the gate is server-side.** `apps/ethos` ships no
microphone binding, and the only always-available engine (`transcript`) matches
wake phrases against *recognized text*, which this host does not produce. So the
daemon registers `phraseMatch: false`, speech onset on the pipe opens an utterance,
and the SERVER matches the transcript: an utterance that opens with a wake phrase
runs a turn as the personality that phrase names (the phrase is stripped), a
follow-up within `voice.wake.idleTimeout` continues with that personality, and
everything else is transcribed and discarded. **The room is transcribed either
way** — the gate protects the agent, not the microphone.

```bash
# macOS
ffmpeg -nostats -loglevel error -f avfoundation -i :0 -ar 16000 -ac 1 -f s16le - | ethos listen
# Linux
arecord -q -f S16_LE -r 16000 -c 1 -t raw | ethos listen
```

`--route <id>` is optional and PINS the microphone to one route: only that phrase
may address it, and another agent's phrase is discarded rather than answered.

Keep the quiet flags. Both processes share the terminal, and ffmpeg's
carriage-returned progress meter overwrites the daemon's own lines mid-word
(`› you: hello7.9kbits/s speed= 1x`). `-nostats -loglevel error` drops the
banner and the meter and nothing else — a bad device index still prints.

`make listen` prints the same two pipelines and then runs the daemon, so a bare
`make listen` on a TTY refuses to start — by design, and it says why.

What is manual-only here, because no fake can stand in:

- **A real pipe and a real room.** Sample-rate correctness is unverifiable by
  construction: raw PCM carries no header, so piping 44.1 kHz stereo produces
  garbage that nothing detects.
- **Acoustic wake.** It needs `sherpa-onnx-node` (a ~33 MB per-arch native binary,
  deliberately **not** a repo dependency) plus four model files. The adapter in
  `extensions/voice-satellite/src/engines/sherpa-wake-engine.ts` is written against
  sherpa's documented `KeywordSpotter` surface and **has never been executed
  against a real binary in this repo** — its own header says so.
- **Wake quality.** The plan's false-accept ≤ 1/hour and false-reject ≤ 10 % at 3 m
  criteria are **unmeasured**: no test corpus exists, and nothing in this repo
  produces those numbers.
- **Playout on a satellite.** `ethos listen` registers `playback: false` — there is
  no output device behind a pipe. The lane decides *whether the turn speaks* without
  consulting that flag, then gates the **send** on it (`speakAudio = speak &&
  playback`, `SatelliteLane.runTurn`), so nothing is synthesized for this host and no
  TTS latency or spend is paid for bytes that would be discarded on arrival. The
  answer still reaches you as text — the daemon prints `● speech`, `› you:`,
  `‹ <personality>:` and `↩ turn complete` per turn. Hearing it aloud needs a host
  you wire a real `CaptureDevice` and a speaker into.
- **The desktop host.** It cannot listen: the Electron main process ships no
  microphone binding, so `probeSatellite` adds a failing `capture-device` row, the
  host reports `degraded`, and nothing starts. Everything downstream of the device
  is wired and covered by tests through an injected device and socket.

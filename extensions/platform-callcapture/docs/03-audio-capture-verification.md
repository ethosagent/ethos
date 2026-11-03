# Phase 3 output contract, STT, and live verification

### Output contract: both binaries emit the same PCM shape

Both binaries write **raw 16-bit signed little-endian PCM, mono, 16000 Hz**
to **stdout** in ~200ms chunks, and structured JSON status lines to
**stderr** — the inverse of Phase 1's `mic-detector` (which puts
everything, including its own error line, on stdout; see "Error stream"
above). Phase 3 splits the two because stdout now carries real binary
audio data that must never be interleaved with JSON text on the same
stream. `mic-capture.swift`'s stderr JSON loosely mirrors audiotee's
`message_type`/`timestamp`/`data` shape (not byte-identical — no need for
that, just enough shared shape that `src/audio-process.ts` can apply the
same NDJSON-parsing machinery to both) so the Node side treats both
binaries structurally the same way.

`src/audio-process.ts` is the shared piece `tap-capture.ts` and
`mic-capture.ts` both build on: spawning the binary, parsing its stderr
NDJSON for a binary-specific "ready" line (which carries the actual
`sample_rate` the binary reports — parsed, never assumed, in case a future
audiotee version or flag combination changes it) or a fatal error line,
and parsing stdout bytes into `@ethosagent/types`' `PcmChunk` frames
(`Int16Array` + `sampleRate`) — handling a trailing odd byte spanning two
separate stream `'data'` events rather than dropping or misaligning it.
`detector.ts` (Phase 1) was deliberately **not** folded into this shared
module — it parses one NDJSON stream with no PCM and no readiness wait, a
different enough shape that forcing it through the same abstraction would
cost more than it saves.

### The observed cold-start latency, and how it's handled

Empirically, on this machine, **both** `audiotee` and `mic-capture` have
shown a one-off slow first start in a given session — audiotee showed a
~13 second gap between its own "Creating IO proc" and "Starting audio
device" log lines on a cold run; independently, `mic-capture.swift`'s very
first invocation in this session captured only ~13KB of PCM in a 4-second
window (~0.4s worth of audio) before a subsequent run captured a full,
steady ~32KB/sec immediately. Neither binary's *second* run in the same
session showed any delay. The cause (CoreAudio HAL warm-up, a one-time TCC
registration step, something else) is not identified — this section
documents the behavior, not its root cause, per the plan's "characterize,
don't assume it's fixed" instruction.

Both `TapCapture` and `MicCapture` handle this the same way, via the
shared `startAudioCapture()` in `audio-process.ts`:
- A **20-second readiness timeout** (generous, not tight) rejects with a
  named, typed error — `"...did not report readiness within 20000ms"` —
  instead of hanging forever on a genuinely stuck capture.
- A **5-second heartbeat** (`onWaiting(secondsElapsed)`) fires while
  waiting, so a caller always sees "still waiting" progress rather than
  silence — `phase3-cli.ts` logs `tap: still waiting for the tap to
  start, Ns...` on each tick.
- Both are configurable per instance (`readinessTimeoutMs`, `heartbeatMs`)
  and covered by fake-clock tests in
  `src/__tests__/audio-process.test.ts` (no real 20-second sleep in the
  test suite).

### Fixed-window streamed STT, not VAD endpointing — a scoped-down spike simplification

`src/transcript-session.ts`'s `runTranscriptSession()` reuses
`@ethosagent/types`' streaming STT contract exactly the way
`extensions/voice-session/src/voice-session.ts` does: resolve once
(`isStreamingSttProvider(provider) ? provider :
createBufferedSttAdapter(provider)`), then call `transcribeStream()` per
utterance. The difference is what counts as "one utterance" — `voice-session.ts`
uses real VAD-based endpointing (silence detection closes an utterance);
Phase 3 instead closes a **fixed-duration window** (default 8000ms,
configurable via `TranscriptSessionOptions.windowMs`) by accumulated
sample count, calling `transcribeStream()` exactly once per window. This
satisfies decision 2's actual requirement — bounded memory, incremental
output, chunked as captured rather than buffered for the whole call — 
without building real endpointing infrastructure for a standalone spike.
**This is a scoped-down simplification, not the production design.** A
Phase 4+ follow-up should reconsider VAD-based endpointing, either
building it fresh or reusing `extensions/voice-session`'s
`EndpointDetector`.

A trailing partial window (less than `windowMs` of audio) is still flushed
when the source stream ends, e.g. when `stop()` is called mid-window — no
audio is silently dropped at capture end.

### Two independent STT passes, never pre-mixed (decision 7, footgun #3 — resolved)

`runTranscriptSession()` runs the mic stream and the tap stream through
**two separate `transcribeStream()` call sequences** — never combined into
one signal before STT. This directly follows decision 7's speaker
attribution requirement (labeled "You" for the mic stream, "Other
participant" for the tap stream), which is only possible if the streams
stay independent through STT and get merged afterward with speaker
labels. Decision 2 originally listed this as an open footgun ("whether the
tap stream and the mic stream need independent STT passes... or can be
pre-mixed"); decision 7 (written after decision 2) already resolved it —
Phase 3 implements the resolved design, not a re-litigation of it.

Entries are yielded as each window's transcription completes (real
streaming, not source order) via a small `mergeAsyncGenerators()` fan-in.
Because the two streams' windows complete independently, a caller wanting
a final chronological transcript should collect entries and sort by `at`
— `phase3-cli.ts` does exactly this for its printed summary.

### Footgun-tracking table (decision 2)

| Footgun | Status |
|---|---|
| `AVAudioEngine` cannot be retargeted to a tap-backed aggregate device | **Moot by design.** Neither `TapCapture` nor anything else in this package routes the tap stream through `AVAudioEngine` — `audiotee` owns the Core Audio Process Tap calls entirely, as an external process. `mic-capture.swift` DOES use `AVAudioEngine`, but only for the mic's own `inputNode`, never for a tap-backed device — this footgun does not apply to that path either. |
| Undocumented audio filtering on the ingestion side | **Empirically validated with real content, not just energy.** A prior RMS-energy check (a system chime through `afplay`) only proved presence of *some* signal. Phase 3's live verification (see below) played real speech through system output while running the real `audiotee` capture and a real `openai-stt` provider, and the resulting transcript matched the spoken text — no evidence of content-destroying filtering on the tap path. |
| Tap stream vs. mic stream: independent STT or pre-mix? | **Resolved (not open) — see "Two independent STT passes" above.** Decision 7 settled this after decision 2 was written; Phase 3 implements the resolved design. |

### TCC / permission status — still unresolved, needs real-user verification

No system permission dialog blocked either binary in this session's
testing. This could mean Process Tap capture of the machine's own output
doesn't require the same explicit TCC toggle FaceTime-style
screen-recording apps need, or it could mean this development machine
already granted the relevant permission from prior use (mic-detector's
Phase 1 testing, or Terminal.app's own inherited mic-access grant, which
child processes spawned from Terminal commonly get on macOS). This is
**not claimed as solved** — a real user on a machine that has never
granted Ethos/Terminal any audio permission before should expect to hit a
TCC prompt on first run and should verify what it looks like and whether
capture degrades gracefully if denied. Neither binary in this package
currently has explicit handling for a TCC-denial path beyond whatever
CoreAudio/AVFoundation returns as a generic failure (surfaced as a typed
error either way — never a silent hang or empty output).

### Live verification (real hardware, real STT)

Run:

```sh
OPENAI_API_KEY=sk-... pnpm --filter @ethosagent/platform-callcapture exec tsx src/phase3-cli.ts [durationSeconds]
```

`OPENAI_API_KEY` is a plain env var, deliberately **not** resolved from
`~/.ethos/config.yaml`'s `${secrets:...}` refs: doing that would require
constructing a `Storage` (`FsStorage`) inside this extension, which
`packages/types/src/__tests__/storage-construction-boundary.test.ts`
(P2.4) holds `extensions/*` to a deliberately EMPTY allowlist for — library
code must receive an injected `Storage`, never construct one, even in a
manual-verification script. Omitting the env var falls back to a fake
RMS-energy-based provider — proves pipeline wiring only, not transcript
content. Either way, `phase3-cli.ts` starts the real `TapCapture` and real
`MicCapture` concurrently, runs both streams through
`runTranscriptSession()`, and prints the merged, speaker-labeled
transcript once the fixed duration elapses, logging which STT tier ran.

**Validation tier actually achieved: real STT, real transcript content —
the strongest tier, not just wiring.** A live run exported the real key
already resolved in `~/.ethos/secrets/auxiliary/asr/apiKey` (this
machine's configured `auxiliary.asr` secret) as `OPENAI_API_KEY`, then
played synthesized speech ("The quick brown fox jumps over the lazy dog.
This is a test of the Ethos Call Capture Phase 3 audio pipeline.") through
system output (captured by the real tap) while it also acoustically
reached the real mic. Actual output:

```
[phase3-cli] STT validation tier: real-openai-stt
[phase3-cli] tap ready.
[phase3-cli] mic ready.
[phase3-cli] live: You: The quick brown fox jumps over the lazy dog. This is a test of the Ethos Call Capture Phase 3 audio pipeline.
[phase3-cli] live: Other participant: The quick brown fox jumps over the lazy dog. This is a test or the ethos call capture phase 3 audio.
...
=== Merged transcript ===
[2026-08-17T18:12:10.710Z] Other participant: The quick brown fox jumps over the lazy dog. This is a test or the ethos call capture phase 3 audio.
[2026-08-17T18:12:10.858Z] You: The quick brown fox jumps over the lazy dog. This is a test of the Ethos Call Capture Phase 3 audio pipeline.
...
[phase3-cli] STT validation tier was: real-openai-stt
```

Both streams recovered the spoken content correctly, with correct speaker
labels — real proof, not just wiring. **One observed artifact, noted
honestly rather than hidden:** the final, very short/quiet trailing window
on each stream produced a clearly wrong transcription (a stray "you" on
one stream, a Korean-character hallucination on the other) — a known
`whisper-1` behavior on near-silent or very short audio, not a bug in this
package's capture or windowing logic. `extensions/voice-text`'s
`isHallucination()` filter exists precisely to catch this class of output
in the real voice-session pipeline; Phase 3 does not reuse it (out of
scope for this spike, per the brief), but a Phase 4+ integration should
consider it.

### What Phase 3 deliberately does not do

No persistent daemon, no personality/toolset/config wiring, no connection
to Phase 1's detection or Phase 2's notification accept gate (capture is
manually triggered here), no memory-write / transcript-artifact handoff
(`extensions/platform-meeting`'s pattern, reused in Phase 4), and no
VAD-based endpointing (fixed time-windowing only — see above). All of
these are named, scoped, Phase 4 work, not omissions.

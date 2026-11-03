# Testing voice: the local-only loop

[Back to the testing index](../../TESTING.md)

## 2. Local-only voice loop (no cloud keys, no accounts)

Two config blocks in `~/.ethos/config.yaml` decide everything. The file uses flat
dotted keys, not nested YAML.

### Option A — local servers over OpenAI-compatible HTTP

```yaml
auxiliary.asr.provider: local-stt
auxiliary.asr.baseUrl: http://localhost:8000/v1
auxiliary.asr.model: whisper-large-v3

auxiliary.tts.provider: local-tts
auxiliary.tts.baseUrl: http://localhost:8880/v1
auxiliary.tts.model: kokoro
auxiliary.tts.voice: af_bella
```

Every line except `provider` is optional; the values above are the code defaults
(`extensions/voice-providers/src/local-stt.ts`, `local-tts.ts`). **`apiKey` is
optional** for both — local servers usually want none.

Getting the servers running is the part this repo cannot do for you. The canonical
recipe — which server to install, which ports, how to confirm they are up — lives in
[`docs/content/using/how-to/local-voice.md`](../content/using/how-to/local-voice.md).
The short version: kokoro-fastapi for TTS on **8880**, an OpenAI-compatible Whisper
server (Speaches / faster-whisper-server) for STT on **8000**. Follow each project's
own install guide; **the exact upstream install commands could not be verified from
inside this repo, so they are deliberately not reproduced here.** Confirm both are up:

```bash
curl -sI http://localhost:8000/v1/models
curl -s http://localhost:8880/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"model":"kokoro","voice":"af_bella","input":"hello"}' --output /tmp/hello.wav
```

Restart `ethos` (or the gateway, or `ethos serve`) after editing the config file.

### Option B — no server at all: `command-stt` / `command-tts`

Both are registered in `packages/wiring/src/voice-registries.ts`, both advertise
`caps.local`, and both take an operator-supplied shell template. Ethos writes the
input file into `os.tmpdir()`, runs `sh -c <template>`, reads the output file back,
and unlinks both in a `finally`.

Placeholders, read straight from the source:

| Provider | Placeholders |
|---|---|
| `command-stt` (`extensions/voice-providers/src/command-stt.ts`) | `{input_path}`, `{output_path}`, `{language}` |
| `command-tts` (`extensions/voice-providers/src/command-tts.ts`) | `{input_path}`, `{output_path}`, `{format}`, `{voice}`, `{speed}` |

`command` is required. Omit it and the provider refuses to construct rather than
failing on the first utterance.

#### Cheapest smoke test (macOS `say`)

macOS ships a TTS binary. This is the fastest possible way to hear Ethos speak.

```yaml
auxiliary.tts.provider: command-tts
auxiliary.tts.outputFormat: wav
auxiliary.tts.command: say --file-format=WAVE --data-format=LEI16@22050 -o {output_path} -f {input_path}
```

Why it is shaped like that, all verified by running it on this machine:

- `say -o out.mp3 -f in.txt` exits 0 and writes a **16-byte silent file**. It does
  not error; you simply get no audio. `say -o out.wav` with no format flags fails
  outright: `Opening output file failed: fmt?`.
- `say --file-format=WAVE --data-format=LEI16@22050` writes a genuine 22.05 kHz mono
  WAV — **127,988 bytes** for a one-sentence reply, against 16 for the silent stub.
- `auxiliary.tts.outputFormat: wav` makes `{output_path}` end in `.wav` and makes the
  provider report `format: 'wav'`, so the `audio/wav` MIME the web-api hands the
  browser matches the bytes. Before this key was lifted onto `EthosConfig` it was
  parsed and dropped, the extension was always `.mp3`, and the honest recipe needed
  an `ffmpeg` transcode stage. It does not any more.

#### Local binary STT

```yaml
auxiliary.asr.provider: command-stt
auxiliary.asr.command: whisper-cli -f {input_path} -otxt -of {input_path} && mv {input_path}.txt {output_path}
```

**Caveat, stated plainly:** `whisper-cli` is not installed on this machine, so this
template was **not** executed. It is written this way because `whisper.cpp`'s `-of`
is documented as "output file path (without file extension)" and appends `.txt`
itself — while Ethos hands `{output_path}` as a path that already ends in `.txt`
and then reads exactly that path back (`extensions/voice-providers/src/command-stt.ts`).
So `-of {output_path}` writes `<name>.txt.txt` and Ethos reads a file that was never
created. `docs/content/using/how-to/local-voice.md` and the `commandSttFactory`
docstring both carried that broken form; both now carry the `-of {input_path}` +
`mv` form above. Verify against your own `whisper-cli --help` before trusting either.

### Check what actually resolved

```bash
ethos doctor
```

The Voice section (`voiceReport()` in `apps/ethos/src/commands/doctor.ts`) runs the
*same* resolution path the pipeline uses — same registries, same gate — so a refusal
shows up here rather than as silent "voice doesn't work". It constructs providers; it
makes no network calls, so a green line means "resolvable", not "reachable".

```
Voice
  ✓  STT local-stt (local)
  ✓  TTS local-tts (local)
  ✓  Egress gate armed (voice.trustedPlugins: local providers only)
  –  0 voice bot(s); LiveKit absent; SIP trunk absent.
```

Reading it:

- `✓ <id> (local)` / `(remote)` — resolved; `local` means it advertises `caps.local`
  and passes the egress gate unconditionally.
- `– STT not configured.` — no `auxiliary.asr.provider`.
- `✗ STT: …` — resolved and failed. The message is the resolution error verbatim:
  unknown provider, factory threw, or refused by the gate.
- The last line only appears when a `voice.*` block exists.

### The flows to try

#### Browser — Play button, mic button, talk-mode

```bash
make web          # builds the SPA, then `ethos serve` on :3000
# or: make web-dev  (Vite :5173 with HMR, ethos serve :3000)
```

Open `http://localhost:3000`.

1. **Play button** — send a message, then click Play on the assistant bubble. This is
   the shortest TTS path: `rpc.voice.synthesize({ text })` → the resolved TTS
   provider → base64 audio back to the browser. The button only renders when the
   server reports the `voice_tts` capability, which is true when
   `auxiliary.tts.provider` is set.
2. **Mic button** — hold, speak, release. Goes through `rpc.voice.transcribe`; the
   transcript lands in the composer.
3. **Talk-mode** — the phone icon in the personality bar.

   **Gating requirement:** the active personality's `toolset.yaml` must list
   `voice_session`. Otherwise the button renders **disabled** with the tooltip
   *"Voice not enabled for `<name>` — add the voice_session capability to its
   toolset"* (`apps/web/src/features/voice/TalkMode.tsx`, predicate in `gating.ts`).

   The built-in **`voice`** personality ships with it — pick `Voice` in the
   personality bar and the phone button is live. To enable it on a personality
   of your own:

   ```bash
   mkdir -p ~/.ethos/personalities/talker
   # SOUL.md + config.yaml as usual, then:
   printf -- '- voice_session\n- read_file\n' > ~/.ethos/personalities/talker/toolset.yaml
   ```

   Personalities hot-reload; no restart needed.

   What talk-mode is today: a **persistent binary WebSocket**
   (`streaming-voice-call-client.ts` → `GET /voice/ws`) — mic PCM streams up as it
   is captured, the endpoint fires the transcript back down, the normal chat turn
   runs, each reply sentence is synthesized on the same socket, and the audio is
   scheduled on the WebAudio clock. Barge-in cancels the utterance server-side, so
   nothing already in flight for it is ever played.

   A browser missing any streaming piece falls back to the **batch HTTP loop**
   (`batch-voice-call-client.ts`) — `transcribe` RPC per utterance, `synthesize`
   RPC per sentence, `<audio>` playout. Same conversation, same events.

   VAD and barge-in are tunable live under **Settings → Voice → Advanced**. Defaults
   (`DEFAULT_VOICE_TUNING`): `endpointSilenceMs 700`, `bargeThreshold 0.06`,
   `bargeSustainMs 250`, `speechThreshold 0.02`, `speechMinMs 150`.

**Settings → Voice** writes the same `auxiliary.asr.*` / `auxiliary.tts.*` keys the
YAML above sets (`apps/web-api/src/repositories/config.repository.ts` maps them
one-for-one). It does **not** expose `command`, so `command-stt` / `command-tts` must
be configured by hand in `config.yaml`. There is also a **Test TTS** button there
that synthesizes a fixed phrase — a one-click check that the provider works.

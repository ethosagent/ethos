---
title: "config.yaml: barge-in, display and wake keys"
description: "config.yaml barge-in, voice display and wake-word keys."
kind: reference
audience: user
updated: 2026-11-03
---

## Synopsis {#synopsis}

Keys for barge-in, voice display and wake. Part of the [config.yaml reference](../config-yaml.md).

## voice.bargeIn.\<surface\>.\<field\> {#voice-barge-in}

Type: dotted group, keyed by surface · Default: the consumer's own thresholds

How eagerly the agent stops talking when it hears you, tuned per audio surface. A phone line is noisier than a room and a satellite sits across that room, so one global threshold is wrong on at least one of the two.

Two surfaces: `call` (telephony) and `satellite` (a [wake satellite](../../../getting-started/glossary.md#wake-satellite) — a separate process that owns a microphone). Any other surface name is a parse error.

`call` reaches the SIP lane's VAD and endpoint detector. `satellite` reaches the `ethos listen` microphone's VAD.

Browser talk-mode is not tuned here. The web talk lane endpoints in the browser, from the [`display.voice_*`](#display-voice) keys.

| Field | Type | Range | `call` | `satellite` | Description |
|---|---|---|---|---|---|
| `energyThreshold` | number | `0` exclusive – `1` inclusive | read | read | Input energy above which the far end counts as speaking. Higher tolerates more line noise and makes barge-in harder to trigger. |
| `minSpeechMs` | integer (ms) | ≥ 1 | read | read | How long that energy must persist before the barge-in is believed. The cough filter. |
| `silenceMs` | integer (ms) | ≥ 1 | read | **not read** | How long silence must last to end an utterance. |

```yaml
voice.bargeIn.call.energyThreshold: 0.4
voice.bargeIn.call.minSpeechMs: 220
voice.bargeIn.call.silenceMs: 700
voice.bargeIn.satellite.energyThreshold: 0.2
```

Notes:

- Every field is optional per surface — tune the one knob a room is wrong about, not all three. Only the surfaces you declare are present in the parsed config; the rest keep the consumer's defaults.
- `voice.bargeIn.satellite.silenceMs` is accepted and read by nothing. A satellite ends an utterance on a count of silent audio *frames*, and a frame is only a duration once the capture device reports its frame size — there is no conversion the config layer can do honestly. To make a satellite wait longer before replying, there is no knob today.
- Out-of-range values and unknown field names are parse errors that drop the whole `voice.bargeIn` block. A threshold typed against a misspelled surface is not a slightly different setting — it is no tuning at all, and the operator would only learn that from a line the agent kept talking over.
- `voice.bargeIn.browser.*` parsed in earlier releases and reached nothing. It is now a parse error naming `display.voice_*` as the replacement. Delete the key; the whole `voice.bargeIn` block is dropped while it is present.

## display.voice_\<field\> {#display-voice}

Type: flat keys · Default: per field below

Endpointing and barge-in for talk-mode in the web UI. This is the browser counterpart to [`voice.bargeIn`](#voice-barge-in) — the web talk lane runs its detector in the browser, so these are the keys it reads.

Edit them in Settings → Voice → Advanced voice tuning, or write them directly.

| Key | Type | Default | Range | Description |
|---|---|---|---|---|
| `display.voice_endpoint_silence_ms` | integer (ms) | `700` | 300 – 1500 | How long you pause before the agent replies. |
| `display.voice_barge_threshold` | number | `0.06` | 0.02 – 0.2 | Input energy that counts as interrupting the agent while it speaks. Lower is easier to interrupt. |
| `display.voice_barge_sustain_ms` | integer (ms) | `250` | 100 – 800 | How long that energy must persist before the interruption is believed. |
| `display.voice_speech_threshold` | number | `0.02` | 0.005 – 0.1 | Input energy that counts as speech at all. Lower picks up quieter speech. |
| `display.voice_speech_min_ms` | integer (ms) | `150` | 100 – 500 | Ignore bursts shorter than this. |

```yaml
display.voice_endpoint_silence_ms: 900
display.voice_barge_threshold: 0.08
```

Notes:

- A value saved through Settings is clamped to the range. A value that will not parse as a number falls back to the default rather than failing the load — these keys are read on every talk-mode turn, so a typo must not take the lane down.
- The five keys are independent. Set the one that is wrong; the rest keep their defaults.

## display.slow_turn_notice_ms {#display-slow-turn-notice}

Type: integer (ms) · Default: `8000` · Required: no

How long a non-streaming gateway lane stays silent before it gets its one per-turn "working on it" ack. `0` disables the whole notice family for non-streaming lanes, not just the first timer. Streaming lanes are unaffected — their tool progress edits the draft message in place — and email lanes never get the notice, whatever the value. A negative or non-numeric value is ignored and the default applies.

```yaml
display.slow_turn_notice_ms: 12000
```

## voice.wake.\<field\> {#voice-wake}

Type: dotted group · Default: the per-field defaults below

Deployment-wide settings for [wake satellites](../../../getting-started/glossary.md#wake-satellite) — separate processes that own a microphone and connect to the web API at `GET /satellite/ws`. The whole group is pushed to every connected satellite in a `routes` frame on connect, and again whenever Settings is saved.

Out-of-range numbers and unrecognised engine ids are **ignored, not clamped** — the default stands and the rest of the file still loads, so one typo cannot make a deployment unconfigurable.

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch for the whole fleet. Only an explicit `false` turns wake off; the key's absence means the operator never disabled it, not that they disabled it. ANDed with the per-node `voice.wake.nodes.<id>.enabled` — either one saying no means no. |
| `engine` | enum | `fallback` | Which matcher a satellite runs. Any other value is ignored. Per-value meanings below. |
| `sensitivity` | number | `0.5` | Match threshold, `0`–`1`. Higher tolerates more transcription slip and produces more false accepts; `0` demands an exact match. A value outside the range is dropped. |
| `confirmationFrames` | integer | `2` | Consecutive agreeing frames before an acoustic spot counts — the false-accept damper. Must be an integer in `1`–`10`. Ignored by the `fallback` engine, which decides a transcript once and has nothing to confirm. |
| `edgeStt` | boolean | `false` | Ask satellites to transcribe on-device and send text instead of audio. The node's probed capability is the veto: neither shipped host has an on-device recognizer, so both report `edgeStt: false` and the server ANDs this down to false. |
| `idleTimeout` | integer (**seconds**) | `30` | How long a conversation stays open, in two places. On a satellite it ends the LISTENING state. On the server it bounds the **addressing window**: after a wake phrase picks a personality, further utterances within this long reach that same personality with no phrase. Must be an integer in `5`–`600`. It ends listening and addressing **only** — never the session, so a re-wake an hour later resumes the same conversation with its history. |

`engine` values:

- `fallback` — the built-in transcript matcher (it names itself `transcript` in `ethos listen doctor` rows). Matches wake phrases against recognized text *after* speech-to-text, so it loads no native binding and no model file. The default.
- `sherpa` — sherpa-onnx keyword spotting in the acoustic stream, *before* recognition. Requires the optional peer `sherpa-onnx-node` (a per-architecture native binary, roughly 33 MB, deliberately not a repo dependency) plus `encoder.onnx`, `decoder.onnx`, `joiner.onnx` and `tokens.txt` in `~/.ethos/models/wake/`. The adapter is written against sherpa's documented `KeywordSpotter` surface and has not been run against a real binary in this repository.
- `openwakeword` — accepted by the parser; **no such engine ships**. `ethos listen doctor` reports it unavailable by name rather than falling through to another engine.

```yaml
voice.wake.engine: fallback
voice.wake.sensitivity: 0.6
voice.wake.confirmationFrames: 3
voice.wake.idleTimeout: 45
```

Notes:

- **Which host reads what.** The desktop satellite matches phrases itself, so it applies `sensitivity`, `confirmationFrames`, `idleTimeout` and `enabled` from the pushed frame each time it arms capture. `ethos listen` matches nothing, so it ignores the pushed `sensitivity` and `confirmationFrames` and reads `idleTimeout` for its capture machine from its own `config.yaml`; with the key absent there, the capture machine's own 300-second default applies rather than the 30 seconds the server reports.
- **`sensitivity` and `idleTimeout` are also server-side.** For a satellite that does not match phrases itself — `ethos listen` — the server runs the match, so `sensitivity` governs how much transcription slip a phrase tolerates and `idleTimeout` governs the addressing window. Both are read from this file on the server, not from the satellite's.
- **Read-only in the UI.** Settings → Voice shows these values and does not write them; the route table below is what the web editor edits. Change the scalars in this file.
- The `~/.ethos/models/wake/` directory is probed on every `ethos listen doctor` run. A missing directory is a warning for a `fallback` host and a hard failure for a `sherpa` one.

## voice.wake.routes.\<id\>.\<field\> {#voice-wake-routes}

Type: dotted group, keyed by route id · Default: no routes

The phrase → personality table. The route id is yours to choose and must match `[A-Za-z0-9_-]+`; an id outside that charset is dropped, because a key the serializer could not write back would corrupt the file later.

| Field | Type | Default | Description |
|---|---|---|---|
| `phrase` | string | — | The spoken trigger, e.g. `engineer`. Required. Matched with an optional leading greeting on either side — `hey`, `hi`, `hello`, `ok`, `okay`, `yo`, `hey there` — so a phrase written `engineer` also answers to "hey engineer", and one written `hey engineer` also answers to "engineer". Write it without the greeting; the two spellings are one trigger, so two routes differing only by a greeting can never both fire — the first in the table wins. |
| `personality` | string | — | Personality id this phrase wakes. Required. Resolved against the live registry at wake time, so a route naming a deleted or renamed personality is refused rather than silently defaulted. |
| `privileged` | boolean | `false` | Opt-in required before a **privileged** personality is reachable by voice — one whose toolset can reach a tool the approval layer would stop and ask about. See [Why can't a voice in the room reach a privileged personality?](../../explanation/wake-privilege.md). |
| `enabled` | boolean | `true` | Switch a route off without deleting it. |

```yaml
voice.wake.routes.kitchen.phrase: engineer
voice.wake.routes.kitchen.personality: engineer
voice.wake.routes.kitchen.privileged: true
```

Notes:

- A route missing `phrase` **or** `personality` is dropped entirely rather than half-built — a half-route would look configured in the Settings table and never fire.
- **The phrase must open the utterance.** Matching is head-anchored and word-aligned, so "so I said hey engineer to nobody" does not fire. The longest matching phrase wins, and the matched words — the greeting included — are stripped before the turn runs, so `engineer, did CI pass` and `hey engineer, did CI pass` both reach the agent as `did CI pass`.
- **Implicit routes.** Every unprivileged personality also answers to its own name, synthesized server-side and never written to this file. Those carry the id `auto:<personalityId>` — outside the charset above, so they can never collide with one of yours. A configured route naming a personality suppresses that personality's implicit route, including a route you set to `enabled: false`.
- Saving the table in **Settings → Voice → Wake routes** pushes it to every connected satellite. Hand-editing this file applies on the next satellite reconnect or server restart; nothing watches the file.
- Implicit routes are shown in the Settings editor and cannot be saved back — they are not entries in this file.

## voice.wake.nodes.\<id\>.\<field\> {#voice-wake-nodes}

Type: dotted group, keyed by node id · Default: no overrides

Per-satellite overrides. The key is the node's own stable id, which it generates once and persists in `~/.ethos/listen-node-id` on that machine — `ethos listen doctor` prints it on the `node id` row.

| Field | Type | Default | Description |
|---|---|---|---|
| `inputDevice` | string | unset | Host-specific capture device id. **Pushed on the wire and read by no shipped host today** — `ethos listen` enumerates only its stdin pipe, and the desktop host has no capture device at all. |
| `enabled` | boolean | `true` | Switch one microphone off without touching the others. ANDed with the fleet-wide `voice.wake.enabled`. |

```yaml
voice.wake.nodes.pi-kitchen-f089dce2.enabled: false
```

Notes:

- An entry with no recognised field is dropped rather than kept as an empty object.
- A node muted from its Settings row is muted over the wire instead, and the satellite persists that choice across restarts — that path does not write this key.

## See also {#see-also}

- [config.yaml reference](../config-yaml.md): the index of every section and its page.

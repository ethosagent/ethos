---
title: "Run a wake satellite"
description: "Run ethos listen on a spare machine so saying a personality's name reaches it: routes and preflight here, mic, audio and Settings in parts."
kind: how-to
audience: user
slug: run-a-wake-satellite
time: "20 min"
updated: 2026-11-03
---

## Task

Put a microphone in another room — a Pi, a spare laptop, the machine under the desk — say `engineer` into it, and have the named [personality](../../getting-started/glossary.md#personality) (a directory of files that decides the agent's tools, memory, and model) answer with its toolset and memory scope intact.

## Result

- A [wake satellite](../../getting-started/glossary.md#wake-satellite) (a separate process that owns a microphone and streams speech to the Ethos server) connects to `ethos serve` and appears as a live row under **Settings → Voice → Wake routes**.
- The named personality **answers out loud** in that room, through a player the satellite found on PATH or one you named with `--play`. Find no player and the reply is text only — nothing crashes.
- An utterance that **opens with a personality's name** runs a turn as that personality. A greeting in front of the name (`hey`, `hi`, `hello`, `ok`, `okay`, `yo`, `hey there`) is optional, and the whole address is stripped — `engineer, did CI pass` and `hey engineer, did CI pass` both reach the agent as `did CI pass`.
- Follow-ups within `voice.wake.idleTimeout` continue with the same personality, with no name — you do not re-address somebody you are already talking to.
- Everything else is transcribed and discarded: no turn, no model call, no reply.
- Each personality keeps its own conversation on that node, so re-waking one resumes where it left off and waking another does not continue somebody else's thread.
- Editing the route table in Settings reaches connected microphones without a restart.

## The model, in one paragraph

The microphone is **open**, and the server decides who was addressed. Every utterance the satellite captures is transcribed, and the server matches that transcript against the effective route table: a match picks the personality and runs the turn, a follow-up inside the idle window continues with that same personality, and anything else is dropped without reaching a model. `ethos listen` matches nothing itself — it registers `phraseMatch: false` and the gate runs where the transcript already is.

That has a privacy consequence worth stating plainly: **the room is transcribed.** Not every utterance reaches an agent, but every utterance reaches speech-to-text. What you get to choose is *where* — by default the audio is streamed to the server and transcribed there; with `voice.wake.edgeStt` and a **local** provider it is transcribed on the satellite itself and only the words go up. See [Keep the audio on the machine](run-a-wake-satellite/edge-stt-and-settings.md#5-keep-the-audio-on-the-machine). An acoustic gate that decides before recognition is the `sherpa` engine, and it is not installed (see below).

## What this does not do yet

Read this before you buy hardware.

- **`ethos listen` does not gate on sound.** Nothing on this host compares audio to a phrase; the phrase gate is server-side and runs on the transcript. The room is transcribed either way.
- **Acoustic wake needs a part that is not installed.** The `sherpa` engine is an optional native peer (`sherpa-onnx-node`, a per-architecture binary of roughly 33 MB) plus four model files. Its adapter is written against sherpa's documented keyword-spotter surface and has never been run against a real binary in this repository.
- **The desktop app cannot listen.** The Electron main process ships no microphone binding, so its satellite host fails its own `capture-device` probe, reports `degraded`, and declines to start. That refusal is deliberate: a green dot over a microphone that produces nothing is worse than no dot.
- **Wake quality is unmeasured.** There are no false-accept or false-reject numbers for any engine here, because no test corpus exists.
- **Speaking needs a player on the satellite.** `ethos listen` ships no audio binding, so it spawns a command (`ffplay`, `aplay`, `play`, or your `--play`) and writes the reply's audio into it. A machine with none of those registers `playback: false`, the server skips synthesis for that node, and the answer comes back as text only — printed as `‹ engineer: …` under the transcript of what you said.
- **`aplay` and `play` take raw PCM only.** Most speech-to-text providers synthesize opus or mp3, which those two cannot open — a reply arrives, the row says so, and it stays text. Install `ffmpeg` (for `ffplay`), or set `auxiliary.tts.outputFormat: pcm`.
- **The reply's sample rate is a guess for raw PCM.** No `TtsProvider` reports the rate of the bytes it produced and the wire field is optional, so the satellite falls back to 24 kHz. If a spoken reply sounds fast or slow, pin it with `--play` and your own `-ar`.

## Prereqs

- `ethos serve` running and reachable from the satellite machine. The lane is hosted by the web API at `GET /satellite/ws`, not by `ethos gateway`.
- A speech-to-text provider configured, because the server transcribes what the satellite sends. Any route in [Local voice](./local-voice.md) works.
- `ffmpeg` (macOS) or `arecord` (Linux) on the satellite machine. `ffmpeg` is already documented for [voice notes on channels](./voice-notes-on-channels.md); here it doubles as the capture source — and its `ffplay` is what the satellite spawns to speak the reply.
- No new runtime dependency. The daemon's open-mic capture and the server's phrase matching both load no native binding and no model file.

## Parts

This page covers routes and the preflight. The other parts take the same setup further.

| Part | Covers |
|---|---|
| [Microphone and playout](run-a-wake-satellite/microphone-and-playout.md) | Steps 3 and 4: pipe a microphone in, pin it to one agent, speak replies. |
| [Edge speech-to-text and Settings](run-a-wake-satellite/edge-stt-and-settings.md) | Steps 5 to 7: on-device transcription, the Settings panel, privileged personalities, and the end-to-end check. |

## 1. Add a wake route

Every unprivileged personality already answers to its own name, with no configuration: the server synthesizes an `auto:<personality-id>` route for each one, pushes the merged table to every satellite on connect, and matches transcripts against it. A deployment that has configured nothing still answers to every personality by name. Write your own route when you want a chosen phrase, a stable id, or a personality the defaults exclude — the rest of this page uses one.

Open **Settings → Voice → Wake routes**, or write it by hand in `~/.ethos/config.yaml`:

```yaml
voice.wake.routes.kitchen.phrase: chief
voice.wake.routes.kitchen.personality: engineer
```

The route id (`kitchen`) is yours to choose and must match `[A-Za-z0-9_-]+`. A route missing either `phrase` or `personality` is dropped on read rather than half-built. Write the phrase without a greeting — `chief`, not `hey chief`. The matcher accepts one either way, so the two spellings are the same trigger, and the shorter one is what the table shows people to say.

A route saved in Settings is pushed to every connected satellite immediately. A route you hand-edit applies on the next satellite reconnect or server restart — nothing watches the file.

## 2. Preflight the satellite machine

Run the doctor before you run the daemon. It asks the engine to load what it would load and the device to enumerate what it would open, so nothing is reported available on a guess. The `satellite-lane` row sends a real WebSocket upgrade to `/satellite/ws` with no auth cookie, so a `401` on it means the lane is mounted and refused the probe — which is the answer it is looking for.

```bash
ethos listen doctor
```

```
ethos listen doctor  wake satellite preflight

  ✓  engine:transcript      no native bindings and no model files — matches wake phrases against STT output
  ⚠  models                 not required by the 'transcript' engine — model directory missing — ~/.ethos/models/wake
  ✓  microphone             1 input device(s): raw s16le mono PCM on stdin @ 16000 Hz
  ⚠  satellite-lane         ws://127.0.0.1:3000/satellite/ws: connection refused (ECONNREFUSED) — nothing is listening there, so the server is not running. Start it with `ethos serve`.
  ✓  speaker                ffplay on PATH — ffplay -nodisp -autoexit -loglevel error -f s16le -ar {rate} -ac {channels} -i -
  –  edge-stt               skipped — voice.wake.edgeStt is off, so every utterance is transcribed by the server: audio WILL be streamed to the server, which transcribes it there — the "no audio leaves the machine" guarantee does not hold on this host.
  ✓  node id                pi-kitchen-f089dce2 (~/.ethos/listen-node-id)
  ✓  satellite url          ws://127.0.0.1:3000/satellite/ws
  –  route                  configured here: kitchen ("chief" → engineer). The effective table is the server's: it adds a bare-NAME route (auto:<personalityId>) for every unprivileged personality, pushes the merged table on connect, and MATCHES transcripts against it — so what this host can be addressed by is only knowable once it has connected. Without --route, every phrase in that table can address this host.

⚠ Nothing is broken on this host, but it cannot listen right now.
```

The `route` row is a dash rather than a verdict. This command never connects, so it has none to give: it reports what your own `config.yaml` contributes and names the server as the authority for the rest.

The `speaker` and `edge-stt` rows are probes, not config reads: the first asks PATH what is installed, and the second **constructs** the speech-to-text provider and reads its real `caps.local`. Neither one moves the exit code — a satellite with no loudspeaker, or one whose audio is transcribed by the server, is still a working satellite. The rows exist so that is a choice rather than a surprise. `edge-stt` reads `–` (skipped) rather than `✓` when `voice.wake.edgeStt` is unset, because a tick there would read as "your audio stays here", which is the opposite of what it means.

Exit codes are `0` clean, `1` for a host that will never hear you (no config, no usable engine, missing models for a `sherpa` host), and `2` for something true right now that may not be in a minute — no pipe attached, or the server not started. Add `--json` for one machine-readable object; its `engine.daemonMode` reads `"open-mic"` and `engine.phraseMatch` reads `false`, so a script cannot infer acoustic wake from the engine name.

If the server is on another machine, point at it:

```bash
ethos listen doctor --url ws://ethos.local:3000
```

```
  ✓  satellite url          ws://ethos.local:3000/satellite/ws
```

A bare origin gets the lane path appended for you.

## Verify

With the server up and the pipe attached, the preflight goes clean — the lane row, the address it would dial, and the route row are what to read:

```bash
ethos listen doctor
```

```
  ✓  satellite-lane         ws://127.0.0.1:3000/satellite/ws is mounted — answered 401 to a probe sent with no auth cookie, which is the expected refusal
  ✓  speaker                ffplay on PATH — ffplay -nodisp -autoexit -loglevel error -f s16le -ar {rate} -ac {channels} -i -
  ✓  edge-stt               on-device: local-stt (caps.local) — this node transcribes the utterance itself and sends only the WORDS upstream. No captured audio leaves this machine.
  ✓  satellite url          ws://127.0.0.1:3000/satellite/ws
  –  route                  configured here: kitchen ("chief" → engineer). The effective table is the server's: it adds a bare-NAME route (auto:<personalityId>) for every unprivileged personality, pushes the merged table on connect, and MATCHES transcripts against it — so what this host can be addressed by is only knowable once it has connected. Without --route, every phrase in that table can address this host.

✓ Preflight clean. Start with ethos listen.
```

That exits `0`: the engine loaded, a device enumerated, a player was found, and the satellite lane answered. Routing is the one thing it does not settle — the server matches each transcript against the table it holds at that moment, and validates a `--route` pin when `ethos listen` connects.

## Troubleshoot

- **`✗ No usable wake engine on this host — not starting.`** Every engine probe failed, including the dependency-free one. Read the `engine:` rows above the message.
- **`⚠ degraded engine:sherpa: sherpa-onnx-node is not installed`** — the acoustic engine is unavailable and the daemon continues as an open mic. Install the peer on that host, or set `voice.wake.engine: fallback`.
- **`⚠ routes the server pushed an EMPTY wake route table`** — same cause, every personality. Every unprivileged one would have been synthesized into that table under its own name, so an empty table means this deployment has none. The daemon keeps running: a Settings save reaches it without a restart. Opt a personality in rather than widening a toolset to get a default back.

## See also

- [`config.yaml` reference: `voice.wake.*`](../reference/config-yaml.md#voice-wake) — every wake key with its bounds and default
- [CLI reference: `ethos listen`](../reference/cli.md#ethos-listen) — flags, exit codes, and the health file
- [Why can't a voice in the room reach a privileged personality?](../explanation/wake-privilege.md) — what the `privileged` flag is defending
- [Local voice: Kokoro TTS + Whisper large v3 STT](./local-voice.md) — wire the speech-to-text provider this page assumes
- [Send and receive voice notes on a channel](./voice-notes-on-channels.md) — the `/voice` mode that decides whether a wake turn is spoken back

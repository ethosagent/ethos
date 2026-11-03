---
title: "Run a wake satellite: microphone and playout"
description: "Pipe a microphone into ethos listen, pin it to one route, and speak replies."
kind: how-to
audience: user
time: "10 min"
updated: 2026-11-03
---

## Task

Feed a microphone into `ethos listen` as raw PCM, optionally pin the host to one route, and let replies play out through a local player.

## Result

The startup banner prints `Listening on raw s16le mono PCM on stdin @ 16000 Hz` and `Replies are spoken through ffplay` (or the player you named).

## Prereqs

- Complete [steps 1 and 2](../run-a-wake-satellite.md): a wake route exists and `ethos listen doctor` has no `✗` row.
- `ethos serve` running and reachable from this machine.

## 3. Pipe a microphone in

`ethos listen` reads raw signed 16-bit little-endian **mono** PCM at **16 kHz** from stdin. There is no microphone binding, deliberately — a native audio module is a per-architecture binary, and this is the daemon that has to run on the Pi where such a binary is broken.

```bash
# macOS
ffmpeg -nostats -loglevel error -f avfoundation -i :0 -ar 16000 -ac 1 -f s16le - | ethos listen
```

```bash
# Linux
arecord -q -f S16_LE -r 16000 -c 1 -t raw | ethos listen
```

Keep the quiet flags. The capture process and the daemon share one terminal, and ffmpeg's progress meter is a carriage-returned line that overwrites the daemon's output mid-word — `› you: hello7.9kbits/s speed= 1x`. `-nostats -loglevel error` drops the banner and the meter; a real failure, such as a device index that does not exist, still prints. `arecord -q` does the same for its one banner line.

The preflight rows print first, then the line that names the lane it is dialling for its route table, then the three that say what this daemon is and what can address it:

```
Connecting to ws://127.0.0.1:3000/satellite/ws for the wake route table...
Open mic: EVERYTHING heard here is transcribed by the server. An utterance reaches an agent only when it OPENS with a personality's NAME — that name picks the personality, and a greeting in front of it is optional — and follow-ups within 30s continue with the same one. Anything else is heard and discarded.
Replies are spoken through ffplay; the text prints too.
Addressable here — say one of these: "chief" → engineer, "researcher". A greeting in front of it ("hey …") is optional.
Listening on raw s16le mono PCM on stdin @ 16000 Hz. Press Ctrl+C to stop; close the pipe to stop talking.
```

Get the sample rate right. Raw PCM carries no header, so piping 44.1 kHz stereo produces garbage that nothing can detect — the flags above are the contract.

From a clone, `make listen` prints both pipelines and then runs the daemon, and `make listen-doctor` runs the preflight.

### Dedicate one microphone to one agent

`--route <id>` **pins** the host: only that route may address it. The garage mic answers `mechanic` and ignores `engineer`, even though both are live in the house's table.

```bash
arecord -q -f S16_LE -r 16000 -c 1 -t raw | ethos listen --route kitchen
```

```
Connecting to ws://127.0.0.1:3000/satellite/ws for the wake route table (pinning to route kitchen)...
Pinned by --route: only "chief" → engineer (route kitchen, from voice.wake.routes) can address this microphone. Other phrases are heard and discarded.
```

Pinning narrows the wake surface; it does not exempt the host from needing an address. The pinned phrase is still required, and another agent's name is discarded rather than treated as a follow-up — so `researcher` at a mic pinned to the engineer never lands in the researcher's conversation. `--route auto:<personality-id>` pins to a synthesized route with no config at all. Without the flag, every enabled route can address this host, which is the usual choice.

## 4. Let it answer out loud

Playout is a pipe, the same way capture is. The daemon spawns a player and writes the reply's audio into its stdin — no audio binding, nothing to compile on the Pi.

Without a flag it probes PATH for `ffplay`, then `aplay`, then `play`, and uses the first one it finds. Install `ffmpeg` on the satellite and there is nothing else to do:

```
  ✓  speaker                ffplay on PATH — ffplay -nodisp -autoexit -loglevel error -f s16le -ar {rate} -ac {channels} -i -
```

The startup banner says which one it will use, before you have waited for a reply to find out:

```
Replies are spoken through ffplay; the text prints too.
```

`ffplay` is probed first because it is the only one of the three that can open what the server usually sends. Every first-party speech provider except a `pcm`-mode `command-tts` synthesizes opus or mp3; `aplay` and `play` take raw samples only, and handed an opus stream they would play the container header as noise. The satellite refuses that rather than making the noise, and says which of the two ends to change.

Name your own player when the defaults do not fit the machine — a specific ALSA device, a Bluetooth sink, a volume filter. `{rate}` and `{channels}` are substituted, and the template runs through `sh -c`, so quoting and pipelines survive:

```bash
ffmpeg -nostats -loglevel error -f alsa -i default -ar 16000 -ac 1 -f s16le - \
  | ethos listen --play "aplay -q -D plughw:1,0 -f S16_LE -r {rate} -c {channels} -t raw"
```

There is deliberately **no config key** for this. Which command drives this machine's sound card is a per-machine operator fact — exactly like the `ffmpeg` input pipe — so it lives on the command line next to it rather than in a file that travels between deployments.

A machine with no player is not broken. It registers `playback: false`, the server skips synthesis for it entirely (no TTS latency, no provider spend on audio nobody will hear), and the reply arrives as text:

```
⚠ speaker replies here are TEXT ONLY — none of ffplay, aplay or play is on PATH, so nothing here can make a sound…
```

### What "listening again" now means

`playback_done` — the frame that tells the server this microphone is live again — is sent when the **player exits**, not when the words are known. The satellite's microphone is suppressed for the whole reply, so an agent cannot hear itself say its own name and wake itself up. If the player never exits, a watchdog re-arms the microphone anyway after 90 seconds and says so; a satellite that is noisily imperfect beats one that has gone silently deaf.

## Verify

Start the pipeline from step 3. The banner prints the `Connecting to ...` line, then `Listening on raw s16le mono PCM on stdin @ 16000 Hz.` Run `ethos listen doctor`; the `speaker` row shows `✓` and names the player.

## Troubleshoot

- **`✗ Nothing is piped to stdin — not starting.`** You ran `ethos listen` from a shell with no pipe. Enumerating a device that will never produce a sample is the false-available failure this preflight exists to refuse. Pipe `ffmpeg` or `arecord` in.
- **`✗ the server's wake route table has no enabled route '<id>'`** — the id after `--route` is not in the table the server pushed, or it is disabled. The message lists every id that was pushed, synthesized `auto:<personality-id>` ones included, then states the rule for the ones it did not.
- **Replies print but nothing is spoken.** Read the `speaker` row. Either no player was found (install `ffmpeg`, or name one with `--play`), or the one you have takes raw PCM and the server is sending opus — the `⚠ playout` line says which, once, rather than once per turn.
- **`⚠ playout the player never reported the speaker draining`** — the player process did not exit within 90 seconds of the reply finishing. The microphone was re-armed anyway rather than left shut, so the satellite keeps working; check whether the command you passed to `--play` exits at end-of-input (`ffplay` needs `-autoexit`).
- **The row says `degraded` after a reply.** The playback watchdog fired: the host never reported playback finishing, so the machine re-armed the microphone without a receipt rather than leaving it parked. The detail on the row names the timeout.

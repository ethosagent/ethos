---
title: "Run a wake satellite: edge speech-to-text and Settings"
description: "Transcribe on the satellite, manage routes in Settings, and reach privileged personalities."
kind: how-to
audience: user
time: "10 min"
updated: 2026-11-03
---

## Task

Keep captured audio on the satellite with a local recognizer, watch the node in Settings, and allow a privileged personality by voice.

## Result

The `edge-stt` doctor row shows `on-device`, the node appears under **Settings → Voice → Wake routes**, and an addressed utterance reaches the named personality.

## Prereqs

- Complete [steps 1 to 4](../run-a-wake-satellite.md): a route exists and the microphone pipeline runs, see [microphone and playout](microphone-and-playout.md).
- For step 5: a local recognizer from [Local voice](../local-voice.md).

## 5. Keep the audio on the machine

By default the satellite streams captured audio to the server, which transcribes it. Turn that around by running the recognizer on the satellite itself:

```yaml
voice.wake.edgeStt: true
auxiliary.asr.provider: local-stt
```

Any recognizer from [Local voice](../local-voice.md) works — `local-stt` or `command-stt` (whisper.cpp behind a command template). The satellite resolves it through the same provider path every other surface uses, so `voice.trustedPlugins` applies here exactly as it does everywhere else.

```
  ✓  edge-stt               on-device: local-stt (caps.local) — this node transcribes the utterance itself and sends only the WORDS upstream. No captured audio leaves this machine.
```

Then the banner says it too:

```
Open mic: EVERYTHING heard here is transcribed ON THIS MACHINE by local-stt — no captured audio leaves it. …
```

**A non-local recognizer is refused, not relabelled.** Point `voice.wake.edgeStt` at `openai-stt` and the satellite declines to declare edge STT, names the provider, and falls back to streaming the audio:

```
  ✗  edge-stt               voice.wake.edgeStt is on, but the recognizer it resolved — "openai-stt" — is not local (caps.local is not true). Running it "at the edge" would upload this room anyway, so edge STT is REFUSED rather than relabelled…
```

That refusal is the whole point of the feature. Declaring `edgeStt: true` for a cloud recognizer would make the server stop sending audio while the audio went to a vendor anyway — the guarantee would be false in exactly the deployment that asked for it. The check reads the constructed provider's `caps.local`, never the name you gave it, so a roster entry called `local-whisper` backed by a hosted transcriber is refused too.

On the wire, an edge node sends `wake`, `utterance_start`, and a `transcript` — and **no `audio` frames at all**. The two are alternatives, and the client refuses to send both for one utterance.

If the local recognizer fails mid-turn, the utterance is discarded and the microphone re-arms. It does **not** fall back to uploading the audio; that would be the worst possible response to a local failure.

## 6. Watch it from Settings

Open **Settings → Voice → Wake routes**. The connected satellite appears as a row carrying what the node itself reported: its state (`listening`, `muted`, `speaking`, `wake off`, `degraded`), its capabilities, its last wake event, and any failing preflight probe inline. The state is never inferred from "the socket is open" — a microphone that misreports whether it is listening is a privacy defect, not a cosmetic one.

Two things on the row come from the gate. The capability label ends in `server matches` for `ethos listen` and `matches phrases` for a host with an acoustic spotter — which end matched the phrase is the same privacy fact as which end transcribed. And while a conversation is open the row says `follow-ups reach <personality> · 24s left`, so an unaddressed sentence that reached an agent is explainable rather than surprising.

The **Say a phrase** tester in the same panel proves a route before you save it: speak, and the row that would answer lights up in that personality's accent. It uses this browser's microphone and the transcript matcher, so it needs the same speech-to-text provider the server uses.

Mute one node from its row. `ethos listen` holds that choice in memory only, so a muted microphone comes back **listening** after the daemon restarts — re-mute it from the row. (The Electron host does persist its wake-off state, but it has no capture device, so nothing there is listening to mute.)

The scalar knobs below the table — engine, sensitivity, confirmation frames, edge speech-to-text, idle timeout — are shown read-only. Change them in `config.yaml`; see the [`voice.wake.*` reference](../../reference/config-yaml.md#voice-wake).

## 7. Reach a privileged personality

A personality whose toolset can reach a tool the approval layer would stop and ask about gets no bare-name default, and a plain route pointed at it is refused:

```
"engineer" is privileged; set voice.wake.routes.kitchen.privileged: true to reach it by voice.
```

If you accept that anyone within earshot can trigger it, opt in out loud:

```yaml
voice.wake.routes.kitchen.privileged: true
```

Why the default is a refusal rather than a warning is in [Why can't a voice in the room reach a privileged personality?](../../explanation/wake-privilege.md).

## Verify

The daemon also writes a heartbeat every 10 seconds:

```bash
cat ~/.ethos/listen-health.json
```

```json
{"pid":41233,"startedAt":"2026-08-14T09:12:04.113Z","updatedAt":"2026-08-14T09:12:34.140Z","adapters":[{"name":"satellite","ok":true},{"name":"capture","ok":true}],"captureState":"listening"}
```

Finally, confirm the personality really answered as itself: ask it for something only its toolset allows. One addressed turn narrates as four lines — what opened, what the server heard, what the personality said, and the re-arm:

```
● speech — utterance u1-mst43nas open
  › you: researcher, what is on my calendar
  ‹ researcher: Two meetings, both after lunch.
  ↩ turn complete. Listening again.
```

The `●` line names no personality, because none has been chosen yet: the words decide, and nobody has heard them. The `‹` line is the answer in text, and the name on it is the personality the server matched — on a host with a player the room heard the same words spoken, and the `↩` line arrives only once the speaker has gone quiet. The woken personality arrives with its own tools, memory scope, and model routing; that is the point of routing to a personality rather than to a prompt.

Now say something that names nobody. The room's ordinary traffic looks like this:

```
  › you: could you pass the salt
  ↩ not addressed to anyone — no agent was called. Open with a personality's name to reach one. Listening again.
```

Heard, transcribed, discarded. No turn ran and no tokens were spent.

Then prove the conversation continues without the name. Say `researcher, what can you do`, and within `voice.wake.idleTimeout` say `tell me more` — the second reaches the researcher too, and the `‹` line names it. Wait out the window and say `tell me more` again: that one is not addressed to anyone. The window is per-connection and dies when the daemon restarts; the conversation itself does not, so re-waking the researcher after a reboot resumes the same history.

## Troubleshoot

- **The personality you wanted is not in that list at all.** It is privileged, so it gets no `auto:<personality-id>` default — its toolset can reach a tool the approval layer would stop and ask about, and a personality with no `toolset.yaml` gets every tool and counts too. Nothing is broken; give it a route and opt it in, as in *Reach a privileged personality* above. The satellite is never told which personalities were withheld, so the message states the rule rather than naming names.
- **Every utterance says `not addressed to anyone`.** The transcript is not opening with a phrase the server holds. Check what the `› you:` line actually says — speech-to-text may be hearing `engine ear` — then raise `voice.wake.sensitivity`, or add a route with the phrase as it is being transcribed. Do not add a route for the greeting: `hey`, `hi`, `hello`, `ok`, `okay`, `yo` and `hey there` are already stripped before matching. The name must be at the **head** of the utterance: "so I said hey engineer to nobody" is talking *about* the agent, not to it.
- **A sentence you did not address reached an agent anyway.** The idle window was still open from the previous turn, which is the intended behaviour — the row in Settings shows `follow-ups reach <personality>` while it is. Shorten `voice.wake.idleTimeout` if the room talks past the agent often.
- **`No wake route matches "<phrase>"`** from the server — only a host that matches phrases itself (the desktop satellite) can produce this: its pushed table is stale, or the route was deleted. It refreshes on reconnect.
- **`⚠ edge stt … is not local`** — `voice.wake.edgeStt` is on, but the recognizer it resolved is a cloud provider. Edge STT is refused rather than relabelled, so audio *is* being streamed to the server. Point `auxiliary.asr.provider` at a local recognizer — see [Local voice](../local-voice.md).
- **`⚠ edge stt on-device transcription failed`** — the local recognizer threw. That utterance was discarded and the microphone re-armed; nothing was uploaded as a fallback, deliberately. Fix the recognizer (`ethos doctor` reports it) rather than expecting a retry.
- **`● speech` prints and nothing follows it.** The utterance held less than 400 ms of speech, so the satellite discarded it locally instead of sending room noise to speech-to-text. No turn ran, and the microphone re-armed immediately. A pipe that does this constantly is a microphone with too much gain.
- **An empty `› you:` line, then the re-arm.** The audio reached the server and the speech-to-text provider heard nothing in it. That is a report, not a failure — no turn ran, and nothing needs repeating.

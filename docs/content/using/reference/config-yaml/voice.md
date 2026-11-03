---
title: "config.yaml: voice keys"
description: "config.yaml voice tier, realtime, mode and transcode keys."
kind: reference
audience: user
updated: 2026-11-03
---

## Synopsis {#synopsis}

Keys that configure voice in and out. Part of the [config.yaml reference](../config-yaml.md).

## voice.tier {#voice-tier}

Type: `pipeline` | `realtime` · Default: unset (the surface decides)

The deployment's default voice engine. `pipeline` — speech-to-text → the agent turn → text-to-speech, the only tier local providers can serve, and the explicit private/offline mode. `realtime` — one hosted speech-to-speech session owns listening and speaking together. Unset means "try realtime where a provider is configured, otherwise pipeline". An unrecognised value is ignored rather than thrown on, so a typo cannot make the config unloadable. A personality's own [`voice.tier`](../personality-yaml.md#voice) beats this.

```yaml
voice.tier: realtime
```

Only an explicit `pipeline` refuses a realtime call outright — the browser is told `pipeline_preferred` and continues silently, because nothing went wrong. Editable in **Settings → Voice**, along with every key below.

## voice.realtime.providers.\<name\>.\* {#voice-realtime-providers}

Type: dotted roster · Default: unset (no realtime provider)

Named hosted speech-to-speech engines. `<name>` is a label you choose — a personality points at it by name, and [`voice.realtime.default`](#voice-realtime-default) names the one everything else uses. Labels are restricted to `[A-Za-z0-9_-]+`. There is no `auxiliary.*` fallback for this roster: no entry means no realtime tier.

| Field | Type | Description |
|---|---|---|
| `provider` | string | Registered provider id. Required. `openai-realtime` — OpenAI Realtime, 24 kHz in and out, issues browser credentials. `gemini-live` — Gemini Live, 16 kHz in / 24 kHz out, **cannot serve a browser call** (see the note below). |
| `model` | string | Provider model id. Defaults to `gpt-realtime` for `openai-realtime`. |
| `apiKey` | string | The provider key. Use a [`${secrets:...}`](../secrets-resolver.md) reference rather than a literal. |
| `baseUrl` | string | Override the provider's endpoint. |
| `voice` | string | Default voice id for this entry. The speaking personality's own `voice.tts_voice` beats it — switching tiers must not switch who you are talking to. |
| `costPerMinuteUsd` | float | The provider's published rate, typed by you. A realtime session bills by wall-clock audio time, so this is the only number that turns duration into money, and the only thing [`voice.realtime.sessionBudgetUsd`](#voice-realtime-session-budget) can act on. Absent = no rate known, nothing accrues, and a budget cannot bite. |

```yaml
voice.realtime.providers.live.provider: openai-realtime
voice.realtime.providers.live.model: gpt-realtime
voice.realtime.providers.live.apiKey: ${secrets:voice/realtime/providers/live/apiKey}
voice.realtime.providers.live.costPerMinuteUsd: 0.06
```

Notes:

- **The label buys nothing.** The [local-only egress gate](#voice-trusted-plugins) keys on the entry's `provider` and the constructed provider's own `caps.local`, so an entry named `local-realtime` backed by a hosted model is refused before a session opens. List the **provider id** in `voice.trustedPlugins`, not the label.
- **`gemini-live` is contract-only in this release.** It proves the provider contract is not OpenAI-shaped and is exercised by the shared conformance suite, but it declares `caps.ephemeralToken: false` — there is no browser credential to mint, and no server-relay path ships in this phase. A browser call selecting it is refused with `no_browser_token` and continues on the pipeline tier behind a visible notice. This is a stated limitation, not a bug.

## voice.realtime.default {#voice-realtime-default}

Type: string · Default: unset

Which [roster entry](#voice-realtime-providers) a call uses when the personality names none — `voice.realtime.default: live` for the example above. A **label** from that roster, never a provider id. Naming an entry the deployment does not have is reported as `unknown_entry` and the call continues on the pipeline.

## voice.realtime.sessionBudgetUsd {#voice-realtime-session-budget}

Type: float (USD) · Default: unset (no cap) · Must be `> 0`

Spending cap on **one** realtime session — the entry's `costPerMinuteUsd` times the session's audio minutes, plus what any `agent_consult` turns spent. On reaching it the session speaks a short sign-off and *then* closes, in that order, and the call strip shows a `budget reached` chip. A session on an entry with no `costPerMinuteUsd` accrues nothing, so this cap never fires for it.

```yaml
voice.realtime.sessionBudgetUsd: 1.50
```

Notes:

- A lowered cap takes effect on the next call; **removing** a cap takes effect on restart. Where the live read and the boot snapshot disagree, the boot cap stands — the direction to be wrong in when the subject is money.
- The personality's own [`budgetCapUsd`](../personality-yaml.md#budget-cap-usd) also governs this lane; the lower of the two binds.

## voice.trustedPlugins {#voice-trusted-plugins}

Type: comma-separated provider ids · Default: key absent (gate off)

The local-only egress gate. **Declaring the key at all arms it** — an empty value therefore means "trust nothing non-local" and is not the same as omitting the key. Providers advertising `caps.local` (`local-stt`, `local-tts`, `command-stt`, `command-tts`) always pass; every other provider must be named by its **provider id**. A refused provider fails at resolution, before it is handed a byte, on every surface — gateway, browser, `ethos doctor`, and the realtime mint.

```yaml
voice.trustedPlugins: openai-tts, openai-realtime
```

Notes:

- **Settings → Voice → Restrict voice egress** arms the gate and edits the list. The declared-but-empty form is the one shape it cannot write (the web config writer drops empty values) — set that line by hand.
- The refusal reads `<kind> provider "<id>" is not local and is not in voice.trustedPlugins — refusing to send audio off this machine`. See [Keep voice on this machine](../../how-to/local-voice.md#keep-voice-on-this-machine).

## voice.defaultMode {#voice-default-mode}

Type: `off` | `mirror_inbound` | `all` · Default: `mirror_inbound`

Where a conversation starts on spoken replies, on any channel whose adapter declares voice output — Telegram, Slack, Discord, and WhatsApp today.

- `off` — never speak.
- `mirror_inbound` — speak back when spoken to (default).
- `all` — speak every reply.

An unrecognised value is ignored. Change it per conversation in chat with `/voice off|mirror_inbound|all`; that choice is written to `~/.ethos/voice/lane-modes.json` and outlives both `/new` and a gateway restart. A channel switched off with [`voice.channels.<platform>.ttsOut: false`](#voice-channels-tts-out) stays silent even in `all`. See [Send and receive voice notes on a channel](../../how-to/voice-notes-on-channels.md).

```yaml
voice.defaultMode: all
```

## voice.channels.\<platform\>.ttsOut {#voice-channels-tts-out}

Type: boolean, keyed by platform id · Default: unset (the platform follows [`voice.defaultMode`](#voice-default-mode))

Which channels may speak their replies. Accepted platform ids are `telegram`, `slack`, `discord`, `whatsapp`, and `email` (`VOICE_CHANNEL_PLATFORMS` in [`packages/config/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/packages/config/src/index.ts)); an unknown id or a non-boolean value is dropped on read, so a typo cannot invent a channel entry no adapter will act on.

An explicit `false` is an operator decision and outranks the conversation's mode — `/voice all` in a silenced Slack channel still produces text only. An explicit `true` changes nothing on its own; the conversation's mode still decides when to speak.

```yaml
voice.channels.slack.ttsOut: false
voice.channels.whatsapp.ttsOut: true
```

Notes:

- `email` is accepted by the parser but has no voice sink — the email adapter declares no voice caps, so the value is inert.
- Editable in **Settings → Voice**, one switch per channel.

## voice.transcode.\<field\> {#voice-transcode}

Type: dotted group · Default: the per-field defaults below

The ffmpeg stage that normalizes inbound audio before speech-to-text and converts synthesized replies into the container each adapter declared. `ffmpeg` is an **optional** runtime dependency of `ethos gateway start`: without it, audio already in an accepted format still passes through untouched, everything else is skipped rather than delivered unplayable, and the gateway prints `⚠ ffmpeg not found` once at startup.

| Field | Type | Default | Description |
|---|---|---|---|
| `ffmpegPath` | string | `ffmpeg` (resolved on `PATH`) | Path or name of the binary. Set it when ffmpeg is installed somewhere the gateway's `PATH` does not reach. |
| `bitrateKbps` | integer | `32` | Target bitrate for compressed containers (opus, mp3, aac). Must be an integer in `8`–`320`; a value outside that range, or a non-integer, is **dropped, not clamped**, and the default stands. 32 kbps is a speech setting — raise it only if you are shipping music. |
| `timeout` | integer (**seconds**) | `30` | Budget for one ffmpeg invocation. Must be an integer in `1`–`600`; out-of-range values are dropped. Note the unit: the key is seconds, the internal option is milliseconds. |

```yaml
voice.transcode.ffmpegPath: /opt/homebrew/bin/ffmpeg
voice.transcode.bitrateKbps: 48
voice.transcode.timeout: 45
```

Notes:

- Only the outbound leg reads `bitrateKbps`. Inbound normalization targets the STT provider's preferred container, which is `wav` wherever the provider accepts it.
- Editable under **Settings → Voice → Advanced**.

## See also {#see-also}

- [config.yaml reference](../config-yaml.md): the index of every section and its page.

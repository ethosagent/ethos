---
title: "Personality config: safety, voice, display and outbound policy"
description: "Personality config fields for safety, voice, display and outbound policy."
kind: reference
audience: user
updated: 2026-11-03
---

## Synopsis {#synopsis}

Fields that gate behavior and shape output. Part of the [Personality config reference](../personality-yaml.md).

## safety {#safety}

Per-personality safety config. Unlike the other fields, `safety:` is a true nested block — YAML indentation matters here.

```yaml
safety:
  approvalMode: manual
  observability:
    storeToolArgs: redacted
    storeLlmPayloads: metadata
    redactPatterns:
      - sk-ant-
      - sk-or-
```

### safety.approvalMode {#safety-approval-mode}

Type: `manual` | `smart` | `off` · Default: `manual`

Decides what happens when a tool call is classified `dangerous`.

| Value | Behaviour |
|---|---|
| `manual` | Every `dangerous` classification surfaces the approval prompt (the web UI modal, or a Slack / Telegram / Discord card); `safe` auto-fires; `blocked` errors out. `ethos chat` asks in the terminal (a `y/N` line in the readline REPL, a modal in the TUI). Where nobody can answer — `ethos chat -q`, piped stdin, `ethos -z`, `batch`, `eval`, `cron`, `bench`, `ethos mcp serve`, `ethos acp` — the call is refused (`wireTerminalApprovalGate`, `apps/ethos/src/terminal-approval.ts`). See [Set up approval gates](../../how-to/set-up-approval-gates.md). |
| `smart` | An auxiliary fast-model call reviews each `dangerous` classification and either auto-approves, auto-denies, or escalates to `manual`. Trades latency and dollars for reduced approval fatigue. |
| `off` | `dangerous` classifications auto-fire without prompting; the hardline `blocked` floor still applies. Honoured only on unattended cron — the gateway's cron/dream loop and `ethos cron run` / `ethos cron daemon` — with `allowUnattendedDangerousTools: true`, and in `ethos chat` and the other operator-invoked CLI commands. A command using `$(…)` or backticks is never auto-approved: the CLI asks about it and unattended cron refuses it; everywhere else `off` behaves like `manual`. |

Notes:

- `approvalMode: off` paired with any channel ingress (`platform: telegram / discord / slack / whatsapp / email`) is rejected at config load.

### safety.observability.* {#safety-observability}

Controls what the observability store persists for this personality.

| Field | Values | Description |
|---|---|---|
| `safety.observability.storeToolArgs` | `none` \| `redacted` \| `full` | Tool-call arguments. |
| `safety.observability.storeToolBodies` | `none` \| `redacted` \| `full` | Reserved. Accepted and validated, but tool-call result bodies are never stored at any setting; only the result size is recorded. |
| `safety.observability.storeLlmPayloads` | `none` \| `metadata` \| `full` | LLM request and response payloads. |
| `safety.observability.redactPatterns` | string[] | Substrings redacted from anything stored. |
| `safety.observability.exportTraces` | `true` \| `false` (default `true`) | Whether this personality's turn traces are sent to the OTLP exporter; `false` keeps them local (the poller marks them `opted_out` and never sends them). A value other than `true` or `false` fails the personality load. See [Export traces to an OpenTelemetry collector](../../how-to/export-traces-otlp.md#keep-one-personalitys-traces-local). |

## voice.\* {#voice}

Type: dotted block · Default: unset (inherit the deployment's voice config)

How this personality sounds, which engines serve it, and how its call is drawn. A deployment picks the *provider*; the personality picks how it *sounds* and how it *looks*, so anything declared here beats the global [`auxiliary.tts.*` / `voice.*`](../config-yaml.md#voice-tier) and `display.call_style` settings, and silence means inherit. The provider, voice and call-look keys are editable in the web Personalities tab (Identity step); `tier`, `model` and the language map are file-only.

| Field | Type | Description |
|---|---|---|
| `voice.tts_voice` | string | Voice id handed to the TTS provider. Provider-specific and free-form — `af_bella` for Kokoro, `alloy` for OpenAI. |
| `voice.languages.<tag>` | string | BCP-47 tag → voice id. Beats `tts_voice` when the turn's language is known. Two surfaces supply one: browser talk-mode reports the language it heard, and the gateway derives it from an inbound voice note's transcript with `detectLanguage()` (`@ethosagent/voice-text`). Detection is constrained to the tags declared here and to nothing else — a personality with no language map supplies no candidates, so no guess is made and `tts_voice` wins. |
| `voice.tier` | `pipeline` \| `realtime` | Preferred voice engine, beating the deployment's [`voice.tier`](../config-yaml.md#voice-tier). A preference, not a guarantee: a deployment with no realtime provider serves `pipeline` either way. An unrecognised value is dropped rather than thrown on — a bad voice field must not make a personality unloadable. |
| `voice.tts_provider` | string | Names an entry in the deployment's TTS roster (`voice.tts.providers.<name>`). A **label** the operator chose, never a provider id. A name this machine lacks falls back to the default `auxiliary.tts` entry, so a shared personality still speaks. |
| `voice.stt_provider` | string | The same, for the STT roster. A personality's voice is identity; its ear is a technical override. |
| `voice.realtime_provider` | string | The same, for the [realtime roster](../config-yaml.md#voice-realtime-providers). Consulted only on the realtime tier; falls back to `voice.realtime.default`. |
| `voice.model` | string | Fast-lane model for spoken turns — a small, quick model for conversation, so a voice lane never waits on the agentic default. Pinned onto the lane's runner once when the session opens, not per turn, so every host that opens a voice lane (the LiveKit adapter, the SIP adapter) gets the routing without having to remember it. Resolves from the personality alone: the deployment's `model` is deliberately not a fallback, since handing it over would pin every spoken lane to the model this key exists to keep off it. Unset leaves the runner untouched. |
| `voice.call_style` | `liquid` \| `orb` \| `rings` | Which treatment the Call Stage draws for this personality — `liquid`, the circle filling like a vessel; `orb`, a body deforming with the voice; `rings`, concentric rings breathing outward. Unset is **not** a fixed default: the treatment falls through to the operator's `display.call_style` when that names a concrete shape, and otherwise to one derived from the personality id, so every personality already looks distinct. An unrecognised value is dropped rather than thrown on. |

```yaml
voice.tts_voice: af_bella
voice.languages.es: ef_dora
voice.tier: realtime
voice.realtime_provider: live
voice.call_style: rings
```

Notes:

- Voice-id precedence, resolved in one function (`resolveVoicePreferences`) so every surface agrees: `voice.languages.<tag>` > `voice.tts_voice` > the chosen entry's own `voice` > global `auxiliary.tts.voice`. A realtime call uses the same order, so switching tiers does not switch who you are talking to.
- Naming a roster entry buys no trust. The [egress gate](../config-yaml.md#voice-trusted-plugins) keys on the entry's underlying `provider`, so an entry called `local-anything` backed by a hosted model is still refused.
- `voice.provider` is accepted on read as the older spelling of `voice.tts_provider` and re-serialized as the new one; a file never carries both.
- Talk-mode also needs `voice_session` in [`toolset.yaml`](../personality-yaml.md#toolset-yaml). Without it the phone button renders disabled.
- Call-look precedence, resolved in one function (`resolveCallTreatment` in `packages/types/src/personality.ts`) so every surface agrees: `voice.call_style` > a concrete `display.call_style` > derived from the personality id. `display.call_style: personality` is the default and is not a pin — it defers to the derivation.
- Confirm what parsed with `ethos personality show <id>` — it emits a `## Voice` block, and omits the section entirely when the personality declares no `voice` block. Its `Call look` line names the derived treatment when the key is unset, because there is no blank state to report.

## display.\* {#display}

Type: dotted block · Default: unset (every surface draws the generated mark)

How this personality looks where its name is shown. Both keys are sub-keys of one identity block, so they do not move `.personality-field-count`. Parsed by `buildDisplayConfig` in [`extensions/personalities/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/personalities/src/index.ts); the type is `PersonalityConfig.display` in [`packages/types/src/personality.ts`](https://github.com/ethosagent/ethos/blob/main/packages/types/src/personality.ts).

| Field | Type | Description |
|---|---|---|
| `display.avatar_url` | string | URL of a served or uploaded avatar image. Set by the avatar upload on the web Personalities page (`FilePersonalityRegistry.writeAvatar`). Unset, or an image that fails to load, falls back to the generated mark. |
| `display.emoji` | string | Exactly one emoji: a pictograph (with an optional skin tone or VS16, or a ZWJ sequence such as a family), a country or subdivision flag, or a keycap. Shown beside the name in the CLI chat header, the TUI, the character sheet and the web identity rows; it never replaces the generated mark. Also the default receipt reaction and the `{emoji}` placeholder of a channel [reply prefix](../config-yaml.md#reply-prefix). Checked by `isSingleEmojiGrapheme` ([`packages/types/src/display-emoji.ts`](https://github.com/ethosagent/ethos/blob/main/packages/types/src/display-emoji.ts)). Editable in the web Personalities tab, next to the avatar. |

```yaml
display.emoji: 🦉
display.avatar_url: /api/personalities/scout/avatar
```

Notes:

- An invalid `display.emoji` (`🦉🦉`, `ab`, a pasted sentence, anything over 32 UTF-16 code units) is dropped with a load warning, and the personality still loads. `ethos personality show <id>` prints the warning as `⚠ …`. A save through the web editor or `FilePersonalityRegistry.update` refuses it instead.
- `display.emoji: ''` in an update clears the value, the same convention as `avatar_url`.
- A new personality's [birth ritual](../../how-to/run-a-birth-ritual.md) can propose an emoji. It reaches this file only when you apply the request.

## mcp_export.\* {#mcp-export}

Type: dotted block · Default: unset (not exported). Lets `ethos mcp serve --personality <id>` export this personality as one `ask` tool — walkthrough in [Use Ethos as an MCP server](../../how-to/use-as-mcp-server.md). Parsed by `buildMcpExportConfig` in [`extensions/personalities/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/personalities/src/index.ts). A value outside a key's vocabulary is ignored and the fail-closed default stands — `expose_memory: Scoped` resolves to `none`.

| Field | Default | Description |
|---|---|---|
| `mcp_export.enabled` | absent — no export | Must be the literal `true`. `yes`, `True` and `1` parse as `false` (`buildMcpExportConfig` compares `=== 'true'`). |
| `mcp_export.expose_tools` | `none` | Tools the exported **turn** may use — never published to the caller. `all` is this personality's full reach; a whitespace-separated list is intersected with it, and a name outside it is dropped, not granted. |
| `mcp_export.expose_memory` | `none` | `none` skips the memory prefetch and both memory tools; `scoped` adds read-only `personality:<id>`; `full` adds `memory_write`. |
| `mcp_export.expose_sessions` | `false` | `true` adds `list_conversations` and `get_conversation`, over the calling client's own conversations only. |
| `mcp_export.auth` | `localhost` | `localhost` is stdio only. `bearer` requires an `sk-ethos-` key scoped `mcp:<id>`, and is the only value that can serve HTTP. |

## outbound_policy.\* {#outbound-policy}

Type: dotted block · Default: unset (the agent's `send_message` publishes as soon as it calls it)

Queue this personality's agent-initiated posts for human approval instead of sending them. Full semantics — the lifecycle, the content binding, the refusal codes and what the gate does not cover — are in the [`outbound_policy` reference](../../../building/reference/outbound-policy.md).

| Field | Type | Description |
|---|---|---|
| `outbound_policy.approve_before_send` | boolean | Only the literal `true` switches the gate on (`buildOutboundPolicy` compares `approve === 'true'`). When the key is absent the whole block is skipped and the other two are neither parsed nor validated. |
| `outbound_policy.channels` | whitespace-separated names | Which platforms are gated: `slack`, `telegram`, `discord`, `whatsapp`, `email`. Absent — or an empty list — gates every platform. An unknown name fails the personality load with `Invalid outbound_policy.channels: "<name>"`, so a typo cannot silently leave a platform ungated. |
| `outbound_policy.approver_personality` | personality id | An advisory reviewer that reads the draft and attaches a PASS/FAIL receipt before a human sees it. It can neither approve nor block. An id this machine does not have yields an `unavailable` receipt and the item still reaches the human. |

```yaml
outbound_policy.approve_before_send: true
outbound_policy.channels: telegram slack
outbound_policy.approver_personality: brand-editor
```

Notes:

- The gate exists only where a surface wires the outbox: `ethos gateway start` and `ethos boot`. `ethos chat`, `ethos serve` and `ethos cron` wire none, and `send_message` sends there exactly as it did before the field existed.
- Egress through MCP tools and `a2a_send` is not covered at all. `ethos personality show <id>` prints the posture and that exclusion on one `Publishing:` line.
- Walkthrough: [Approve posts before they go out](../../how-to/approve-posts-before-sending.md).

## See also {#see-also}

- [Personality config reference](../personality-yaml.md): the index of every section and its page.

---
title: "config.yaml reference"
description: "Every field in ~/.ethos/config.yaml — provider, model registry, channel tokens and reply prefix, retention, provider chain, voice, wake, telephony."
kind: reference
audience: user
slug: config-yaml
updated: 2026-11-04
---

`~/.ethos/config.yaml` is a flat `key: value` file. Dotted keys (e.g. `retention.messages`, `providers.0.provider`) are how nested structures appear on disk — there is no indentation-based nesting. Inside double quotes exactly two escapes exist: `\\` is a backslash and `\"` is a quote. Every other backslash is literal, so `"C:\tmp"` and `"C:\Users\me"` read as written. Any other value, single-quoted included, is read with one quote stripped from each end. Ethos quotes a value only when it would not read back unchanged. Ethos refuses to write a value containing a newline, tab or other control character, and the error names the key — the file is line-based, so such a value could not be read back.

## Source {#source}

The full field set lives in the `EthosConfig` interface in [`packages/config/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/packages/config/src/index.ts). `parseConfigYaml` reads values; `writeConfig` writes them. Fields marked `@internal` are managed by the runtime (e.g. `activeContext` by `ethos set`) — do not hand-edit them.

A key the parser never reads, such as a misspelling, is kept in the file but has no effect. It produces a warning naming the key and, when one is close, the key it was probably meant to be: `config.yaml: 'personalty' has no effect — the config parser did not read it; did you mean 'personality'?`. `ethos doctor` prints these warnings, as do `ethos serve`, `ethos gateway` and `ethos boot` at startup. A warning never stops startup. Keys that only the web UI reads (`approvalMode`, `verbosity`, `debugMode`, `contextLayering`, the `display.voice_*` tuning keys) are not reported. The check lives in `ConfigKeyUse` in the same file. It does not yet cover the named rosters, `teams.*`, `webhooks.*`, `quick_commands.*`, `channel_filter.*` or `models.*`.

## Minimal example {#minimal-example}

```yaml
schemaVersion: 1
provider: anthropic
model: claude-sonnet-5
apiKey: ${secrets:providers/anthropic/apiKey}
personality: researcher
```

This is what `ethos setup` writes for a default Anthropic install. The key value itself lives in the secrets vault (`~/.ethos/secrets/providers/anthropic/apiKey`); config.yaml carries only the reference. Everything below is optional.

## Subpages {#subpages}

| Section | Page |
| --- | --- |
| <a id="schema-version"></a>[schemaVersion](config-yaml/provider-and-model.md#schema-version) | [config.yaml: provider and model keys](config-yaml/provider-and-model.md) |
| <a id="provider"></a>[provider](config-yaml/provider-and-model.md#provider) | [config.yaml: provider and model keys](config-yaml/provider-and-model.md) |
| <a id="model"></a>[model](config-yaml/provider-and-model.md#model) | [config.yaml: provider and model keys](config-yaml/provider-and-model.md) |
| <a id="api-key"></a>[apiKey](config-yaml/provider-and-model.md#api-key) | [config.yaml: provider and model keys](config-yaml/provider-and-model.md) |
| <a id="personality"></a>[personality](config-yaml/provider-and-model.md#personality) | [config.yaml: provider and model keys](config-yaml/provider-and-model.md) |
| <a id="base-url"></a>[baseUrl](config-yaml/provider-and-model.md#base-url) | [config.yaml: provider and model keys](config-yaml/provider-and-model.md) |
| <a id="model-routing"></a>[modelRouting.\<personality\>](config-yaml/provider-and-model.md#model-routing) | [config.yaml: provider and model keys](config-yaml/provider-and-model.md) |
| <a id="model-registry"></a>[modelRegistry.\*](config-yaml/model-registry.md#model-registry) | [config.yaml: model registry and provider chain](config-yaml/model-registry.md) |
| <a id="model-registry-effort"></a>[Effort mapping](config-yaml/model-registry.md#model-registry-effort) | [config.yaml: model registry and provider chain](config-yaml/model-registry.md) |
| <a id="models-max-output-tokens"></a>[models.\<provider\>/\<model\>.maxOutputTokens](config-yaml/model-registry.md#models-max-output-tokens) | [config.yaml: model registry and provider chain](config-yaml/model-registry.md) |
| <a id="providers-chain"></a>[providers.\<i\>.\*](config-yaml/model-registry.md#providers-chain) | [config.yaml: model registry and provider chain](config-yaml/model-registry.md) |
| <a id="server-compaction"></a>[Server-side compaction](config-yaml/model-registry.md#server-compaction) | [config.yaml: model registry and provider chain](config-yaml/model-registry.md) |
| <a id="memory"></a>[memory](config-yaml/memory.md#memory) | [config.yaml: memory keys](config-yaml/memory.md) |
| <a id="memory-vault"></a>[memoryVault.*](config-yaml/memory.md#memory-vault) | [config.yaml: memory keys](config-yaml/memory.md) |
| <a id="memory-approval"></a>[memoryApproval.*](config-yaml/memory.md#memory-approval) | [config.yaml: memory keys](config-yaml/memory.md) |
| <a id="memory-capture-evidence-sessions"></a>[memoryCapture.evidenceSessions](config-yaml/memory.md#memory-capture-evidence-sessions) | [config.yaml: memory keys](config-yaml/memory.md) |
| <a id="telegram-bots"></a>[telegram.bots.\*](config-yaml/telegram-slack-teams.md#telegram-bots) | [config.yaml: Telegram, Slack and Teams keys](config-yaml/telegram-slack-teams.md) |
| <a id="telegram-token"></a>[telegramToken](config-yaml/telegram-slack-teams.md#telegram-token) | [config.yaml: Telegram, Slack and Teams keys](config-yaml/telegram-slack-teams.md) |
| <a id="slack-apps"></a>[slack.apps.\*](config-yaml/telegram-slack-teams.md#slack-apps) | [config.yaml: Telegram, Slack and Teams keys](config-yaml/telegram-slack-teams.md) |
| <a id="teams"></a>[teams.\*](config-yaml/telegram-slack-teams.md#teams) | [config.yaml: Telegram, Slack and Teams keys](config-yaml/telegram-slack-teams.md) |
| <a id="discord-token"></a>[discordToken](config-yaml/discord-slack-whatsapp.md#discord-token) | [config.yaml: Discord, Slack token and WhatsApp keys](config-yaml/discord-slack-whatsapp.md) |
| <a id="discord-default-channel-mode"></a>[discord.defaultChannelMode](config-yaml/discord-slack-whatsapp.md#discord-default-channel-mode) | [config.yaml: Discord, Slack token and WhatsApp keys](config-yaml/discord-slack-whatsapp.md) |
| <a id="discord-approval-role-ids"></a>[discord.approvalRoleIds](config-yaml/discord-slack-whatsapp.md#discord-approval-role-ids) | [config.yaml: Discord, Slack token and WhatsApp keys](config-yaml/discord-slack-whatsapp.md) |
| <a id="discord-post-thinking-placeholder"></a>[discord.post_thinking_placeholder](config-yaml/discord-slack-whatsapp.md#discord-post-thinking-placeholder) | [config.yaml: Discord, Slack token and WhatsApp keys](config-yaml/discord-slack-whatsapp.md) |
| <a id="slack-bot-token"></a>[slackBotToken](config-yaml/discord-slack-whatsapp.md#slack-bot-token) | [config.yaml: Discord, Slack token and WhatsApp keys](config-yaml/discord-slack-whatsapp.md) |
| <a id="slack-app-token"></a>[slackAppToken](config-yaml/discord-slack-whatsapp.md#slack-app-token) | [config.yaml: Discord, Slack token and WhatsApp keys](config-yaml/discord-slack-whatsapp.md) |
| <a id="slack-signing-secret"></a>[slackSigningSecret](config-yaml/discord-slack-whatsapp.md#slack-signing-secret) | [config.yaml: Discord, Slack token and WhatsApp keys](config-yaml/discord-slack-whatsapp.md) |
| <a id="whatsapp-default-mode"></a>[whatsapp.\<i\>.default_mode](config-yaml/discord-slack-whatsapp.md#whatsapp-default-mode) | [config.yaml: Discord, Slack token and WhatsApp keys](config-yaml/discord-slack-whatsapp.md) |
| <a id="bot-daily-budget"></a>[\<bot\>.budget.dailyUsd](config-yaml/bot-settings.md#bot-daily-budget) | [config.yaml: per-bot settings](config-yaml/bot-settings.md) |
| <a id="reply-prefix"></a>[\<bot\>.replyPrefix](config-yaml/bot-settings.md#reply-prefix) | [config.yaml: per-bot settings](config-yaml/bot-settings.md) |
| <a id="mention-by-name"></a>[\<bot\>.mentionByName](config-yaml/bot-settings.md#mention-by-name) | [config.yaml: per-bot settings](config-yaml/bot-settings.md) |
| <a id="receipt-reaction"></a>[Receipt reaction](config-yaml/bot-settings.md#receipt-reaction) | [config.yaml: per-bot settings](config-yaml/bot-settings.md) |
| <a id="gateway-private-chats"></a>[gateway.private\_chats.\<platform\>](config-yaml/bot-settings.md#gateway-private-chats) | [config.yaml: per-bot settings](config-yaml/bot-settings.md) |
| <a id="email-imap-host"></a>[emailImapHost](config-yaml/email-and-web.md#email-imap-host) | [config.yaml: email and web server keys](config-yaml/email-and-web.md) |
| <a id="email-imap-port"></a>[emailImapPort](config-yaml/email-and-web.md#email-imap-port) | [config.yaml: email and web server keys](config-yaml/email-and-web.md) |
| <a id="email-user"></a>[emailUser](config-yaml/email-and-web.md#email-user) | [config.yaml: email and web server keys](config-yaml/email-and-web.md) |
| <a id="email-password"></a>[emailPassword](config-yaml/email-and-web.md#email-password) | [config.yaml: email and web server keys](config-yaml/email-and-web.md) |
| <a id="email-smtp-host"></a>[emailSmtpHost](config-yaml/email-and-web.md#email-smtp-host) | [config.yaml: email and web server keys](config-yaml/email-and-web.md) |
| <a id="email-smtp-port"></a>[emailSmtpPort](config-yaml/email-and-web.md#email-smtp-port) | [config.yaml: email and web server keys](config-yaml/email-and-web.md) |
| <a id="email-trusted-authserv-id"></a>[emailTrustedAuthservId](config-yaml/email-and-web.md#email-trusted-authserv-id) | [config.yaml: email and web server keys](config-yaml/email-and-web.md) |
| <a id="web-server"></a>[web.host, web.port, web.corsOrigins](config-yaml/email-and-web.md#web-server) | [config.yaml: email and web server keys](config-yaml/email-and-web.md) |
| <a id="execution-docker"></a>[execution.docker.\*](config-yaml/runtime-and-retention.md#execution-docker) | [config.yaml: execution, display, retention and notifications](config-yaml/runtime-and-retention.md) |
| <a id="verbose"></a>[verbose](config-yaml/runtime-and-retention.md#verbose) | [config.yaml: execution, display, retention and notifications](config-yaml/runtime-and-retention.md) |
| <a id="skin"></a>[skin](config-yaml/runtime-and-retention.md#skin) | [config.yaml: execution, display, retention and notifications](config-yaml/runtime-and-retention.md) |
| <a id="retention"></a>[retention.*](config-yaml/runtime-and-retention.md#retention) | [config.yaml: execution, display, retention and notifications](config-yaml/runtime-and-retention.md) |
| <a id="personalities-retention"></a>[personalities.\<id\>.retention.*](config-yaml/runtime-and-retention.md#personalities-retention) | [config.yaml: execution, display, retention and notifications](config-yaml/runtime-and-retention.md) |
| <a id="channel-digest"></a>[channelDigest.*](config-yaml/runtime-and-retention.md#channel-digest) | [config.yaml: execution, display, retention and notifications](config-yaml/runtime-and-retention.md) |
| <a id="notifications"></a>[notifications.*](config-yaml/runtime-and-retention.md#notifications) | [config.yaml: execution, display, retention and notifications](config-yaml/runtime-and-retention.md) |
| <a id="logs-rotation"></a>[logs.rotation](config-yaml/operations.md#logs-rotation) | [config.yaml: logs, backup and trust keys](config-yaml/operations.md) |
| <a id="mcp-discovery-concurrency"></a>[mcp.discoveryConcurrency](config-yaml/operations.md#mcp-discovery-concurrency) | [config.yaml: logs, backup and trust keys](config-yaml/operations.md) |
| <a id="backup"></a>[backup.*](config-yaml/operations.md#backup) | [config.yaml: logs, backup and trust keys](config-yaml/operations.md) |
| <a id="security-trusted-github-orgs"></a>[security.trusted_github_orgs](config-yaml/operations.md#security-trusted-github-orgs) | [config.yaml: logs, backup and trust keys](config-yaml/operations.md) |
| <a id="goals-allow-check-commands"></a>[goals.allowCheckCommands](config-yaml/operations.md#goals-allow-check-commands) | [config.yaml: logs, backup and trust keys](config-yaml/operations.md) |
| <a id="learning-replay"></a>[learningReplay.*](config-yaml/learning.md#learning-replay) | [config.yaml: learning and evolver keys](config-yaml/learning.md) |
| <a id="nightly-pass"></a>[nightlyPass.*](config-yaml/learning.md#nightly-pass) | [config.yaml: learning and evolver keys](config-yaml/learning.md) |
| <a id="evolver-cron-enabled"></a>[evolver.cron_enabled](config-yaml/learning.md#evolver-cron-enabled) | [config.yaml: learning and evolver keys](config-yaml/learning.md) |
| <a id="evolver-schedule"></a>[evolver.schedule](config-yaml/learning.md#evolver-schedule) | [config.yaml: learning and evolver keys](config-yaml/learning.md) |
| <a id="voice-tier"></a>[voice.tier](config-yaml/voice.md#voice-tier) | [config.yaml: voice keys](config-yaml/voice.md) |
| <a id="voice-realtime-providers"></a>[voice.realtime.providers.\<name\>.\*](config-yaml/voice.md#voice-realtime-providers) | [config.yaml: voice keys](config-yaml/voice.md) |
| <a id="voice-realtime-default"></a>[voice.realtime.default](config-yaml/voice.md#voice-realtime-default) | [config.yaml: voice keys](config-yaml/voice.md) |
| <a id="voice-realtime-session-budget"></a>[voice.realtime.sessionBudgetUsd](config-yaml/voice.md#voice-realtime-session-budget) | [config.yaml: voice keys](config-yaml/voice.md) |
| <a id="voice-trusted-plugins"></a>[voice.trustedPlugins](config-yaml/voice.md#voice-trusted-plugins) | [config.yaml: voice keys](config-yaml/voice.md) |
| <a id="voice-default-mode"></a>[voice.defaultMode](config-yaml/voice.md#voice-default-mode) | [config.yaml: voice keys](config-yaml/voice.md) |
| <a id="voice-channels-tts-out"></a>[voice.channels.\<platform\>.ttsOut](config-yaml/voice.md#voice-channels-tts-out) | [config.yaml: voice keys](config-yaml/voice.md) |
| <a id="voice-transcode"></a>[voice.transcode.\<field\>](config-yaml/voice.md#voice-transcode) | [config.yaml: voice keys](config-yaml/voice.md) |
| <a id="voice-artifacts"></a>[voice.artifacts.\<field\>](config-yaml/voice-telephony.md#voice-artifacts) | [config.yaml: voice artifacts, LiveKit and telephony keys](config-yaml/voice-telephony.md) |
| <a id="voice-livekit"></a>[voice.livekit.\<field\>](config-yaml/voice-telephony.md#voice-livekit) | [config.yaml: voice artifacts, LiveKit and telephony keys](config-yaml/voice-telephony.md) |
| <a id="voice-bots"></a>[voice.bots.\<i\>.\<field\>](config-yaml/voice-telephony.md#voice-bots) | [config.yaml: voice artifacts, LiveKit and telephony keys](config-yaml/voice-telephony.md) |
| <a id="voice-trunk"></a>[voice.trunk.\<field\>](config-yaml/voice-telephony.md#voice-trunk) | [config.yaml: voice artifacts, LiveKit and telephony keys](config-yaml/voice-telephony.md) |
| <a id="voice-inbound"></a>[voice.inbound.\<field\>](config-yaml/voice-telephony.md#voice-inbound) | [config.yaml: voice artifacts, LiveKit and telephony keys](config-yaml/voice-telephony.md) |
| <a id="voice-barge-in"></a>[voice.bargeIn.\<surface\>.\<field\>](config-yaml/voice-wake.md#voice-barge-in) | [config.yaml: barge-in, display and wake keys](config-yaml/voice-wake.md) |
| <a id="display-voice"></a>[display.voice_\<field\>](config-yaml/voice-wake.md#display-voice) | [config.yaml: barge-in, display and wake keys](config-yaml/voice-wake.md) |
| <a id="display-slow-turn-notice"></a>[display.slow_turn_notice_ms](config-yaml/voice-wake.md#display-slow-turn-notice) | [config.yaml: barge-in, display and wake keys](config-yaml/voice-wake.md) |
| <a id="voice-wake"></a>[voice.wake.\<field\>](config-yaml/voice-wake.md#voice-wake) | [config.yaml: barge-in, display and wake keys](config-yaml/voice-wake.md) |
| <a id="voice-wake-routes"></a>[voice.wake.routes.\<id\>.\<field\>](config-yaml/voice-wake.md#voice-wake-routes) | [config.yaml: barge-in, display and wake keys](config-yaml/voice-wake.md) |
| <a id="voice-wake-nodes"></a>[voice.wake.nodes.\<id\>.\<field\>](config-yaml/voice-wake.md#voice-wake-nodes) | [config.yaml: barge-in, display and wake keys](config-yaml/voice-wake.md) |
| <a id="background-acp-agents"></a>[background.acp.agents.\<name\>.\*](config-yaml/background-and-browser.md#background-acp-agents) | [config.yaml: background agents, browser and search keys](config-yaml/background-and-browser.md) |
| <a id="browser"></a>[browser.\<field\>](config-yaml/background-and-browser.md#browser) | [config.yaml: background agents, browser and search keys](config-yaml/background-and-browser.md) |
| <a id="web-searxng"></a>[web.searxng.url](config-yaml/background-and-browser.md#web-searxng) | [config.yaml: background agents, browser and search keys](config-yaml/background-and-browser.md) |
| <a id="plugins-isolation"></a>[plugins.isolation](config-yaml/plugin-isolation.md#plugins-isolation) | [config.yaml: plugin isolation keys](config-yaml/plugin-isolation.md) |
| <a id="plugins-isolation-id"></a>[plugins.isolation.\<id\>](config-yaml/plugin-isolation.md#plugins-isolation-id) | [config.yaml: plugin isolation keys](config-yaml/plugin-isolation.md) |
| <a id="plugins-host-sandbox"></a>[plugins.host.sandbox](config-yaml/plugin-isolation.md#plugins-host-sandbox) | [config.yaml: plugin isolation keys](config-yaml/plugin-isolation.md) |
| <a id="plugins-host-hook-timeout-ms"></a>[plugins.host.hook\_timeout\_ms](config-yaml/plugin-isolation.md#plugins-host-hook-timeout-ms) | [config.yaml: plugin isolation keys](config-yaml/plugin-isolation.md) |
| <a id="plugins-host-idle-stop-minutes"></a>[plugins.host.idle\_stop\_minutes](config-yaml/plugin-isolation.md#plugins-host-idle-stop-minutes) | [config.yaml: plugin isolation keys](config-yaml/plugin-isolation.md) |
| <a id="plugins-host-max-heap-mb"></a>[plugins.host.max\_heap\_mb](config-yaml/plugin-isolation.md#plugins-host-max-heap-mb) | [config.yaml: plugin isolation keys](config-yaml/plugin-isolation.md) |
| <a id="active-context"></a>[activeContext](config-yaml/background-and-browser.md#active-context) | [config.yaml: background agents, browser and search keys](config-yaml/background-and-browser.md) |
| <a id="file-location"></a>[File location and permissions](config-yaml/background-and-browser.md#file-location) | [config.yaml: background agents, browser and search keys](config-yaml/background-and-browser.md) |

## See also {#see-also}

- [CLI reference](./cli.md) — every `ethos` subcommand and the flags that override what config.yaml sets
- [Back up and restore an Ethos install](../how-to/back-up-and-restore.md) — the `backup.*` keys in practice, plus the one-command move to a new machine
- [Personality config reference](./personality-yaml.md) — the per-personality `config.yaml` and `toolset.yaml` (different file, different schema)
- [How to configure providers](../how-to/configure-providers.md) — task-shaped recipe for switching between Anthropic, OpenAI, OpenRouter, and Ollama
- [Run multiple Telegram bots from one process](../how-to/run-multi-bot-telegram.md) — `telegram.bots` list shape in practice
- [Connect a Telegram bot to a team](../how-to/connect-telegram-to-team.md) — `bind.type: team` and `teams.*` knobs in practice
- [Local voice: Kokoro TTS + Whisper large v3 STT](../how-to/local-voice.md) — the `auxiliary.asr.*` / `auxiliary.tts.*` pipeline keys and the egress gate in practice
- [Send and receive voice notes on a channel](../how-to/voice-notes-on-channels.md) — the `voice.defaultMode` / `voice.channels.*` / `voice.transcode.*` keys in practice, plus the `/voice` command
- [Run a wake satellite](../how-to/run-a-wake-satellite.md) — the `voice.wake.*` keys in practice, and what `ethos listen` can and cannot do
- [Glossary: personality](../../getting-started/glossary.md#personality) — what the term means everywhere else in the docs

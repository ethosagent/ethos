---
title: "Slash commands reference"
description: "Every /command available inside ethos chat — session, personality, model, memory, budget, skin, tools, channel approvals."
kind: reference
audience: user
slug: slash-commands
updated: 2026-05-12
---

Slash commands run synchronously inside `ethos chat` and do not count as a turn. They start with `/` as the first character; anything else is sent to the agent.

## Source {#source}

The readline mode (`ethos chat`) handles a subset of commands in [`apps/ethos/src/commands/chat.ts`](../../../../apps/ethos/src/commands/chat.ts) (`handleSlashCommand`). The full TUI mode handles the complete set in [`apps/tui/src/components/App.tsx`](../../../../apps/tui/src/components/App.tsx) (`handleSlashCommand`). Each command below notes which surface implements it.

## /help {#slash-help}

Show the slash-command list. Available in both surfaces.

Synopsis: `/help`

## /new {#slash-new}

Start a fresh [session](../../getting-started/glossary.md#session). Resets the session cost counter and (in the TUI) clears the visible message history, timeline, and file-activity panes. The session key gets `:<timestamp>` appended so the same working directory can host multiple parallel histories. `/reset` is an alias.

Synopsis: `/new` (alias: `/reset`)

```
> /new
[new session started]
```

## /personality {#slash-personality}

Show or switch the active [personality](../../getting-started/glossary.md#personality). `/personality` prints the current id; `/personality list` prints built-ins; `/personality <id>` switches. In the TUI, switching also re-applies the personality's [skin](./personality-yaml.md#skin) and budget cap. The change is session-local — use `ethos personality set <id>` to persist.

Synopsis: `/personality [list | <id>]`

```
> /personality engineer
[personality: engineer]
```

## /model {#slash-model}

In the readline CLI, prints the active model — switching takes effect only on next restart, so edit `model:` in [`~/.ethos/config.yaml`](./config-yaml.md#model) or set [`modelRouting.<personality>`](./config-yaml.md#model-routing) to persist. In the TUI, opens the model picker modal.

Synopsis: `/model [<name>]`

## /sessions {#slash-sessions}

Open the session picker modal. TUI only.

Synopsis: `/sessions`

## /memory {#slash-memory}

Print `~/.ethos/MEMORY.md` and `~/.ethos/USER.md` (markdown mode) or recent chunks (vector mode).

Synopsis: `/memory`

## /usage {#slash-usage}

Print token counts and dollar cost for the current session.

Synopsis: `/usage`

```
> /usage
Tokens  : 4,213 in · 1,180 out
Cost    : $0.04826
```

## /budget {#slash-budget}

Show running spend against [`budgetCapUsd`](./personality-yaml.md#budget-cap-usd). `reset` clears the counter so the next turn can proceed past the cap.

Synopsis: `/budget [reset]`

## /verbose {#slash-verbose}

Toggle the per-turn timing summary (LLM time, TTFT, tool wall-clock, tokens, cost). Session-local — set `verbose: true` in [`~/.ethos/config.yaml`](./config-yaml.md#verbose) to make it sticky.

Synopsis: `/verbose`

## /readonly {#slash-readonly}

Toggle readonly mode. When on, write-side tools (`write_file`, `patch_file`, destructive terminal commands) are blocked. TUI only.

Synopsis: `/readonly`

## /details {#slash-details}

Set the visibility for the four TUI detail panes (`thinking`, `tools`, `subagents`, `activity`). Each pane can be `hidden`, `collapsed`, or `expanded`. With no arguments, prints the current state. TUI only.

Synopsis: `/details [hidden | collapsed | expanded] [thinking | tools | subagents | activity]`

## /skin {#slash-skin}

List or pick a [skin](../../getting-started/glossary.md#skin). Built-in names: `default`, `mono`, `paper`. `reset` clears the user pin and re-applies the personality-suggested skin. The user pin always wins over the personality's `skin` field; set `skin:` in `~/.ethos/config.yaml` to persist.

Synopsis: `/skin [list | reset | <name>]`

## /tools {#slash-tools}

List the tools available to the current personality, grouped by toolset. TUI only.

Synopsis: `/tools`

## /skills {#slash-skills}

List installed [skills](../../getting-started/glossary.md#skill). TUI only.

Synopsis: `/skills`

## /allow {#slash-allow}

Approve a pending channel sender by pairing code. Readline CLI only — the TUI uses the approval modal.

Synopsis: `/allow <code>`

## /deny {#slash-deny}

Revoke an approved channel sender. Recognised platforms: `telegram`, `discord`, `slack`, `whatsapp`, `email`. Readline CLI only.

Synopsis: `/deny <platform> <senderId>`

## /communications {#slash-communications}

List approved senders and pending pairing codes. `/comms` is an alias. Readline CLI only.

Synopsis: `/communications` (alias: `/comms`)

## /exit {#slash-exit}

Quit the CLI. `/quit` is an alias; `Ctrl+D` does the same.

Synopsis: `/exit` (alias: `/quit`)

## See also {#see-also}

- [CLI reference](./cli.md#ethos-chat)
- [`config.yaml` reference](./config-yaml.md)
- [Personality config reference](./personality-yaml.md)
- [Glossary: session](../../getting-started/glossary.md#session)

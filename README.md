# Ethos

[![CI](https://github.com/MiteshSharma/ethos/actions/workflows/ci.yml/badge.svg)](https://github.com/MiteshSharma/ethos/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Ethos is a TypeScript agent framework where personality is architecture — a directory of files that changes prompt, tools, memory, and model atomically.

A personality lives at `~/.ethos/personalities/<id>/` — three files (`ETHOS.md`, `config.yaml`, `toolset.yaml`) that, when switched, atomically change the agent's prompt, tool access, memory scope, and model. Five ship by default. Sessions persist across CLI, Telegram, Discord, and Slack.

## Try it

```bash
npm i -g @ethosagent/cli          # Node 24+
ethos setup                       # provider + API key + personality
ethos personality show engineer   # character sheet — what it is, has, can reach
ethos chat                        # talk to the agent
/personality engineer             # atomic swap of prompt + tools + memory + model
```

Full install paths, supported providers, and surface setup: [ethosagent.ai/docs/using/quickstart](https://ethosagent.ai/docs/using/quickstart).

## Run it in production

Three commands, and your bots (Telegram + Slack + Discord + Email) and the web dashboard come up under one supervisor, survive reboots, and restart on crash. Works on a mini PC, Raspberry Pi 4+, cheap VPS, or any always-on box:

```bash
npm i -g @ethosagent/cli pm2
ethos setup
curl -O https://ethosagent.ai/ecosystem.config.js
pm2 start ecosystem.config.js && pm2 save && pm2 startup
```

`ethos run-all` is the supervisor (one command spawns gateway + web dashboard); PM2 keeps it alive across reboots. Full walkthrough with sizing, logs, upgrade, and troubleshooting: [Deploy in production →](https://ethosagent.ai/docs/using/how-to/deploy-in-production).

## Two doors

| Path | What it covers |
|---|---|
| **[Use Ethos →](https://ethosagent.ai/docs/using/quickstart)** | Install the CLI, configure a provider, run your first chat, ship a Telegram bot. Five minutes to first message. |
| **[Build on Ethos →](https://ethosagent.ai/docs/building/quickstart)** | Write a tool, add an LLM provider, build a channel adapter, publish a plugin. Ten minutes to first commit. |

Start with [What is Ethos?](https://ethosagent.ai/docs/getting-started/what-is-ethos) for the 90-second mental model, [Why Ethos?](https://ethosagent.ai/docs/getting-started/why-ethos) for honest comparison to LangChain / CrewAI / OpenClaw / Hermes, or the [glossary](https://ethosagent.ai/docs/getting-started/glossary) for every domain term.

## Repo layout

```text
packages/    @ethosagent/{types, core, plugin-sdk, plugin-contract}
extensions/  llm-*, session-*, memory-*, platform-*, tools-*, gateway, ...
apps/        ethos (CLI), tui, vscode-extension
docs/        Docusaurus site — content/, plugins/, scripts/
plan/        Architecture notes and phase plans
```

The CLI binary entry is [`apps/ethos/src/index.ts`](apps/ethos/src/index.ts). Every extension point is a typed interface in [`packages/types/src/index.ts`](packages/types/src/index.ts), injected into `AgentLoop` at construction. Core never imports concrete implementations.

## Contributing

- **[.agents/skills/docs/SKILL.md](./.agents/skills/docs/SKILL.md)** — docs system: page kinds, front-matter contract, voice rules, anti-patterns. Invoked via the `/docs` skill. Read before writing any documentation.
- **[DESIGN.md](./DESIGN.md)** — visual system: tokens, typography, motion, per-surface mapping. Read before any UI work.
- **[CLAUDE.md](./CLAUDE.md)** — codebase guide: architecture, conventions, gotchas, learnings.
- **[Pull-request template](./.github/PULL_REQUEST_TEMPLATE.md)** — the checklist your PR will be evaluated against.

Local setup:

```bash
git clone https://github.com/MiteshSharma/ethos
cd ethos
make prepare    # install deps + git hooks
make check      # typecheck + lint + test (CI mirror)
make dev        # run the CLI from source
```

Open an issue before non-trivial changes; alignment is cheaper than rework. Look for `good-first-issue` to find a starter task.

## License

[MIT](./LICENSE)

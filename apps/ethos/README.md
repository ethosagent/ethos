# Ethos

**The TypeScript AI agent framework where personality is architecture.**

Each personality is a structural component, not a prompt: a curated toolset, a first-person identity, and a memory scope. Specialists ship by default — researcher, engineer, reviewer, coach, operator. Bring your own.

## Install

### One-liner (recommended)

```bash
curl -fsSL https://ethosagent.ai/install.sh | bash
```

Detects platform, installs Node 24 if missing, then runs `npm install -g @ethosagent/cli`. macOS and Linux only.

### npm

```bash
npm install -g @ethosagent/cli
```

Requires Node 24+.

#### Lean install (CLI mode only, no platform adapters)

The default install pulls in **optional** SDKs for the channel adapters
(Telegram, Slack, Discord, email) and the `playwright` browser used by
`vision_analyze`. If you only want the CLI / REPL surface, skip them:

```bash
npm install -g @ethosagent/cli --omit=optional
```

Roughly **2× faster install** and a fraction of the package count.
You can install the specific adapter later when you wire it up — e.g.
`npm install -g @slack/bolt` once you decide to connect Slack. `ethos
doctor` reports which platform SDKs are present.

#### Known install warning

You may see a `npm warn deprecated prebuild-install@7.1.3` line during
install. This comes from `better-sqlite3`'s native-module build chain
(and, on the default install, `sharp` via the optional ML toolkit) —
both upstream libraries still rely on it. `prebuild-install` is
deprecated but functional; install succeeds and Ethos works normally.
Using `--omit=optional` removes the `sharp` half of the warning;
removing the `better-sqlite3` half requires upstream changes we don't
control. Tracked upstream; no action needed on your side.

### From source

```bash
git clone https://github.com/ethosagent/ethos.git
cd ethos
pnpm install
pnpm dev    # tsx apps/ethos/src/index.ts
```

## Quick start

```bash
ethos setup    # one-time wizard: pick provider + key + personality
ethos chat     # start the REPL
ethos cron list
ethos personality list
```

See [ethosagent.ai](https://ethosagent.ai) for full docs, tutorials, and the plugin SDK.

## What's in this package

This is the `ethos` CLI binary. The other public packages plugin authors use:

- [`@ethosagent/types`](https://www.npmjs.com/package/@ethosagent/types) — interface contracts (zero deps)
- [`@ethosagent/core`](https://www.npmjs.com/package/@ethosagent/core) — `AgentLoop`, registries, defaults
- [`@ethosagent/plugin-sdk`](https://www.npmjs.com/package/@ethosagent/plugin-sdk) — tool, hook, memory, and adapter helpers + testing utilities
- [`@ethosagent/plugin-contract`](https://www.npmjs.com/package/@ethosagent/plugin-contract) — marketplace validation schema

## License

MIT — see [LICENSE](./LICENSE).

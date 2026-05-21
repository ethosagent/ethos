---
title: "Why Ethos?"
description: "Comparison of Ethos to LangChain, CrewAI, AutoGen, OpenClaw, and Hermes — the trade-offs we made, and who shouldn't use Ethos."
kind: explanation
audience: shared
slug: why-ethos
updated: 2026-05-11
---

Ethos makes different trade-offs than other agent frameworks. This page is the honest comparison.

## Feature comparison

| Capability | Ethos | LangChain | CrewAI | AutoGen | OpenClaw | Hermes |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Personality as structure (not a prompt string) | ✅ | ❌ | ❌ | ❌ | ~ | ~ |
| Bring an existing skill library (Claude Code, OpenClaw, OpenCode, Hermes) — no porting | ✅ | ❌ | ❌ | ❌ | ✅ | ~ |
| Per-personality file boundary (`fs_reach`) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Per-personality MCP / plugin allowlists (default-deny) | ✅ | ❌ | ❌ | ❌ | ~ | ❌ |
| Swap LLM provider without code changes | ✅ | ~ | ~ | ~ | ✅ | ✅ |
| TypeScript-first interface contracts | ✅ | ❌ | ❌ | ❌ | ~ | ❌ |
| Multi-platform shared sessions (CLI + Telegram + Discord + Slack) | ✅ | ❌ | ❌ | ❌ | ✅ | ~ |
| Memory scope per personality | ✅ | ❌ | ❌ | ❌ | ❌ | ~ |
| Tool access per personality | ✅ | ~ | ~ | ❌ | ~ | ❌ |
| Zero-dependency interface package | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Session persistence across restarts | ✅ | ~ | ~ | ~ | ✅ | ✅ |

✅ full support · ~ partial · ❌ not supported

## The five key differences

### Personality is a structural component

In LangChain, CrewAI, and AutoGen, ["personality"](glossary.md#personality) means setting a system prompt string. Changing it changes how the model responds — and nothing else.

In Ethos, a personality is a directory. Swapping it changes:

- The system prompt (via `SOUL.md`)
- The tool access (via `toolset.yaml`)
- The memory scope (via `memoryScope` in `config.yaml`)
- The model in use (via `model` in `config.yaml`)

All four change atomically. You cannot accidentally run the engineer personality's tools under the reviewer's restricted toolset.

### TypeScript-first, interface-driven

Every extension point in Ethos is a typed interface in `@ethosagent/types`:

```typescript
interface LLMProvider {
  complete(messages: Message[], options: CompletionOptions): AsyncIterable<CompletionChunk>
}

interface SessionStore {
  getMessages(sessionId: string, options?: { limit?: number }): Promise<Message[]>
  addMessage(sessionId: string, message: Message): Promise<void>
}
```

These interfaces have **zero dependencies**. Any package can implement them. Core never imports concrete implementations.

Python frameworks pass dicts and strings. TypeScript catches mistakes at compile time, not at runtime when the agent is mid-task.

### Swap everything

| Component | Interface | Default | Alternatives |
|---|---|---|---|
| LLM | `LLMProvider` | Anthropic, OpenAI-compat | Any HTTP-based LLM |
| Sessions | `SessionStore` | SQLite (WAL+FTS5) | Redis, Postgres, in-memory |
| Memory | `MemoryProvider` | Markdown files | Any storage |
| Channel | `PlatformAdapter` | CLI | Telegram, Discord, Slack |
| Personalities | `PersonalityRegistry` | File system | Remote registry |

LangChain has swap-ability in theory; in practice, changing the underlying LLM requires touching provider-specific abstractions throughout. In Ethos, `LLMProvider` is one interface with one method.

### Your existing skill library already runs — scoped to the right specialist

Most agent frameworks expect you to rebuild your [skill](glossary.md#skill) library to try them. Ethos discovers what you already have:

- `~/.claude/skills/` — Claude Code skills (agentskills.io standard)
- `~/.openclaw/skills/` — OpenClaw skills (incl. the [clawhub](https://clawhub.ai) catalogue)
- `~/.opencode/skills/` — OpenCode
- `~/.hermes/skills/` — Hermes
- `~/.ethos/skills/` — Ethos-native skills

A multi-dialect parser handles each ecosystem's `SKILL.md` format. The discovered pool is then **filtered per personality**: by default, a skill flows to a personality only if its `required_tools` are reachable by that personality's toolset. The `researcher` sees only research-relevant skills, the `engineer` sees code-relevant ones — same global library, different visibility per role.

This is the claim you do not get elsewhere. Other frameworks: universal compatibility OR structural personalities. Ethos: both.

### Multi-platform, shared sessions

The same agent — same personality, same memory, same session history — runs across CLI, Telegram, Discord, and Slack. A user can start a conversation on Telegram and continue it on the CLI. The session key determines continuity, not the platform.

Other frameworks are designed for single-platform deployment. Adding a second platform typically duplicates configuration and state management.

## When Ethos isn't the right choice

**Use LangChain if:** you are building complex multi-step pipelines with many chained operations, or you need the large ecosystem of pre-built integrations.

**Use CrewAI if:** you are building multi-agent systems where several agents collaborate on a single task and the framework's role abstractions match your workflow.

**Use AutoGen if:** you need sophisticated multi-agent conversation patterns or built-in code execution sandboxes.

**Use OpenClaw if:** you want a finished prosumer self-hosted gateway with a baked-in onboarding wizard and you don't need TypeScript extension contracts.

**Use Hermes if:** you want a Python autonomous agent emphasising persistent learning loops, and skill self-creation is a higher priority than personality isolation.

**Use Ethos if:** you are building an interactive agent that a real user talks to, you care about TypeScript correctness, you want to run on multiple platforms, or personality and memory isolation matter to your use case.

## Design decisions

These are deliberate choices, not missing features. Each one trades a capability for a smaller surface area.

### API keys, not OAuth

Ethos stores LLM provider credentials as plain API keys in `~/.ethos/config.yaml`. There is no OAuth flow, no token-refresh thread, no per-provider login dance.

**Why:** OAuth complexity scales with provider count. Every provider has its own refresh-token semantics, scope vocabulary, and expiry behaviour. Each addition is a new failure mode in the agent loop plus a permanent maintenance load. Competing frameworks that picked OAuth ship credential-refresh bugs as a steady-state cost — tokens go stale mid-turn, plaintext credentials get embedded in config, scope mismatches surface as opaque 401s halfway through a tool call.

**The trade-off you accept:** keys live on disk in your home directory. If your machine is compromised, the keys are too. This is the correct trade for a tool already trusted with your shell, git credentials, and editor. If your threat model says otherwise, set keys via environment variables and don't write them to the config file.

**When this changes:** if a partner integration requires OAuth (e.g. a managed cloud version), it gets added inside that integration — never as a default credential mode for the CLI.

### Markdown memory files, not embeddings

`~/.ethos/MEMORY.md` and `~/.ethos/USER.md` are plain text. Edit them in your editor. Grep them. Diff them. Commit them if you like.

**Why:** memory you cannot read is memory you cannot trust. Embedding-based retrieval has its place, but as the default mechanism it adds an embedding model, a vector store, a similarity threshold, and a debugging surface — for the privilege of giving the agent context the user cannot audit. We picked legibility.

**When this changes:** if a personality genuinely needs semantic recall over a large corpus, that is what `MemoryProvider` is for — implement a vector-backed provider for that personality. The default stays markdown.

### Five personalities, not one super-agent

Ethos ships five built-in personalities (researcher, engineer, reviewer, coach, operator) rather than one configurable super-agent.

**Why:** an agent good at everything is good at nothing. A reviewer should not have write access; an engineer should not be told to be encouraging when a design is wrong; a researcher should not be asked to ship code. Different roles want different tools, different memory, different voice. Forcing them into one configuration vector produces blandness.

**When this changes:** never, structurally. The set of built-ins may grow, but the principle stays — personalities are atomic, not knobs.

## See also

- [What is Ethos?](what-is-ethos.md) — 90-second mental model
- [Architecture in 90 seconds](architecture-90-seconds.md) — the components behind the trade-offs
- [Why is personality the unit?](../using/explanation/what-is-a-personality.md) — the headline thesis in depth

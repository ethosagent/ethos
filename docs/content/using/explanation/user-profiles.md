---
title: "Why are user profiles keyed by userId, not by personality?"
description: "USER.md is scoped per human, not per agent role — keyed by an opaque userId derived from platform identity."
kind: explanation
audience: user
slug: user-profiles
updated: 2026-05-22
---

## Context

An agent that remembers who you are across sessions needs a place to store that knowledge. Your name, your timezone, your preferred communication style, the role you hold on the team. That knowledge is about *you*, not about which [personality](../../getting-started/glossary.md#personality) is currently active.

The obvious design is to store user facts alongside personality facts — one file per personality, containing both what the agent knows about its role and what it knows about you. Ethos rejects that design. User profiles are keyed by an opaque `userId` derived from platform identity, not by personality. Switching from `researcher` to `engineer` does not lose your name.

This page explains what a userId is, where USER.md lives, how platform identities map to userId values, and why the per-user boundary exists.

## Discussion

### What a userId is

A userId is an opaque identifier derived from platform identity. When a message arrives from Telegram, the sender's Telegram user ID is hashed to produce a stable userId. The same happens for Slack, Discord, and email. The hash is one-way and deterministic — the same sender always resolves to the same userId, but you cannot reverse-engineer the Telegram handle from the userId alone.

The opacity is deliberate. The userId is a routing key, not a display name. It tells the framework "this is the same human as last time" without encoding platform-specific details into the storage path. A userId that looked like `telegram:12345678` would leak platform assumptions into every layer that touches the user directory. An opaque hash does not.

### Where USER.md lives

```
~/.ethos/users/<userId>/USER.md
```

One file per human, not per personality. The directory is flat — each userId gets its own subdirectory under `~/.ethos/users/`, and the `USER.md` inside it is the only load-bearing file. The [memory provider](../../getting-started/glossary.md#memory-provider) reads it at `prefetch` time, injects it into the system prompt under the `## About You` heading, and writes back to it when the agent emits a `MemoryUpdate` with `store: 'user'`.

The file is plain markdown. You can read it with `cat`, edit it with your text editor, commit it to a backup, or delete it to start fresh. The agent's view of who you are is exactly what the file says — no hidden state, no embedding, no database row.

### Why per-user, not per-personality

USER.md describes the human. Name, role, preferences, timezone, communication style. These facts do not change when you switch from the reviewer to the engineer. The reviewer personality controls what the agent *does*; the user profile controls what the agent *knows about you*.

If USER.md were per-personality, switching personalities would forget your name. The reviewer would know you prefer direct feedback; the engineer would not. You would re-introduce yourself every time you changed hats. That is the behaviour of an agent with amnesia about the person it is talking to, and it is exactly what the per-user boundary prevents.

The split is clean:

| Fact | Where it lives | Why |
|---|---|---|
| Your name and role | `USER.md` (per user) | Person fact — does not change with personality |
| Your timezone | `USER.md` (per user) | Person fact |
| Your communication preferences | `USER.md` (per user) | Person fact |
| What the agent worked on last session | `MEMORY.md` (per personality) | Role fact — the reviewer's memory is not the engineer's |
| Decisions made during a code review | `MEMORY.md` (per personality) | Role fact |

The personality boundary controls what the agent can *do*. The user profile boundary controls what the agent knows about *you*. They are orthogonal, and merging them conflates two things that change at different rates and for different reasons.

### Platform identity mapping

Each platform adapter maps its sender identity to a userId. Telegram maps the sender's numeric user ID. Slack maps the `U…` user ID. Discord maps the snowflake. Email maps the sender address. The mapping is stored at:

```
~/.ethos/users/identity-map.json
```

The identity map is a JSON file that associates platform-specific sender identifiers with userId values. Its structure is straightforward:

```json
{
  "telegram:123456789": "a1b2c3d4e5f6",
  "slack:U0123ABCDEF": "a1b2c3d4e5f6",
  "discord:987654321012345678": "g7h8i9j0k1l2",
  "email:alice@example.com": "a1b2c3d4e5f6"
}
```

Multiple platform identities can map to the same userId. In the example above, the Telegram user, the Slack user, and the email address all resolve to the same userId (`a1b2c3d4e5f6`) because they belong to the same person. That person has one USER.md, regardless of which channel they message from.

When a new sender appears for the first time, the adapter generates a fresh userId from the platform identity hash. If the operator later discovers that two userIds are actually the same person (e.g., the same human using Telegram and Slack), the operator edits `identity-map.json` to point both platform keys at one userId and merges the two USER.md files manually.

### The admin identity map view

In multi-user [gateway](../../getting-started/glossary.md#gateway) deployments, the identity map grows. Ten users across three platforms is thirty potential entries. Knowing which userId maps to which platform handle matters when:

- A user reports inconsistent behaviour and you need to find their USER.md.
- Two platform accounts need linking because they belong to the same person.
- A user leaves the team and their profile should be archived or deleted.

The web dashboard (`ethos serve --web`) exposes an identity map view under the Users section. It lists all known userIds with their associated platform handles, the path to each USER.md, and the file's last-modified timestamp. The same information is available from the CLI:

```bash
ethos users list
```

This command prints a table of userId values, their platform associations, and the path to each USER.md. It reads directly from `identity-map.json` and the `~/.ethos/users/` directory — no database, no cache.

### Linking platform identities

When the same person uses multiple platforms, the operator links their identities by editing `identity-map.json`. The process:

1. Identify the two (or more) platform keys that belong to the same person.
2. Pick one userId to keep (usually the one with the richer USER.md).
3. Update `identity-map.json` so all platform keys point to the chosen userId.
4. If the other userId has a USER.md with useful content, merge it manually into the kept USER.md.
5. Delete the orphaned `~/.ethos/users/<old-userId>/` directory.

There is no automated merge. USER.md is a small, human-readable file. A manual merge takes thirty seconds and avoids the complexity of conflict resolution for a file that rarely exceeds a page of text.

### CLI single-user case

In CLI mode, there is one implicit user. No platform adapter is involved — the human is sitting at the terminal. The userId is derived from the machine identity (a hash of the hostname and OS user), so the same developer on the same machine always gets the same USER.md.

This means `ethos chat` on your laptop produces a single USER.md at `~/.ethos/users/<machine-hash>/USER.md`. You never interact with the identity map in single-user mode. It exists, but it contains one entry and you do not need to think about it.

The single-user case is the common case for local development. The identity map and multi-platform linking become relevant only when the agent is deployed as a channel bot serving multiple humans.

### What USER.md contains

The agent writes USER.md based on what it learns about you during conversations. Typical content:

```markdown
## Name
Alice Chen

## Role
Senior backend engineer, payments team.

## Preferences
- Prefers direct, concise answers.
- Wants code examples in TypeScript.
- Timezone: America/Los_Angeles (Pacific).

## Context
- Working on migration from Stripe v3 to v4.
- Uses VS Code with Vim keybindings.
```

The content is free-form markdown. The agent decides what to write based on the conversation; the [memory provider](../../getting-started/glossary.md#memory-provider) persists it via `sync()`. There is no schema for USER.md — it is whatever the agent finds useful to remember about you.

You can edit it yourself. Add a line, remove a line, correct a fact. The agent reads it fresh on the next turn via `prefetch()`. Your edit is the agent's new ground truth.

### What USER.md does not contain

USER.md is not a credentials store. It should not contain API keys, passwords, tokens, or secrets. The file lives on disk as plain text — the same threat model as your `.bashrc`. The agent is instructed not to write secrets to memory, and the [injection guard](../../../security/controls.md#prompt-injection-defenses) scans memory content on write, but the primary defense is not writing secrets there in the first place.

USER.md is also not a preferences file for the agent's behaviour. "Use Opus for my turns" is a personality config concern (`model:` in `config.yaml`), not a user profile concern. "I prefer concise answers" is a legitimate user fact; "always use extended thinking" is not.

## Trade-offs

**You give up per-personality user profiles.** The reviewer and the engineer see the same USER.md. If you want the reviewer to know different things about you than the engineer, that distinction belongs in MEMORY.md (per-personality), not USER.md. The reviewer's MEMORY.md can note "Alice prefers findings grouped by severity"; the engineer's MEMORY.md can note "Alice prefers small PRs". USER.md stays common to both.

**The userId is opaque.** You cannot look at a userId and know which Telegram user it belongs to without consulting the identity map at `~/.ethos/users/identity-map.json`. This is the cost of not encoding platform assumptions into the storage path. The admin identity map view and `ethos users list` are the tools for resolving userId to platform handle.

**Linking requires manual intervention.** When the same person uses Telegram and Slack, the operator must edit `identity-map.json` to link them. There is no automatic cross-platform identity resolution. Automatic linking would require trusting platform-provided identity signals (display name, email) that are unreliable and spoofable. Manual linking is slower but correct.

**A poisoned USER.md crosses personality boundaries.** Because USER.md is shared across personalities, a malicious or incorrect entry affects every personality the user interacts with. If someone injects "ignore previous instructions" into a USER.md, it re-enters the system prompt on every turn, under every personality. The [injection guard](../../../security/controls.md#prompt-injection-defenses) scans memory on write and on read as a backstop, but the cross-personality surface is real and is why USER.md is treated as a higher-risk memory surface than per-personality MEMORY.md.

## See also

- [Why MEMORY.md and USER.md, not a vector store?](memory-model.md) — the memory model that USER.md is part of
- [Why is personality the unit?](what-is-a-personality.md) — how the personality boundary interacts with user profiles
- [Audit user identity mappings](../how-to/audit-user-identity.md) — inspect and manage the identity map
- [Personality config reference](../reference/personality-yaml.md) — the `memoryScope` field and how it affects memory routing
- [Security controls](../../../security/controls.md) — injection scanning on memory content

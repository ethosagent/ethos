---
title: "Why are user profiles keyed by userId, not by personality?"
description: "How the gateway resolves each sender to an opaque userId, where that person's USER.md lives, and when a turn reads it instead of a personality's copy."
kind: explanation
audience: user
slug: user-profiles
updated: 2026-09-13
---

## Context

An agent that remembers who you are across sessions needs a place to store that knowledge. Your name, your timezone, your preferred communication style, the role you hold on the team. That knowledge is about *you*, not about which [personality](../../getting-started/glossary.md#personality) (a directory of files that decides the agent's tools, memory, and model) is currently active.

The default stores user facts alongside personality facts: every personality has its own `USER.md` at `~/.ethos/personalities/<id>/USER.md`, and under `ethos chat` that is the only profile there is. A channel bot serves many people, though, and one file per personality would pour all of them into the same page. So the [gateway](../../getting-started/glossary.md#gateway) (the long-running process that holds the channel adapters) keys a second profile by an opaque `userId` it resolves from the sender's platform identity. A turn that carries a `userId` reads that person's `USER.md`, and switching from `researcher` to `engineer` does not lose their name.

This page explains what a userId is, where that USER.md lives, which turns read it, how platform identities map to userId values, and why the per-user boundary exists.

## Discussion

### What a userId is

A userId is an opaque identifier the gateway mints the first time it sees a sender. `IdentityMap.resolve` (`packages/wiring/src/identity-map.ts`) looks the sender up by platform and the platform's own user id — the Telegram numeric id, the Slack `U…` id. When there is no entry, it generates a random 12-character hex id and records it. Later messages from the same account find that entry and get the same userId.

The opacity is deliberate. The userId is a routing key, not a display name, and it is random rather than derived from the handle, so it reveals nothing about the account without the map. A userId that looked like `telegram:12345678` would put platform assumptions into every storage path that touches it.

### Where USER.md lives

```
~/.ethos/users/<userId>/USER.md
```

One file per resolved person, each in its own subdirectory under `~/.ethos/users/`. At the start of a turn that carries a userId, context assembly reads `USER.md` from the `user:<userId>` scope. When that file is non-empty it goes into the system prompt under `## About You`, in place of the personality's own copy (`packages/core/src/agent-loop/stages/context-assembly.ts`). The `memory_write` tool writes `store: 'user'` to the same scope (`userScopeId`).

The file is plain markdown. You can read it with `cat`, edit it with your text editor, commit it to a backup, or delete it to start fresh. The agent's view of who you are is exactly what the file says — no hidden state, no embedding, no database row.

### Which turns carry a userId

| Surface | userId on the turn | `USER.md` in the prompt |
|---|---|---|
| Channel bots under `ethos gateway start` or `ethos boot` | Resolved for every sender through the identity map | `users/<userId>/USER.md`; the personality's copy when that file is empty |
| Web chat | Only when the request passes one | Same rule |
| `ethos chat` | None | `personalities/<id>/USER.md` |
| A phone call answered by the receptionist | None | The receptionist personality's own copy |

`ethos chat` never consults the identity map. Switching personality there switches profile: what the researcher wrote about you is not in the engineer's prompt. To carry a fact across, copy the line into the other personality's `USER.md`.

### Why per-user, not per-personality

On a gateway turn, USER.md describes the human. Name, role, preferences, timezone, communication style. These facts do not change when you switch from the reviewer to the engineer. The reviewer personality controls what the agent *does*; the user profile controls what the agent *knows about you*.

If the gateway's profile were per-personality, switching personalities would forget your name. The reviewer would know you prefer direct feedback; the engineer would not. You would re-introduce yourself every time you changed hats. That is the behaviour of an agent with amnesia about the person it is talking to, and it is exactly what the per-user boundary prevents.

The split on a gateway turn is clean:

| Fact | Where it lives | Why |
|---|---|---|
| Your name and role | `users/<userId>/USER.md` | Person fact — does not change with personality |
| Your timezone | `users/<userId>/USER.md` | Person fact |
| Your communication preferences | `users/<userId>/USER.md` | Person fact |
| What the agent worked on last session | `personalities/<id>/MEMORY.md` | Role fact — the reviewer's memory is not the engineer's |
| Decisions made during a code review | `personalities/<id>/MEMORY.md` | Role fact |

The personality boundary controls what the agent can *do*. The user profile boundary controls what the agent knows about *you*. They are orthogonal, and merging them conflates two things that change at different rates and for different reasons.

### Platform identity mapping

The gateway builds one `IdentityMap` per process over `~/.ethos/users/identity-map.json` (`apps/ethos/src/commands/gateway.ts`, `boot.ts`). The file is a JSON array with one entry per platform account:

```json
[
  {
    "platform": "telegram",
    "platformUserId": "123456789",
    "userId": "a1b2c3d4e5f6",
    "displayLabel": "alice",
    "firstSeenAt": "2026-09-01T09:14:02.118Z"
  },
  {
    "platform": "slack",
    "platformUserId": "U0123ABCDEF",
    "userId": "a1b2c3d4e5f6",
    "displayLabel": "alice",
    "firstSeenAt": "2026-09-03T16:40:55.902Z"
  },
  {
    "platform": "discord",
    "platformUserId": "987654321012345678",
    "userId": "0f9e8d7c6b5a",
    "displayLabel": "bob",
    "firstSeenAt": "2026-09-05T11:02:31.447Z"
  }
]
```

Several entries can carry the same userId. Above, the Telegram and Slack accounts resolve to `a1b2c3d4e5f6` because an operator pointed both at one person, who then has one USER.md whichever channel they write from.

A new sender always gets a fresh random userId. Nothing links accounts automatically: when two userIds turn out to be one person, the operator edits `identity-map.json` so both entries carry one userId and merges the two USER.md files by hand. The running process caches the map after its first read, so an edit takes effect when the gateway restarts.

### Where to see the map

In multi-user gateway deployments, the identity map grows. Ten users across three platforms is thirty potential entries. Knowing which userId maps to which platform handle matters when:

- A user reports inconsistent behaviour and you need to find their USER.md.
- Two platform accounts need linking because they belong to the same person.
- A user leaves the team and their profile should be archived or deleted.

The web Memory page reads the map. With the `USER.md` store selected, its **User** picker lists every entry by display label (`memory.listUsers`); **Shared (personality default)** is the personality's own copy. Picking a person reads and writes `users/<userId>/USER.md`. No CLI command lists the map — read `~/.ethos/users/identity-map.json` directly.

### Linking platform identities

When the same person uses multiple platforms, the operator links their identities by editing `identity-map.json`. The process:

1. Identify the two (or more) entries that belong to the same person.
2. Pick one userId to keep (usually the one with the richer USER.md).
3. Set that userId on every entry for the person.
4. If the other userId has a USER.md with useful content, merge it manually into the kept USER.md.
5. Delete the orphaned `~/.ethos/users/<old-userId>/` directory, then restart the gateway.

There is no automated merge. USER.md is a small, human-readable file. A manual merge takes thirty seconds and avoids the complexity of conflict resolution for a file that rarely exceeds a page of text.

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
- Working on a payment-provider API migration.
- Uses VS Code with Vim keybindings.
```

The content is free-form markdown. The agent decides what to write based on the conversation; the [memory provider](../../getting-started/glossary.md#memory-provider) persists it via `sync()`. There is no schema for USER.md — it is whatever the agent finds useful to remember about you.

You can edit it yourself. Add a line, remove a line, correct a fact. The agent reads it fresh at the start of the next turn. Your edit is the agent's new ground truth.

### What USER.md does not contain

USER.md is not a credentials store. It should not contain API keys, passwords, tokens, or secrets. The file lives on disk as plain text — the same threat model as your `.bashrc`. The agent is instructed not to write secrets to memory, and the [injection guard](../../security/controls.md#prompt-injection-defenses) scans memory content on write, but the primary defense is not writing secrets there in the first place.

USER.md is also not a preferences file for the agent's behaviour. "Use Opus for my turns" is a model-routing concern (the personality's `model`, or `modelRouting.<id>` in `~/.ethos/config.yaml`), not a user profile concern. "I prefer concise answers" is a legitimate user fact; "always use extended thinking" is not.

## Trade-offs

**You give up per-personality user profiles on gateway turns.** For one resolved sender, the reviewer and the engineer see the same `users/<userId>/USER.md`. If you want the reviewer to know different things about you than the engineer, that distinction belongs in MEMORY.md (per-personality), not USER.md. The reviewer's MEMORY.md can note "Alice prefers findings grouped by severity"; the engineer's MEMORY.md can note "Alice prefers small PRs". USER.md stays common to both.

**Chat and gateway profiles are separate files.** What a personality learned about you in `ethos chat` lives in its `personalities/<id>/USER.md`; a gateway turn reads your `users/<userId>/USER.md` first. Nothing copies one into the other.

**The userId is opaque.** You cannot look at a userId and know which Telegram user it belongs to without consulting the identity map at `~/.ethos/users/identity-map.json`. This is the cost of not encoding platform assumptions into the storage path. The web Memory page's **User** picker is the tool for resolving a userId to a display label.

**Linking requires manual intervention.** When the same person uses Telegram and Slack, the operator must edit `identity-map.json` to link them. There is no automatic cross-platform identity resolution. Automatic linking would require trusting platform-provided identity signals (display name, email) that are unreliable and spoofable. Manual linking is slower but correct.

**A poisoned USER.md crosses personality boundaries.** A per-user USER.md is read by every personality that person reaches through the gateway, so a malicious or incorrect entry affects all of them. If someone injects "ignore previous instructions" into a USER.md, it re-enters the system prompt on every such turn, under every personality. The [injection guard](../../security/controls.md#prompt-injection-defenses) scans memory on write and on read as a backstop, but the cross-personality surface is real and is why USER.md is treated as a higher-risk memory surface than per-personality MEMORY.md.

## See also

- [Why MEMORY.md and USER.md, not a vector store?](memory-model.md) — the memory model that USER.md is part of
- [Why is personality the unit?](what-is-a-personality.md) — how the personality boundary interacts with user profiles
- [Audit user identity mappings](../how-to/audit-user-identity.md) — inspect and manage the identity map
- [Personality config reference](../reference/personality-yaml.md) — every field a personality's `config.yaml` accepts
- [Security controls](../../security/controls.md) — injection scanning on memory content

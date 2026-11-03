---
title: Peer two Ethos agents over A2A
description: Enable A2A on two Ethos installs and expose a skill on one; later parts exchange fingerprints and complete a message/send between them.
kind: how-to
audience: user
slug: peer-two-ethos-agents
time: 30 min
updated: 2026-11-03
---

Ethos agents can call each other directly — one [personality](../../getting-started/glossary.md#personality) asks another to do something and gets a reply back, without a human relaying the message. The wire protocol is A2A: an Ethos-specific JSON-RPC surface that borrows Google A2A's vocabulary (`message/send`, a well-known card path) but is not a conformant implementation of the public spec — a spec client cannot talk to it today. What it does carry, unchanged from the framework's original design, is the trust model: a human anchors each peering by comparing a cryptographic fingerprint out of band, and nothing is reachable until that happens twice — once per direction.

## Task

Peer two Ethos installs so one agent can call a [skill](../../getting-started/glossary.md#skill) on the other and get a reply, with both sides verified and both sides auditable.

## Result

Agent A sends a `message/send` naming a skill on Agent B; Agent B's reply comes back to A; both sides have a signed record of the exchange in their own audit trail.

## Prereqs

- Two working Ethos installs, each already through `ethos setup` with an LLM provider configured. This page runs both on one machine as two isolated instances (`ETHOS_STATE_DIR` points each `ethos` invocation at its own `~/.ethos`-shaped directory) — nothing here requires that; two real machines work the same way, just without the environment variable.
- Two free local ports for `ethos serve` (this page uses `3000` and `3001`).

Open two terminals. In the first:

```bash
export ETHOS_STATE_DIR=/tmp/ethos-a
```

In the second:

```bash
export ETHOS_STATE_DIR=/tmp/ethos-b
```

Every command below is labeled **Terminal A** or **Terminal B**. Run `ethos setup` once in each terminal first if that state directory is new.

## Parts

| Part | Covers |
|---|---|
| This page | Steps 1-4: enable A2A, see the zero-skills warning, expose a skill on Agent B |
| [Exchange fingerprints and add peers](peer-two-ethos-agents/peer-identities.md) | Steps 5-6: mint each agent's identity, add and enable each peer |
| [Send a message and read the audit trail](peer-two-ethos-agents/send-and-audit.md) | Steps 7-10: give the caller `a2a_send`, start both servers, send, read the audit log |

## 1. Enable A2A on both agents

**Terminal A** and **Terminal B**:

```bash
ethos a2a enable
```

```
✓ A2A enabled. (Live in the web UI immediately; a running ethos serve/gateway picks it up on next start.)
```

If `webBaseUrl` is not set in `~/.ethos/config.yaml`, `a2a enable` also warns that cards will advertise the wrong port (`:8787`, the identity provider's fallback) instead of wherever you actually run `ethos serve`. Set it explicitly so peers get a reachable URL — there is no CLI setter for this key, so append the line directly:

**Terminal A**:

```bash
echo 'webBaseUrl: http://localhost:3000' >> /tmp/ethos-a/config.yaml
```

**Terminal B**:

```bash
echo 'webBaseUrl: http://localhost:3001' >> /tmp/ethos-b/config.yaml
```

Both agents run on `localhost`, and `ethos a2a peer add` refuses a loopback or private-network card URL unless the operator opts in. Opt both agents in:

```bash
echo 'a2a.peering.allowPrivateUrls: true' >> /tmp/ethos-a/config.yaml
echo 'a2a.peering.allowPrivateUrls: true' >> /tmp/ethos-b/config.yaml
```

Leave it unset for peers on the public internet. Cloud-metadata addresses stay refused with it set.

## 2. See the zero-skills warning

A2A is private by default: no built-in personality exposes anything to peers, so a fresh install's card advertises zero skills and every inbound `message/send` is rejected. **Terminal B**:

```bash
ethos a2a status
```

```
✓ a2a           enabled
✓ webBaseUrl    http://localhost:3001
✓ peers         0 configured for engineer
! A2A is enabled but personality "engineer" exposes no skills to peers — every inbound request will be rejected with FORBIDDEN_SCOPE. Set `ethos.exposeToAgents: true` in a skill's SKILL.md frontmatter, under this personality's own skills/ directory, to expose it.
```

(`engineer` here is whatever `~/.ethos/config.yaml`'s `personality:` field resolves to on your install — the warning names it explicitly.) This is expected and correct, not a bug: nothing is reachable until an operator opts a skill in. The same warning prints at `ethos serve` boot when A2A is enabled and the active personality exposes nothing.

## 3. Expose a skill on Agent B

Create a personality on Agent B with its own `skills/` directory — built-in personalities ship with none, and stay that way on purpose. **Terminal B**:

```bash
ethos personality fork engineer echo-bot
mkdir -p /tmp/ethos-b/personalities/echo-bot/skills/echo-status
```

Write the skill. This is the shape of the copyable template that ships at `examples/skills/a2a-expose-template/SKILL.md`, reproduced here with `exposeToAgents` already flipped on:

```bash
cat > /tmp/ethos-b/personalities/echo-bot/skills/echo-status/SKILL.md <<'EOF'
---
name: echo-status
description: Reply with this personality's current status when a trusted A2A peer asks for it.
version: 1.0.0
author: demo
tags: [a2a, template, example]
required_tools: []

ethos:
  exposeToAgents: true
---

# Echo status

Use this skill when an authenticated A2A peer names `echo-status` in
`params.skill` and asks about this agent's current status. Reply with a
short, plain-language status update. Do not reach for any tool — this
skill declares no `required_tools`, so the runtime narrows the turn to an
empty toolset.
EOF
```

Two frontmatter fields matter, and both are read straight from this file at request time, never cached in the signed card:

- `ethos.exposeToAgents: true` — without it the skill exists locally but stays off the trusted-peer card, exactly like every skill on a built-in personality.
- `required_tools: []` — an explicit, intentional grant of *no* tools. A skill with this key **absent** (not merely empty) refuses every inbound turn rather than falling back to the personality's full toolset — that fail-closed behavior is what makes tool-scoping meaningful once a peer is trusted.

## 4. Confirm the warning clears

**Terminal B**:

```bash
ethos a2a status --personality echo-bot
```

```
✓ a2a           enabled
✓ webBaseUrl    http://localhost:3001
✓ peers         0 configured for echo-bot
```

No warning line — `echo-bot`'s trusted-peer card now lists one skill.

Continue with [Exchange fingerprints and add peers](peer-two-ethos-agents/peer-identities.md).

## Verify

- `ethos a2a status --personality echo-bot` on B prints no warning.

## Troubleshoot

| Symptom | Likely cause | Fix |
|---|---|---|
| `FORBIDDEN_SCOPE` (JSON-RPC error `-32003`) | The named skill isn't on the receiving personality's trusted-peer card — either `exposeToAgents` is unset/false, or the skill name doesn't match. | Re-check step 3's frontmatter and re-run `ethos a2a status --personality <id>` to confirm the warning is gone. |
| `Card URL refused` on `peer add` | The URL is on `localhost` or a private network, and `a2a.peering.allowPrivateUrls` is not set in that install's `config.yaml`. | Add `a2a.peering.allowPrivateUrls: true`, as in step 1. |
| `A2A_SKILL_TOOLS_UNDECLARED` | The named skill's SKILL.md has no `required_tools` key at all (not even `[]`) — the runtime fails the turn closed rather than granting the full toolset. | Add `required_tools: []` (or the real list) to the skill's frontmatter, as in step 3. |

## See also

- [Add a skill](../../building/how-to/add-a-skill.md) — `required_tools` and `fallback_unknown`, including the A2A-specific fail-closed exception this page relies on.
- [Why does AgentCard need a drift gate?](../../building/explanation/agent-card-governance.md) — why the signed card's shape can't casually change once peers have anchored a fingerprint to it.
- [Serve Ethos as an OpenAI-compatible backend](../../building/how-to/openai-server-chat.md) — the `/v1/chat/completions` surface this page used to trigger a turn.

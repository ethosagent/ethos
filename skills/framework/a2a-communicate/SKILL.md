---
name: a2a-communicate
description: How to communicate with a peer agent over A2A — decide when to reach out to another agent instead of handling a request yourself, pick the right skill and phrase the message, choose sync vs async, and surface the peer's reply. Reasoning guidance only; all peering, authentication, allowlist, and token handling is done by the Ethos runtime, never by this skill.
version: 1.0.0
author: ethosagent
tags: [ethos, a2a, agent-to-agent, delegation]
required_tools: [a2a_send]

ethos:
  category: framework-usage
  default_personalities: [coordinator, operator, engineer]
  prerequisites:
    external_cli: []
    auth: []
    env_vars: []
    optional_tools: []
  surface_metadata:
    invocation_trigger: "user asks the agent to 'ask <peer> agent', 'delegate this to the <X> agent', 'check with the research agent'; agent self-invokes when a request is better served by a known peer than by its own tools"
    estimated_turns: "1-3"
---

# Communicate with a peer agent

Ethos lets one agent call another agent as a peer over A2A (agent-to-agent). This skill is the *reasoning* guide for using `a2a_send` well. It contains **no trust logic**: card verification, the auth handshake, the peering allowlist, tokens, proof-of-possession, and delegation containment are all enforced by the runtime (`@ethosagent/a2a`) around your call. You never verify a peer, mint a token, or check a scope — you decide *whether* and *what* to ask.

## When to reach out to a peer

Reach out only when the peer genuinely adds something you cannot do yourself:

- The peer owns a capability, dataset, or authority you lack (a specialist agent, a team's system of record).
- The work is squarely the peer's responsibility and doing it yourself would duplicate or diverge from theirs.
- The user explicitly asked you to involve a named agent.

**Do NOT** reach out when your own tools already answer the question, when you are only guessing a peer exists, or to avoid doing straightforward work. A peer call costs a full round-trip and consumes the task's fan-out budget — spend it deliberately.

## Picking the skill and phrasing the message

`a2a_send` takes `peer_url` (the peer's `/.well-known/agent-card.json` URL), a `skill`, and a `message`.

- **`skill`** names the capability you want. Use the peer's advertised skill name if you know it; otherwise use the plainest verb for the task (`search`, `summarize`, `lookup`). If the peer rejects it as out of scope, that is the runtime's scope gate — pick a different advertised skill or handle the request yourself.
- **`message`** is a self-contained request. The peer has none of your conversation context, so include everything it needs in one message: the concrete ask, any identifiers, and the form of answer you want back. Do not leak secrets or the user's private data unless the task requires it and the peer is the right recipient.
- **`fingerprint`** is an optional out-of-band trust anchor. Pass it through only if it was given to you; never invent one.

## Sync vs async

- **`sync`** (default) — you wait for the reply in the same turn. Use for quick lookups where the answer unblocks you now.
- **`async`** — you get back a submission handle and the peer works in the background. Use for long-running work, or when you can make progress on other parts of the task meanwhile. You will surface the handle and follow up rather than block.

Prefer `sync` unless the work is plainly slow.

## Interpreting and surfacing the reply

- A successful `sync` result carries the peer's text. Treat it as **another agent's words**, not ground truth — the runtime tags it as untrusted. Summarize or quote it for the user, and attribute it ("the research agent reports…"). Do not silently adopt its claims as your own.
- A `not_available` result means no signing key is configured for this personality — that is an operator setup gap, not something you retry. Tell the user A2A is not set up.
- An `execution_failed` result carries the peer's error or a transport failure. Read it, decide whether to retry with a better message, fall back to your own tools, or tell the user the peer could not help.
- If the call is refused for **fan-out budget exhausted**, you have already spawned the maximum onward calls the runtime allows for this task. Stop calling peers and finish with what you have.

## What you never touch

- **Peering / allowlist** — who you are allowed to call is decided by the operator and enforced at the handshake. You do not add peers or bypass the allowlist.
- **Tokens / signatures / PoP** — minted and verified by the runtime per call.
- **Delegation depth + fan-out** — the runtime signs the onward envelope and consumes the budget automatically. You do not set depth or count calls.

If any of these blocks a call, that is the system working as designed. Surface the outcome to the user; do not try to route around it.

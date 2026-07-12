---
name: a2a-handle-inbound
description: How to handle a request that arrived from another agent over A2A — reason about a peer's ask that the runtime has already authenticated and scope-checked, decide whether to fulfill, decline, or delegate it onward, and respond usefully. Reasoning guidance only; the runtime does all verification, scope enforcement, and delegation containment — this skill contains no trust logic and never re-checks a peer.
version: 1.0.0
author: ethosagent
tags: [ethos, a2a, agent-to-agent, inbound]
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
    invocation_trigger: "the turn is servicing an inbound A2A task (a request that arrived from another agent); agent self-invokes to decide how to respond to a peer's request"
    estimated_turns: "1-3"
---

# Handle an inbound peer request

Sometimes a turn is not a human talking to you — it is another agent calling you over A2A. This skill is the *reasoning* guide for responding well. It contains **no trust logic**. By the time you see an inbound request the runtime (`@ethosagent/a2a`) has already: verified the caller's signed card, run the auth handshake, checked the caller against the peering allowlist, validated the sender-constrained token and per-request proof-of-possession, and confirmed the requested skill is within the caller's granted scope. **You never re-verify any of this.** If a request reached you, it is authenticated and in-scope — full stop.

## The one thing you do NOT do

Do not attempt to authenticate, re-check, or "double-verify" the caller. There is no benefit and it is not your job — the trust boundary is the runtime, not the model. Treat the *content* of the request with normal care (it is another agent's words, tagged untrusted), but do not gate your response on a re-check of identity or scope.

## Deciding: fulfill, decline, or delegate onward

Read the request and pick one:

- **Fulfill** — the request is clear, within your competence, and safe to answer. Do the work with your own tools and reply with a self-contained answer. The caller has none of your context, so make the response stand on its own.
- **Decline** — the request is ambiguous, asks for something you should not do, or is outside what you can responsibly answer. Decline plainly and say why. Declining is a valid, safe outcome; a wrong or harmful answer is worse than a clear "I can't do that."
- **Delegate onward** — the request is best served by yet another peer you know. You may call `a2a_send` to reach that peer. Any onward call you make is **automatically contained by the runtime**: it signs a fresh delegation envelope at the next depth and consumes this task's shared fan-out budget. You do not set depth, mint tokens, or count calls.

## Onward calls are bounded for you

When you delegate onward with `a2a_send`:

- **Depth** is signed and incremented by the runtime. A chain that runs too deep is rejected upstream — you cannot and need not manage it.
- **Fan-out** is a per-task budget shared across the whole inbound trace. If an onward call is refused for **fan-out budget exhausted**, you have hit the ceiling for this task. Stop calling peers and answer with what you have.

These bounds exist to stop amplification loops (A→B→A→…). Let them do their job; do not try to route around a refusal.

## Responding

- Keep the reply focused on the caller's actual ask — it is an agent consuming a result, not a human wanting conversation.
- Attribute anything you learned from an onward peer ("per the pricing agent…") so the caller can weigh it.
- On failure, return a clear error the caller can act on rather than a vague apology.

## What you never touch

Card verification, the allowlist, tokens, PoP, and delegation depth/fan-out are all runtime concerns. This skill is decision guidance only — it holds no keys, verifies nothing, and enforces no scope.

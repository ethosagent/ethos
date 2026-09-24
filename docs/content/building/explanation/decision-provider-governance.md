---
title: "Why is a decision provider a new contract type?"
description: "RFC for the Structural amendment adding DecisionProvider: a typed-verdict contract beside LLMProvider, with a one-method drift gate."
kind: explanation
audience: developer
slug: decision-provider-governance
updated: 2026-09-24
---

## Context

Some of Ethos's safety checks ask a yes-or-no question, not for prose. Is
this tool result trying to instruct the agent? Should this risky tool call
be approved, denied or sent to a human? Today each of those questions goes
to an [LLM provider](../../getting-started/glossary.md#llm-provider) (the
component that streams text from a model), which writes a paragraph that
Ethos then parses back into a verdict. A decision provider answers the
question directly: a typed value with a probability, from a service built to
return exactly that, such as TypeSafe's Jev.

This page is the RFC for adding that capability as a contract.
ARCHITECTURE.md §VI classifies "adding a new contract type" as a
**Structural** amendment: it needs unanimous maintainer agreement, an RFC, a
validator update in the same PR, and a migration note. The plan behind it is
`plan/phases/decision-provider-jev.md` (milestone M0, decisions D4 and D5).

**Status: proposed.** No contract code merges until the maintainers approve
this amendment unanimously. Milestone M1 does not wait for it, because it
implements the existing `InjectionClassifier` contract
(`packages/types/src/safety.ts`) and adds no contract type.

## Discussion

### What the amendment adds

The contract is `DecisionProvider` in `packages/types/src/decision.ts`,
which lands in milestone M2 with zero imports, like every other contract
module. Its surface is one method and two read-only fields:

```ts
// illustration — the shape M2 adds to packages/types/src/decision.ts
export interface DecisionProvider {
  readonly name: string;
  readonly calibrated: boolean;
  decide(request: DecisionRequest): Promise<DecisionResult>;
}
```

A request carries the state and a map of named questions. Each question is
`boolean`, `choice` or `score`. A result is either
`{ ok: true, answers, model, usage }` or `{ ok: false, code, message }`,
where `code` is one of nine values: `auth`, `invalid`, `rate_limited`,
`overloaded`, `timeout`, `aborted`, `malformed`, `too_large`,
`unavailable`. `model` is the model id the provider reports back, not the
one requested, so a silent vendor upgrade shows up in the record.

The amendment changes ARCHITECTURE.md in three places:

| Section | Change |
|---|---|
| §IV | A "Decision Provider Authoring" pattern: a thin adapter over a transport function, mirroring "LLM Provider Authoring". |
| §VII | A roster row for the Decision provider contract, owned by any two repository maintainers, gated by `decision-provider-method-count`. |
| §IX | A `frozen_schemas.decision_provider` entry: `frozen_method_count: 1`, `frozen_methods: [decide]`. |

The drift gate is `packages/types/src/__tests__/decision-provider-method-count.test.ts`.
It lands in M2 with the type, the same way `pause-lifecycle-method-count.test.ts`
landed with `PauseLifecycle`. It counts the methods on `DecisionProvider`
and cross-checks them against the §IX manifest. A second method then fails
on both halves: the source and the manifest.

### Why not an LLM provider, a model role, or a tool

**Not an LLM provider.** `LLMProvider.complete()` must return
`AsyncIterable<CompletionChunk>` (`packages/types/src/llm.ts`). A decision
service generates no text. Wrapping its verdict in a fake stream would lie
to every consumer of that contract.

**Not a model role.** The roles `trivial`, `default`, `deep` and `dreaming`
(`MODEL_ROLE_NAMES`, `packages/types/src/model-registry.ts`) each answer
"which model writes this turn". A decision provider writes nothing, so a
fifth role would answer a different question. The roles and their drift
gate are untouched.

**Not a general tool.** A tool that asks the decision service makes the
model spend a full round trip to reach a verdict that takes about 100 ms,
then hands the typed answer back to the model as a string. The typed
guarantee is gone the moment it becomes text. Decisions are made by code at
a call site, which also declares what happens when the provider fails.

A sibling contract is the only placement that keeps the verdict typed from
the provider to the code that acts on it.

### Why one method, and errors as data

One method means one drift gate with nothing to interpret. A contract that
grows a `decideBatch` or a `health` method without review is the failure
this roster exists to catch.

Errors are data because each call site has a declared fail direction. The
injection check falls back to the LLM classifier, the approver falls back to
`ask`, and the tier router falls back to `default`. A site branches on `ok`
and never wraps `decide` in `try`. A thrown exception would make the fail
direction whatever the nearest `catch` happened to do.

### What bounds a decision's authority

ARCHITECTURE.md Law 11 says a module outside the security kernel must not be
able to weaken a guarantee the kernel enforces. A decision provider is an
extension that calls a third party, so it must never be the thing that
decides whether a guarantee holds. Each bound is enforced outside the
provider:

| Guarantee | Enforcer |
|---|---|
| A classifier can add an injection flag but never clear a Tier-1 pattern hit. | `handleUntrustedResult` in `packages/core/src/agent-loop/result-defense.ts`: `containsInstructions = tier1Hit \|\| (verdict?.containsInstructions ?? false)`. Exists today. |
| An answer is acted on only at or above the site's confidence threshold; shadow mode records without acting; a failure takes today's path. | `runDecisionSite` in `packages/wiring/src/decision-site.ts` (Tier 0 wiring). Lands in M1. |
| State is redacted before it leaves the machine. | `runDecisionSite`, using `@ethosagent/safety-redact`. Lands in M1. |
| An approver timeout or error yields `ask`. | `packages/wiring/src/smart-approver.ts` (Tier 0 wiring). Exists today; M4 adds the decision path inside it. |
| A failing provider only loses influence. | The breaker in `extensions/decision-typesafe/`: while open, `decide` returns `unavailable` without a network call. Lands in M1. |

`extensions/decision-typesafe/` is Tier 2, like every other extension that
calls a third party. M1 adds its tier entry to `.architecture-state.yaml`
and adds `decision-site.ts` to wiring's `kernel_paths`.

### What the amendment does not change

There is no §II or §IX layer edit. The new extension joins the `extensions`
layer through the existing `extensions/*` glob in `.architecture-state.yaml`.
The contract sits in `packages/types`, the provider in `extensions`, and all
call-site composition in `packages/wiring`. Apps never import the provider
(Law 5).

`PersonalityConfig` does not change. Whether data goes to a third-party
decision service is a setting two deployments of the same
[personality](../../getting-started/glossary.md#personality) (a directory
of files that decides an agent's tools, memory and model) can disagree
about, so it lives in `~/.ethos/config.yaml` under `decisions.*`.

**Migration: none required.** No existing module becomes non-compliant.
With no `decisions.*` keys, or with a site set to `off`, every site behaves
byte for byte as it does today. That is the regression contract in the
plan's §14 (R7).

## Trade-offs

**A Structural amendment costs review time up front.** Unanimous approval
is slower than the two-maintainer sign-off an additive change gets. The cost
buys a contract whose surface cannot grow unreviewed. That matters here
because every future provider, and the deferred sites in the plan's §16,
will be written against it.

**The gate lands after the roster row.** The §VII row and the §IX manifest
land in M0, and the gate test lands in M2 with the type. Until M2, nothing
fails if the manifest is wrong. That is acceptable only because there is no
source to drift from yet. M2 must not merge without the gate.

**One provider, one method, no shared validator.** `validateDecisionRequest`
stays inside `extensions/decision-typesafe/` until a second provider exists.
With one provider there is nothing for a shared validator to keep in step.
When a second provider arrives, the validator moves out so the two cannot
disagree on what a legal request is.

## See also

- [Why is a personality a governed contract?](personality-governance.md) —
  the worked example of a frozen schema and its drift gate.
- [Why does AgentCard need a drift gate?](agent-card-governance.md) — the
  previous Structural amendment that added a contract to the §VII roster.
- [Write an LLM provider plugin](../how-to/write-an-llm-provider-plugin.md) —
  the thin-adapter-over-a-transport shape the decision pattern mirrors.
- [Why does AgentLoop receive every dependency at construction?](injection-at-construction.md) —
  why a provider reaches the loop through wiring, never by name.

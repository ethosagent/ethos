---
title: "What lies outside the security register, and what does a narrow boundary cost?"
description: "Non-boundaries, disclosed gaps, triage responses and the cost of a narrow boundary."
kind: explanation
audience: shared
updated: 2026-11-03
---

## Context

Ethos partitions its own source into three tiers of ownership, and publishes a closed list of guarantees that the top tier is held to. One rule makes the partition real rather than decorative:

> **A Tier 2 extension must not be able to weaken a Tier 0 guarantee. If it can, either the extension is wrong or the guarantee was never in Tier 0.**

Everything below is that rule's application. The corollary is what keeps it honest: **a narrow boundary is only defensible if everything inside it is actually true.** A wide, vague scope absorbs over-claims — nobody can hold us to "bundled extensions under `extensions/`" because nobody, including us, knows what it promised. A narrow published boundary has the opposite property: it converts every over-claim inside it into a valid external finding on the day it is published. That is the trade we are making deliberately.

Four readers use this page for four different decisions:

| Reader | The decision | What they read |
|---|---|---|
| Operator | What must I add myself before I can deploy this? | The register's *If you need more* field, plus the [production hardening checklist](.././production-hardening-checklist.md) |
| Buyer or auditor | What can I put in a security questionnaire and defend? | The register, plus the tier roster |
| Security researcher | Is my finding in scope? | The decision table in [SECURITY.md](https://github.com/ethosagent/ethos/blob/main/SECURITY.md) |
| Contributor | What bar is my PR held to? | The tier roster and [`.architecture-state.yaml`](https://github.com/ethosagent/ethos/blob/main/.architecture-state.yaml) |

## Discussion

### What is not a boundary {#non-boundaries}

The register is a closed list, which leaves you to notice absences. These are the absences you would most reasonably assume are covered. Naming them is cheaper than being corrected in public.

| **IS a boundary** | **Is NOT a boundary** |
|---|---|
| The personality toolset — double-enforced at definition and execution | The approval gate against an adversarial LLM — a heuristic over an attacker-influenced string |
| `ScopedStorage` plus the `fs_reach` check — lexical normalisation and the per-segment symlink walk | Credential redaction — a leak-reducer, not a containment |
| `safeFetch` plus DNS validation on every redirect hop | The [skill](../../getting-started/glossary.md#skill) and plugin static scanner — pre-install, advisory, trivially evaded by string concatenation |
| The OS and the container | The injection classifier's regex tier — an explicit v1 floor |
| The capabilities a tool takes through its injected context | A tool's own imports — `node:child_process` or `globalThis.fetch` inside a tool module bypass every scoped decorator |
| The execution posture's *honesty* about where code runs | The `local` posture as containment — it is the label for running un-sandboxed on the host |
| | `observability.db` — no tamper-evidence; the operator with disk access can edit rows |

A second published list sits alongside this one: the **out-of-scope column** of [What is the threat model?](.././threat-model.md) — OS-level RCE, network MITM, physical access, malicious owner, deep transitive-dependency CVEs, adversarially-iterated injection, and insider threat among co-operators sharing a profile. The register points at both rather than duplicating them, so there is one copy of each statement to keep true.

### Gaps, disclosed {#gaps}

A published gap is a roadmap item. An unpublished one is a finding. The difference is entirely in whether we named the field, the contradiction, the fix, and the date — so that is the form every gap takes here. A weasel clause (*"some controls may be configurable in certain deployments"*) earns none of this; it reads as a pre-emptive excuse and invites the reporter to go looking for what it is hiding.

**Closed in this release.** Three contradictions between a published claim and the code were closed in the same change that published this page.

- **The `fs_reach` symlink hole.** The reach check was a normalised **lexical** prefix test with no symlink resolution, while [Security controls](.././controls.md#symlink-misdirection-handling) published symlink misdirection as *Shipped*. A symlink planted inside an allowed prefix, pointing outside it, passed both the always-deny floor and the allow check — the floor compares the same lexically-resolved string, so it never compensated. Two other surfaces had independently discovered this and each patched it locally, and neither patch reached the boundary. It is now fixed: `checkReach` walks every path segment with `lstat`, follows any symbolic link, and refuses the path when the link lands outside the allowlist or on the floor. The walk exists as four hand-maintained copies — `ScopedFsImpl.checkReach`, `ScopedStorage.check`, the backup restore's `containedPath`, and `DocumentsService.reachable` — which must change together; all four fail closed when a segment cannot be `lstat`ed ([Security controls](.././controls.md#symlink-misdirection-handling)). The residual is TOCTOU, which G-FS states plainly and which container-level remediation is the only real answer to.
- **The injection-defense opt-out.** The personality schema shipped an `injectionDefense.enabled` master switch that skipped wrapping, pattern check, and post-read downgrade — contradicting ARCHITECTURE.md §V S6 (`opt_out: forbidden`) and the published claim that per-personality knobs only ever *narrow* policy. In a multi-personality process, one personality setting it to `false` was exactly the composition hazard that claim promised could not happen. The field has been removed from the personality schema. A test-only need is a test-harness concern, not a personality field.
- **Enforcement reachable only through the shipped composition root.** Approval gating and the watcher were assembled in `@ethosagent/wiring`, so an embedder consuming `@ethosagent/core` with its own composition root got a fully functional agent loop with no approval gate and no error saying so. Enforcement now sits behind a policy seam that core requires: wiring still decides *what is dangerous*, core now requires that *something decided*. An embedder who omits it gets a typed refusal at construction rather than a silently ungated loop.

**Closed since publication.** Two gaps this section listed as open have since closed. Saying so is part of the same discipline as listing them.

- **The kernel now has a layer in the constitution.** ARCHITECTURE.md §II names `security-kernel` as a layer with its own dependency rules, and §IX carries the machine-readable form the validator reads. The safety packages are no longer governed by a single hand-written test.
- **The register is now mechanically tied to the code.** `scripts/check-architecture.mjs` fails CI in both directions: a row whose citation stops resolving to the enforcement point it names, a Tier 0 enforcement point published by no row, and a row that disagrees with the tier roster about what is kernel. Each citation is anchored to a **symbol**, not only a line number — so code that *moves* under a claim fails the same check as code that is deleted, which is the quieter half of the failure mode that produced this section.

**Open and tracked.** These are live today, with the phase they close in.

| Gap | What is true today | Fix | Phase |
|---|---|---|---|
| Plugins execute in-process with full Node privileges | The loader `import()`s a plugin entry directly into the process. A loaded plugin shares the process, the environment, the filesystem, and your API keys. The static scanner is pre-install and advisory. | Accepted, documented Tier 1 property, plus a recorded per-plugin capability grant at install time. Out-of-process isolation is a later phase. | Phase 5 |
| Two GitHub orgs are privileged in compiled code | A red scanner finding in anything under `ethosagent` or `anthropic` is operator-overridable by default, and yellow findings auto-acknowledge. | Make the trusted-org set operator-configurable; drop auto-acknowledge for everything except `builtin`. | Phase 5 |

### Triage responses {#triage-responses}

Four verdicts, four responses, written in advance by someone who is not annoyed. The verdict is not negotiable; the tone is entirely ours to choose, and it costs nothing. None of them says *"not a security issue"* — that phrasing is untrue (a Tier 2 bug can be a real bug with real consequences) and it is the fastest way to convert a courteous reporter into a public one.

**Verdict 1 — in scope, kernel.** The finding defeats a named Tier 0 guarantee, wherever the bug lives.

> Thank you. This crosses **G-\<ID\>** in our published guarantee register, so it is in scope and we are treating it as a security issue. We are handling it under 90-day coordinated disclosure and will confirm a fix commitment within \<N\> business days. The root cause will be fixed in the kernel rather than at the site you reported it against — the guarantee is ours to hold, wherever the composition chain runs. We will keep you on the thread through disclosure and credit you unless you ask us not to.

**Verdict 2 — in scope, guarded surface.** Tier 1, and it does not reach a Tier 0 guarantee.

> Thank you. `<module>` is **Tier 1** in our published tier roster — a guarded surface, in disclosure scope. We are committing to a fix and will give you a target date by \<date\>. To be precise about what that commits us to: Tier 1 carries a response commitment, not a correctness guarantee, and this finding does not cross a Tier 0 guarantee in the register. We will coordinate disclosure with you on that basis.

**Verdict 3 — out of scope, extension.** Tier 2, no Tier 0 guarantee crossed.

> Thank you for the report — this is a real bug and we have filed it as \#\<N\>. It is **out of scope under our published security boundary**: `<module>` is Tier 2 in the tier roster, and the finding does not cross a guarantee in the register. Concretely, that means it goes on the ordinary bug queue rather than the security-response queue: no embargo, no CVE, and no security SLA. You are under no obligation to hold it. If you think it composes into one of the register's guarantees through a step we missed, tell us how and we will re-triage — that path is what makes verdict 1 available regardless of which tier the bug lives in.

**Verdict 4 — out of scope, published non-goal.**

> Thank you for the report. This lands on something we publish as explicitly not a boundary: \<the non-boundary list entry, or the threat-model out-of-scope row\>, at \<link\>. That statement predates your report and is the reason we are closing this rather than a judgement we are forming now. If you can show a path from here to one of the guarantees in the register, that is a different report and we would like to see it.

## Trade-offs

### A narrow boundary raises the truth bar inside it {#truth-bar}

The wide scope this replaced quietly absorbed every over-claim. Publishing *"the personality toolset is a guarantee, and injection defense cannot be opted out"* converts an internal inconsistency into a valid external finding on day one. That is the single biggest cost of publishing a boundary — and it is also the argument for it, because it is the only mechanism that has reliably forced these fixes. An inconsistency nobody can cite is an inconsistency nobody prioritises. The three gaps closed in this release were all found by writing the register.

### Out-of-scope invites unilateral publication {#unilateral-publication}

A Tier 2 reporter owes us no embargo, and they owe it to us *because we told them the finding is not a security issue to us*. That is the deal, stated in both directions. Expect Tier 2 findings to appear on a blog before they appear in the issue tracker. It is the price of the filter and it is worth paying — the alternative is an embargo obligation over 87 extension directories, which is the promise this boundary replaced.

### A boundary used as a shield decays into a reflex {#dismissal-hazard}

The decay is invisible from inside: each individual close looks correct. The structural defence is verdict 1 — because a Tier 2 bug reaching a Tier 0 guarantee is a Tier 0 finding, *"it's in an extension"* is never a complete argument. That is necessary and not sufficient, which is why reports closed as out-of-scope get a quarterly review read specifically for a composition chain someone missed. A filter with no audit is an opinion with a table.

### Stability of the register {#stability}

> **Weakening or removing a published guarantee is a breaking change.**

It requires the [ARCHITECTURE.md §VI](https://github.com/ethosagent/ethos/blob/main/ARCHITECTURE.md) amendment class matching its blast radius — **Substantive** for narrowing a claim, **Structural** for removing one or changing which layer enforces it, **Schema** where a frozen schema field carries it — **plus a release-note entry naming what stopped being true.** Not "security hardening in 0.7": the sentence that is no longer accurate, and the sentence that replaces it.

Adding a guarantee is additive and cheap — one row, one enforcement point, ordinary review. **The asymmetry is deliberate and it is the entire reason the register can be relied on.** A list that can quietly shrink is a list you have to re-read before every upgrade, which is the same as having no list.

## See also

- [What does Ethos guarantee, and what is outside its security boundary?](../security-boundary.md) — the main page this one continues.

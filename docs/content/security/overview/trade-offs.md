---
title: "What do layered security defenses cost, and where do I start?"
description: "Costs of layered defenses, acceptance bar and where to start by role."
kind: explanation
audience: shared
updated: 2026-11-03
---

## Context

The costs and limits of the layered defenses, plus where to start by role. Part of [How does Ethos defend against the threats it knows about?](../overview.md).

## Trade-offs

### Layered defenses raise the cost of running the agent

Every check fires on every tool call. Pattern classifiers, the LLM-based tier-2 classifier, provenance wrapping, the filesystem segment walk, the SSRF lookup — none of them are free. The trade is intentional: a few milliseconds per call, in exchange for a structural defense that survives the LLM making a mistake. If a personality is doing only low-risk reads, the marginal cost is dominated by the LLM round-trip anyway.

### "Honest" is not "perfect"

The model defends against the realistic threats, not the imagined ones. Adversarially-iterated prompt injection bypasses the regex classifier; the structural defenses (provenance + tool downgrade) are what we treat as load-bearing for that class. A determined attacker with shell access on the host can edit `config.yaml` and turn anything off. The threat model is explicit about both halves so a customer evaluating Ethos can reason about whether the model matches their environment.

### Some controls are still landing

A small number of controls are tagged *Partial* or *Planned* in the catalogue: the config-load gate for `bash`-requires-sandbox, the transport-level DNS pinning, the TOCTOU race closure on filesystem reads. They have stable interfaces and documented enforcement paths so the eventual landing is not a surprise. Customers can plan around the gap by tightening the per-personality knobs that exist today — narrower `fs_reach`, narrower `toolset`, stricter `approvalMode`.

### Single-operator-per-gateway is a load-bearing assumption

The whole model assumes one trust principal per `~/.ethos/` profile. That makes the per-personality boundaries coherent — they all enforce against a single trust principal. A multi-user shared profile is an unsupported deployment shape; bug reports asking "what if a hostile co-tenant…" will be closed as out-of-scope. If multiple humans need separate trust boundaries, run separate gateways — one per OS user, one per container, or one per pod.

### Status tags are mechanical, not aspirational

Every control in the catalogue carries a status tag: *Shipped*, *Partial*, or *Planned*. A control is *Shipped* only when the code path lives at the linked source, tests (including the adversarial ones above) cover it, and the audit events flow through `observability.db`. *Partial* means the core path is in but a documented sub-case is still landing — for example, the SSRF check ships, but the transport-level DNS pinning that closes the rebind-after-check window is the next step. *Planned* means the interface and design are stable so the eventual landing is not a surprise — the `SandboxAttestation` contract ships and is exported, even though no concrete attested-strict backend has landed yet to declare a confinement profile.

The point of mechanical tags is that the status changes in the same PR that lands the code. A *Partial* becoming *Shipped* is a one-line edit in the catalogue. That keeps the page useful as an engineering ledger, not a marketing artifact.

### Observability is the trust anchor

If you can't reconstruct what happened in a turn, the security model is opaque. Ethos's answer is to write *every* safety decision to one substrate — `observability.db` — and to keep the schema small and stable. That gives an operator a single SQL query to ask "what blocked this call?" and a single retention policy to plan against. It does *not* give a tamper-evident audit log: the operator with disk access can edit the rows. Tamper-evidence requires an off-host write target, which is a deployment-time wiring concern, not a framework default.

### Per-call cost is bounded; per-turn cost is dominated by the LLM

A worst-case turn fires every layer: channel pre-filter, provenance wrapping, classifier (tier-1 regex + tier-2 LLM), toolset filter, hardline blocklist, the filesystem segment walk, DNS lookup, watcher rule evaluation, credential redaction, audit write. In practice the LLM round-trip and the tool's own work dominate; the safety overhead is single-digit milliseconds per call. The most expensive layer — tier-2 classifier on a long untrusted-content blob — runs only on the tool results that get flagged by tier-1 or by content size, so its budget is bounded by the same untrusted-content surface it is defending.

### Acceptance bar for every safety chapter

The acceptance criteria for every safety chapter in the framework include adversarial bypass attempts, not just happy-path tests. Encoding tricks (base64, URL-encoding, hex escapes, hidden Unicode). Redirect chains (`301` → `302` → `307` through to denied schemes or denied hosts). Symlink races (concurrent rename of the parent directory or the target). Length-threshold edges (payloads at the smallest and largest sizes the classifier handles). The adversarial cases live alongside the happy-path tests in each safety package's `__tests__/` directory; `pnpm check` runs the full suite. A control that ships without adversarial coverage is treated as not-shipped — the regression test is the only thing that catches a future change from breaking the bypass-resistance.

That bar is one of the sixteen pre-launch fixes documented in [Pre-launch hardening pass](.././security-fixes.md). It is the reason the controls catalogue tags a control as *Shipped* only when both the happy path and the adversarial path have test coverage. If a future PR adds a control without the matching adversarial test, the chapter acceptance fails and the control does not ship.

### Where to start, by role

The pages in this section answer different questions. Read in the order that matches your role:

- **Operator** running Ethos in production: [Security controls](.././controls.md) first, then [Personality config reference](../../using/reference/personality-yaml.md) for the per-personality knobs.
- **Security reviewer** evaluating the framework: [What is the threat model?](.././threat-model.md) first (does the in-scope set match your environment), then [Pre-launch hardening pass](.././security-fixes.md) (how the design caught issues before shipping).
- **External researcher** preparing a report: [Responsible disclosure](.././responsible-disclosure.md) first (channel, in-scope set, timeline), then [Security controls](.././controls.md) for the source paths.

### How to use this section

- **Building on Ethos?** Start with [Security controls](.././controls.md) and confirm the per-personality knobs for the personalities you ship match the risk posture you want. Default to narrower: a tighter `fs_reach`, a smaller `toolset`, a stricter `approvalMode`.
- **Evaluating Ethos?** Start with [What is the threat model?](.././threat-model.md). The in-scope vs. out-of-scope split tells you whether the framework's model matches your environment. If your environment has threats in the "out of scope" column, plan the additional layer (separate gateway, dependency scanner, OS-level sandbox) before depending on the framework's defaults.
- **Reviewing source?** Every control links to its source path. Read the code, read the tests next to it, run `pnpm check`. The adversarial tests are the ones that prove the bypass-resistance — not the happy-path tests.
- **Reporting a bug?** Read [Responsible disclosure](.././responsible-disclosure.md). The "out of scope" column tells you in advance which classes of report will be closed; everything in scope is fair game.

## See also

- [How does Ethos defend against the threats it knows about?](../overview.md) — the main page this one continues.

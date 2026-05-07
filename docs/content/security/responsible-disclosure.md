---
title: Responsible Disclosure
description: How to report security issues in Ethos, what's in scope, and what we commit to.
sidebar_position: 5
---

# Responsible Disclosure

If you've found a security issue in Ethos, this page tells you how to report it, what we'll do with it, and what's in or out of scope. We take security reports seriously — every issue surfaced through this channel gets routed to a maintainer, not a triage queue.

## Reporting

Open a **GitHub private security advisory** at `https://github.com/MiteshSharma/ethos/security/advisories/new`. The advisory is private until disclosure — only repo maintainers see it. We'll add a dedicated security mailbox once one is set up; until then, the GitHub advisory is the canonical channel.

A good report includes:

- **Summary** — one-paragraph description of the issue.
- **Affected version(s)** — Ethos version (`ethos --version`), and the source commit if you're working from `main`.
- **Reproduction** — the smallest set of steps that reproduces the issue. Stand-alone repros (a config + a script) are easier to triage than environment-specific traces.
- **Impact** — what an attacker can do with the issue. Map it to a row in the [Threat Model](./threat-model) if you can.
- **Suggested fix** — optional, but appreciated.

Please **do not** open public GitHub issues for security reports. Public disclosure before a fix is shipped puts other Ethos users at risk.

## What we commit to

| | What | Timeline |
|---|---|---|
| **Acknowledgement** | A human replies confirming receipt | Within 3 business days |
| **Triage** | Severity assessment + owner assigned | Within 7 business days |
| **Status updates** | Progress on the fix | Every 14 days minimum |
| **Fix or rejection** | Patch shipped, or in-scope rejection with reasoning | Within 90 days for high/critical; 180 days for medium/low |
| **Public advisory** | GitHub Security Advisory + release notes | At fix release |
| **Credit** | Reporter named in the advisory (if they want) | At fix release |

If we miss any of these timelines, the reporter is free to publish — but please give us a chance to land the fix first.

## Severity rubric

We use a simplified rubric mapped to the [Threat Model](./threat-model):

- **Critical** — Bypass of a control protecting a *realistic in-scope threat*. Example: an SSRF bypass that reaches `169.254.169.254`. An RCE in the CLI process from a third-party skill. A pairing-flow replay.
- **High** — Bypass of a control with a non-trivial precondition, or a leak that requires multiple operator missteps to exploit. Example: a redirect chain that defeats the network reach check only when a specific header is present.
- **Medium** — Bypass of a control where the impact is informational or contained. Example: a redaction-pattern miss that leaks a non-credential value.
- **Low** — Hardening request, defense-in-depth improvement, or finding outside the runtime path. Example: a config validator that accepts a deprecated form.

Critical and High get patch releases. Medium and Low typically ride the next minor.

## Scope

### In scope

Everything in the [Security Controls](./controls) catalogue. If a control listed there can be bypassed, that's a bug. Specifically:

- Channel allowlist / pairing / mention-gate / context-visibility filter
- Per-personality toolset enforcement
- Hardline blocklist
- Risk classifier (pattern + LLM tier)
- `ScopedStorage` / `BoundaryError` / TOCTOU-safe filesystem handling
- Network policy (SSRF, scheme allowlist, cloud-metadata, redirect revalidation, DNS pinning)
- Provenance wrapping / two-tier injection classifier / post-read tool downgrade
- Watcher rules (rate-limit, token-budget, compounding-error, suspicious-sequence)
- Credential redaction
- Skill / plugin install scanner / trust tiers / MCP env minimization
- Audit substrate (`observability.db`)

### Out of scope

These match the [Threat Model's out-of-scope column](./threat-model#out-of-scope--what-we-do-not-claim-to-defend) and will be closed without a fix:

- OS-level RCE on the host running Ethos.
- Network MITM (TLS is the right layer).
- Physical access to the machine.
- "Malicious owner" scenarios — anyone with edit access to `~/.ethos/config.yaml` is sovereign by design.
- Deep transitive-dependency CVEs in npm packages.
- Adversarially-iterated prompt injection bypasses of pattern detection (the structural defenses — provenance + tool downgrade — are the ones we treat as load-bearing).
- Multi-tenant scenarios in a single `~/.ethos/` profile.

### Special-case: third-party LLM provider issues

Ethos is a client to upstream providers (Anthropic, OpenAI-compatible). Issues in the provider's service are the provider's responsibility — we'll happily file with them, but the patch ships from their side.

If a provider issue is exploited *through* Ethos in a way the framework should mitigate (e.g. provider-side prompt injection that should be caught by our classifier), that's an Ethos issue and is in scope.

## Coordinated disclosure

For Critical and High issues, we follow this rough sequence:

1. **Day 0** — report received; ack within 3 business days.
2. **Day 0–14** — triage, severity assignment, owner.
3. **Day 14–60** — fix developed and reviewed.
4. **Day 60–80** — pre-release coordination with downstream packagers if applicable.
5. **Day 80–90** — patch release + GitHub Security Advisory + release notes.

Reporters are kept in the loop at each stage. We can also share the proposed patch for review before release if that helps the reporter validate the fix.

## Bounties

We do not currently run a paid bug bounty program. We do publicly credit reporters in the GitHub Security Advisory and the release notes (with reporter consent). A handful of reports have earned long-form acknowledgements in the changelog.

A bounty program may exist in the future as a partner integration. It will not change the disclosure process described here.

## Hall of fame

When advisories ship, the reporter is credited (with consent) in the advisory itself and listed here. The list is empty as of this writing — that's a function of the framework's age, not a claim about how secure it is.

## Next steps

- [Security Overview](./overview) — the framing for everything in this section.
- [Threat Model](./threat-model) — in-scope vs. out-of-scope, in detail.
- [Pre-Launch Hardening Pass](./security-fixes) — the issues we found and fixed before shipping.

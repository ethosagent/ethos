---
name: security-audit
description: |
  Subsystem-scoped security audit of the Ethos codebase. Use when asked to "audit the gateway", "review the trust boundaries of X", "security review of subsystem Y", "check personality isolation", "audit the skill loader", "audit the channel adapter", or any focused security-posture question against a named subsystem. NOT for per-PR diff review (that's a different motion). NOT for "audit Ethos" without a subsystem named — split the audit before starting. Produces an evidence-led report at plan/audits <subsystem>-audit-YYYY-MM-DD.{html,md}. Read-only — never edits the codebase during the audit. Does not commit; the user decides what to do with
  findings.
---

# Security Audit Workflow — Ethos Codebase

A workflow for posture/subsystem security audits of the Ethos codebase. **Not** a per-PR diff review — that's a different motion. This is for *"audit the gateway dedup path"*, *"review the tool capability model"*, *"audit personality isolation"*, *"check the channel-adapter trust boundary"*, *"audit the skill loader"*.

The thing that makes audits work is discipline about scope and evidence. Everything below is in service of that.

## 1. Frame the audit

Before reading any code, write down four things. **If any is unclear, stop and ask the user.**

- **Scope** — one subsystem, one question. *"Audit the gateway"* is scope. *"Audit Ethos"* is not — split it. Examples: gateway dedup, supervisor lifecycle, AgentLoop's tool-execution path, universal skill scanner, plugin loader, channel adapter X, MCP integration, storage abstraction.
- **Threat model** — one paragraph. Common Ethos threats: malicious skill author, prompt injection from untrusted tool output, compromised MCP server, malicious personality definition, adversarial channel input, capability escalation across personality boundaries, secret exfiltration through tool args/results/audit logs, plugin abuse of registered hooks. Findings only make sense relative to this.
- **Asset criticality** — what's on the line if this subsystem fails. User's filesystem? API keys? Team's shared memory? Conversation history? Drives severity; CVSS does not.
- **Prior audits** — check `plan/audits/` for prior findings. Read them first. Re-auditing blind duplicates work and misses regressions.

## 2. Ground in the constitution

Security findings are only valid if they reflect what the codebase is *supposed* to be. Before reading code, read the documents that say so:

- [ARCHITECTURE.md](../../../ARCHITECTURE.md) — layer model, dependency direction, frozen schemas, safety rules. Findings that contradict ARCHITECTURE.md are findings; findings that contradict your *intuition* of how things should work are not.
- [SOUL.md](../../../SOUL.md) — product identity invariants. Useful when evaluating whether a feature *should exist*, not just whether it's safe.
- [CLAUDE.md](../../../CLAUDE.md) — project rules.
- The subsystem's local docs and the relevant `safety-*` / `injection*` modules.

Do not assume a tool is sandboxed because its name sounds safe. Do not assume a capability boundary exists because it would be a good idea. Verify in code.

## 3. Map trust boundaries

Most LLM-framework vulnerabilities cross a trust boundary. Map the ones in scope before reading code:

- Adversary → channel adapter (Telegram/Discord/Slack/Email/WhatsApp message content)
- Untrusted tool output → prompt (`web_extract`, `browse_url`, `read_file` with attacker-controlled content)
- Skill author → personality (skill content, declared permissions, tool list)
- MCP server → AgentLoop (tool definitions, tool results)
- Plugin author → AgentLoop (hooks, tools, injectors registered)
- Personality A → Personality B (cross-personality memory / fs / state)
- Member agent → coordinator → other members (multi-agent prompt injection)

For each in scope: what wraps the data, what classifies it as untrusted, what downgrades capability after crossing.

## 4. Execute the checks

Work from a checklist filtered to the trust boundaries in scope. Per check:

1. **Run the canonical command or read the canonical file.** Static: `rg`, `pnpm typecheck`, `pnpm lint`, `pnpm test`. Dynamic: write a vitest that exercises the trust-boundary crossing. Don't invent fuzzers; reach for what the project already supports.
2. **Capture verbatim evidence.** `file:line:literal-code`. Paraphrased code isn't evidence.
3. **Verdict per check:** pass / fail / n-a / needs-followup. *Needs-followup* is legitimate when threat-model fit is ambiguous — don't force a call.

**Read-only by default. No `Edit` / `Write` / `MultiEdit` on the codebase during the audit.** Reproducer tests stay local — cite them in the report; do not commit. Don't "fix while you're there." Don't delete dead code you happened to notice. The audit surfaces; fixes are separate.

The audit report itself IS allowed to be written — that's the deliverable. Everything else in the codebase is off-limits during this motion.

## 5. Score findings

- **Severity = impact under *your* threat model**, not CVSS. A prompt-injection vector with no path to escalation is medium; a `network → exec` escalation via a skill is critical regardless of where it lands.
- **One root cause = one finding** with N instances. Three tools missing redaction is one finding (*"redaction not enforced at tool boundary"*), not three.
- **Every finding cites evidence.** `file:line:exact-code`, command run, verbatim output. No evidence, no finding.
- **Every finding has a concrete remediation.** "Add a sanitizer" is not remediation. *"In `packages/core/src/agent-loop.ts:265`, wrap the tool result with `wrapUntrusted()` from `safety-trust-boundary.ts` before adding to message history"* is.
- **Cite project rules when they apply.** ARCHITECTURE.md principle violated? Name it. SOUL.md test failed? Name it. Project rules are stronger evidence than auditor judgement.

### Severity rubric

| Severity | Definition (under Ethos threat model) |
|---|---|
| **Critical** | Bypasses a fundamental architectural safety claim AND is reachable via realistic adversary (prompt injection, npm install, or plain config). Full compromise of the boundary. |
| **High** | Meaningful capability escalation OR cross-personality / cross-team leakage. Plausible exploit path; may require an additional step but not exotic. |
| **Medium** | Real isolation gap or trust-model mismatch. Limited or indirect exploit, but the documented contract is not what the code does. |
| **Low** | Informational, documented-but-poorly behaviour, marginal exploit, or defense-in-depth recommendation. |

## 6. Write the report

Default path: `plan/audits/<subsystem>-audit-YYYY-MM-DD.md` (Markdown) or `.html` if the user asked for HTML. Match the tone of existing plan docs (terse, structured, evidence-led). Required sections:

1. **Scope & threat model** — the four things from step 1, crisply.
2. **Methodology** — what code was read, what commands were run, what trust boundaries were probed. A future auditor must be able to replay from this section alone.
3. **Summary** — finding counts by severity, top three risks, overall posture in one paragraph. Read first; make it carry weight.
4. **Findings** — one per finding: ID (`<PREFIX>-NNN`, e.g. `PI-001` for personality-isolation), title, severity, affected files/symbols, evidence (verbatim), impact, remediation, references (architecture principle, SOUL test, CWE, OWASP-LLM).
5. **What was checked and passed** — positive coverage, grouped by trust boundary. Without this the report reads as "everything is broken" when most things are fine.
6. **Out of scope / deferred** — what this audit did NOT cover, one-line reason each. Prevents the report being mistaken for a full-stack review.
7. **Appendix: raw output** — long dumps, test cases, configs. Keep findings section readable.

If HTML: single-file, embedded CSS, semantic HTML (`<article>` per finding), color-coded severity badges, anchor IDs per finding, print-friendly. No JS, no external deps. Use the existing audit at `plan/audits/personality-isolation-audit-2026-05-14.html` as the reference template — match its structure and styling.

## 7. Wrap

The audit ends when the report is written to `plan/audits/`. Each finding carries its ID, severity, and concrete remediation — the report **IS** the follow-up record. No separate tracking file. No git commit. No PR. The user decides what to do with the findings.

**Do not fix findings inside the audit.** The audit surfaces and prioritizes; fixes go through the normal review path. Mixing the two corrupts both — the report becomes *"here's what I changed"* instead of *"here's what's wrong,"* and the fix loses the rigor of a focused PR.

## Invariants

- **Never audit from memory.** ARCHITECTURE.md, SOUL.md, CLAUDE.md, and the subsystem's code are the source of truth; recall is not.
- **Read-only.** No `Edit`, `Write`, `MultiEdit` on the codebase. Reproducer tests stay local. The audit report in `plan/audits/` is the only write permitted. No `git commit`, no `git push`.
- **Never print secrets.** Redact (`REDACTED`) and reference the secret's storage location.
- **One root cause = one finding. One finding = one concrete remediation.**
- **Project rules win over auditor opinion.** If ARCHITECTURE.md or SOUL.md explicitly permits something, it is not a finding even if you'd design it differently.
- **Cite, don't summarise.** `file:line:literal-code` or it didn't happen.
- **If scope is unclear, stop and ask.** Audit sprawl is the failure mode.

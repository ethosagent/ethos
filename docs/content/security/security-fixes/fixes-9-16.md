---
title: "Security hardening log: fixes 9-16"
description: "Pre-launch fixes 9-16: bash attestation through the adversarial test bar."
kind: reference
audience: shared
updated: 2026-11-03
---

## Synopsis {#synopsis}

Pre-launch review fixes 9 through 16, with status and source path for each. Part of the [Security hardening log](../security-fixes.md).

## Fixes 9-16 {#fixes-9-16}

### 9. bash in toolset requires attested-strict backend at config-load time {#9-bash-requires-attested-backend}

**Issue.** The original UI showed a warning when a personality declared `bash` without a sandboxed execution backend. A warning is not a control.

**Why it matters.** `bash` is a universal escape hatch. A personality with `bash` and no sandbox attestation is one tool call away from `cat ~/.ssh/id_rsa`. Letting that combination boot at all is a misconfiguration the framework should catch, not a warning the operator might ignore.

**Fix.** Configuration validation rejects the combination at config-load time. A personality with `bash` in its toolset and no attested-strict backend fails to start.

- **Status:** Not shipped as described. There is no tool named `bash` (the shell tool is `terminal`), no config-load validator reads `SandboxAttestation`, and no runtime warning is emitted. What ships instead is execution-posture gating: an exec-bearing personality resolves to Docker, an honestly labelled `local` posture only with `execution.allowLocalFallback: true`, or a refusal (`resolveExecutionPosture` in `packages/wiring/src/resolve-execution-posture.ts`). See [Bash + filesystem boundary](.././controls.md#bash-filesystem-boundary).
- Interface: `packages/types/src/sandbox.ts`

### 10. Risk classifier patterns explicitly v1-floor-only {#10-classifier-v1-floor-only}

**Issue.** The plan implied the classifier's pattern catalog was the production safety boundary. But shell obfuscation (`$(echo cm0gLXJmIC8K | base64 -d)` for `rm -rf /`, `\x72\x6d` style escapes, etc.) trivially bypasses any regex.

**Why it matters.** Marketing the regex pattern catalog as "the security control" sets the wrong expectation. The catalog is a v1 floor — it stops the dumbest attacks. Production trust comes from sandbox attestation: even if the classifier misses, an attested-strict backend prevents the dangerous operation from reaching the host kernel.

**Fix.** The classifier is documented as a v1 floor only. The production trust path is sandbox attestation. The two layers compose; neither is sold as a standalone boundary.

- **Status:** Design only — this is a positioning correction, not a code change. The classifier itself ships (see fix #4); what changed is how we describe its security guarantees.

### 11. DNS pinning per Node HTTP client {#11-dns-pinning}

**Issue.** The plan said "pass the cached IP directly to the HTTP request." This is wrong for two reasons: it breaks SNI for HTTPS (the wrong virtual host serves the response), and it doesn't actually prevent DNS rebinding for clients that re-resolve.

**Why it matters.** DNS rebinding is the canonical bypass for "the URL is allowlisted, but the IP it resolves to changed." Without per-client pinning that respects SNI, an allowlisted hostname can rebind to a private IP between request and connection.

**Fix.** DNS pinning specifies the transport mechanism per Node HTTP client. `undici` clients use `connect.lookup` to return the pinned IP. Native `http.request` / `https.request` clients use an agent override with a custom `lookup`. The hostname stays in the SNI; the IP is locked to the resolved value at safe-fetch time.

- **Status:** Shipped for `safeFetch`'s default path. Each hop resolves once, validates every address, then connects through `pinnedFetch`: undici's own `fetch` with a per-request `Agent` whose `connect.lookup` returns only the validated addresses, so there is no second resolution to race. A host with no validated address fails to connect instead of re-resolving. `web_extract` is pinned: it connects through `ctx.scopedFetch` → `safeFetch`. Not pinned: a caller-injected `fetchImpl`, and browser sessions, whose route guard validates the URL while Chromium resolves the name again.
- Source: `packages/safety/network/src/safe-fetch.ts` (`pinnedFetch`)
- Tests: `packages/safety/network/src/__tests__/safe-fetch.test.ts` ("connection pinning")

### 12. Network egress allowlisting is in scope {#12-egress-allowlisting-in-scope}

**Issue.** An earlier draft of the threat model listed "network egress allowlisting" as out of scope. This contradicted the implementation chapter, which specifies a per-personality network policy.

**Why it matters.** Inconsistencies between the threat model and the implementation chapters are how features get half-built. If egress allowlisting is in scope in the implementation but not in the threat model, customers can't reason about what's defended.

**Fix.** Egress allowlisting is in scope. The threat model's "out of scope" row was removed.

- **Status:** Design only (threat-model wording). The implementing controls (network policy + SSRF + scheme allowlist) ship and are referenced in fixes #5 and #11.
- Per-personality network policy: `packages/types/src/personality.ts`

### 13. Supply-chain wording reconciled {#13-supply-chain-wording}

**Issue.** The threat model said "supply-chain attacks are out of scope" while the install-time-controls chapter specified a static-analysis pattern scanner, trust tiers, and MCP env minimization. Same problem as #12 — internal inconsistency.

**Why it matters.** A customer reading "out of scope" decides not to depend on the framework for that class of defense. If the framework actually defends against a subset, the customer is now under-protected because of a doc bug.

**Fix.** The wording is reconciled. Install-time controls for the skill / plugin / MCP layer that Ethos itself loads are in scope. Deep transitive-CVE detection across the full npm graph remains out of scope (that's `npm audit` / Snyk / Socket territory).

- **Status:** Design only (threat-model wording). The implementing scanner ships (see [Skill and plugin install controls](.././controls.md#skill-and-plugin-install-controls)).

### 14. Credential redaction moved to Wave 0 {#14-redaction-wave-0}

**Issue.** The original sequencing put credential redaction in Wave 2. Wave 0 was personality config + audit substrate. Wave 1 was channel allowlists + injection defenses. Wave 2 was redaction.

**Why it matters.** Between Wave 0 and Wave 2 is the credential-leak window. During that period, the audit substrate is live (writes to disk), tool errors flow through (containing API keys in failure paths), and redaction isn't on yet. Any leaked key during that window is a real-world incident.

**Fix.** Redaction moved to Wave 0. The first thing the audit substrate gains is the redaction pass. There is no window where the substrate writes credentials in cleartext.

- **Status:** Shipped.
- Source: `extensions/observability-sqlite/src/redact.ts`
- Audit category: `audit.redacted` (counts redactions per write)

### 15. Personality config schema change front-loaded to Wave 0 {#15-schema-change-wave-0}

**Issue.** Several controls (network policy, redaction modes, sandbox attestation reference, channel ingress declaration) needed nested fields on `PersonalityConfig`. The schema change was deferred until Wave 1, so Wave 0 controls had to use ad-hoc parsing.

**Why it matters.** Ad-hoc parsing means one parser per control, divergent error messages, and a future migration when the real schema lands. It also means the field-count gate (`packages/types/src/__tests__/personality-field-count.test.ts`) couldn't enforce the deliberate-schema-change rule.

**Fix.** The schema change is a Wave 0 prerequisite. The parser upgrade and the field-count bump land before any chapter ships, so every control uses the canonical schema from day one.

- **Status:** Shipped.
- Schema source: `packages/types/src/personality.ts`
- Field-count gate: `packages/types/src/__tests__/personality-field-count.test.ts`

### 16. Adversarial test acceptance bar — every chapter {#16-adversarial-test-bar}

**Issue.** The original acceptance criteria for each chapter required happy-path test coverage. "The control fires when expected" is necessary but not sufficient.

**Why it matters.** Happy-path tests prove a control works on a cooperative input. Security tests prove a control works on a hostile input — encoding tricks, redirect chains, symlink races, length-threshold edges. Without adversarial tests, a regression in the bypass-resistance is invisible.

**Fix.** Every chapter's acceptance now includes adversarial bypass attempts. Encoding (base64, URL-encoding, hex escapes, hidden Unicode). Redirect chains (`301` → `302` → `307` to a denied scheme or denied host). Symlink races (concurrent rename of the parent directory or the target). Length edges (payloads at the smallest and largest sizes the classifier handles). The test suite for each safety package includes a dedicated adversarial section. `pnpm check` runs them.

- **Status:** Shipped (acceptance bar). Adversarial cases live alongside the happy-path tests in each package's `__tests__/` directory; `pnpm check` runs the full suite.

## See also {#see-also}

- [Security hardening log](../security-fixes.md) — the index page for this reference.

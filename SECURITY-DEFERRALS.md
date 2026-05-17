# Security Deferrals

Findings from the security audit that are intentionally deferred. Each entry includes the reason for deferral and the trigger condition for re-evaluation.

## Deferred — Blocked by missing prerequisite

### Cross-tenant isolation (2 findings)

**Findings:** cross-tenant data access via shared session store, cross-tenant memory scope leakage.

**Reason:** Ethos is currently single-user-localhost only. There are no tenants. The session store and memory provider both key on a single user's personality/scope. Multi-tenant isolation requires an architectural change (tenant-scoped storage partitioning) that is not on the current roadmap.

**Re-evaluate when:** Multi-tenancy is added to the roadmap or Ethos is deployed in a shared-user environment.

### Plugin scan bypass via transitive dependencies (1 finding)

**Findings:** Plugin scanner does not inspect transitive deps or .cjs/.mjs files.

**Reason:** The plugin system currently only loads local plugins from ~/.ethos/plugins/. There is no remote plugin marketplace or untrusted-code delivery mechanism. The scan bypass is only exploitable if an attacker can place arbitrary files in the plugins directory — at which point they already have local access.

**Re-evaluate when:** A plugin marketplace or remote plugin install mechanism is implemented.

### Untrusted output unwrapping (3 findings)

**Findings:** External content (email body, web scrape, file upload) is passed to the LLM without structural fencing.

**Reason:** Content fencing (XML delimiters, role-boundary markers) is a defense-in-depth measure that reduces prompt injection risk but does not eliminate it. The primary defense is the personality toolset restriction — even if the LLM is manipulated, it cannot call tools outside its allowlist. Fencing adds complexity with marginal benefit at current scale.

**Re-evaluate when:** High-value autonomous actions (payments, code deployment, external API calls with real-world consequences) are added to any personality's toolset.

## Suppressed — False positives

### Regex matches in comment text (5 findings)

Scanner flagged hardcoded regex patterns in test fixtures and documentation comments as potential secrets or injection vectors. These are inert string literals.

### Localhost SSRF in development mode (2 findings)

Scanner flagged `http://localhost:*` URLs in test fixtures. These are test-only URLs that validate the SSRF protection works correctly (they should be blocked, and tests assert they are).

## Low priority — Real but minimal risk

### Chromium --no-sandbox in browser tools (1 finding)

The browser-screenshot tool spawns Chromium with --no-sandbox. This is required in containerized environments (Docker) where the user namespace sandbox is unavailable. The risk is limited because: (a) the browser only navigates to URLs validated by the SSRF guard, (b) the tool is personality-gated and not available by default.

**Mitigation:** Document the risk. Only disable sandbox when running in a container (detect via /.dockerenv or cgroup).

### Example template API key exposure (1 finding)

The example personality template includes a placeholder API key pattern. This is documentation, not a real key.

---

*Last updated: 2026-05-15*
*Next review: When any trigger condition above is met, or quarterly.*

# minimal — Minimal

## Routing
- Model: (engine default)
- Provider: (engine default)
- Dreaming: off

## Capabilities
- (none)

## Memory
- Memory scope: personality:minimal

## Toolset
- (none)

## Prompt size
- Estimated system-prompt tokens: ~340

## MCP servers
- (none)

## MCP export
- Status: not exported — no other app can ask this personality anything.
- To export it: set mcp_export.enabled: true in config.yaml, then run `ethos mcp serve --personality minimal`.

## Plugins
- (none)

## Filesystem reach
- (default — read: own directory, ~/.ethos/skills/, working directory; write: own directory, working directory)

Publishing: not gated — send_message goes out as soon as the agent calls it

## Boundary
Register status for this personality (the twelve published guarantees).
enforced = kernel-enforced, unchanged here · narrowed = this personality tightens it ·
relaxed = widens or disables something above the non-overridable floor · n/a = nothing here reaches it.

| Guarantee | Status | For this personality |
|---|---|---|
| G-TOOLS | relaxed  | no toolset declared — every registered built-in tool is reachable |
| G-CAP   | enforced | tool declarations ∩ personality policy, resolved per call |
| G-FS    | enforced | default reach: own directory, ~/.ethos/skills/, working directory |
| G-NET   | enforced | safeFetch floor: resolved-IP checks, per-hop redirect revalidation |
| G-INJ   | enforced | prelude, provenance wrap, 2-tier classify, post-read downgrade; no opt-out |
| G-SEC   | enforced | SecretsResolver is the only credential path; config carries refs, never values |
| G-RED   | enforced | known credential shapes redacted before observability.db |
| G-APP   | enforced | approvalMode manual — flagged calls held for approval |
| G-EXEC  | enforced | no execution posture resolved on this surface |
| G-WATCH | enforced | out-of-band cross-turn observer; no personality field narrows it |
| G-CHAN  | n/a      | set by channel config, not by this personality — an unconfigured platform is ungated |
| G-AUDIT | enforced | safety decisions land in observability.db; no tamper-evidence |

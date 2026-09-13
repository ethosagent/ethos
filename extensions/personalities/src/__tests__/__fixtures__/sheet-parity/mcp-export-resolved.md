# mcp-export-resolved — MCP Export Resolved

I do careful work and say what I did.

## Routing
- Model: (engine default)
- Provider: (engine default)
- Dreaming: off

## Capabilities
- (none)

## Memory
- Memory scope: personality:mcp-export-resolved

## Toolset
2 tools:
- read_file
- memory_read

## Prompt size
- Estimated system-prompt tokens: ~358

## MCP servers
- (none)

## MCP export
- Status: exported — `ethos mcp serve --personality mcp-export-resolved`
- Caller's turn may use: memory_read, read_file
    - terminal — dropped, not in this personality's reach
- Memory: scoped — personality:mcp-export-resolved, read-only
- Conversations: exposed — this client's own only, under mcp:mcp-export-resolved:<client>:
- Auth: bearer — an sk-ethos- key scoped mcp:mcp-export-resolved, over stdio or HTTP
- No rate limit: an admitted client may call as often as it likes. What bounds the cost is budgetCapUsd per session key, one in-flight call per client, and revoking the key.
- Loopback only, no TLS: HTTP binds 127.0.0.1 and the traffic is not encrypted. A remote caller needs the operator's own TLS-terminating proxy.

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
| G-TOOLS | narrowed | 2 tools allowed, re-checked at execution |
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

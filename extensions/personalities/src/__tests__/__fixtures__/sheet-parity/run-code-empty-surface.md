# run-code-empty-surface — Run Code Empty Surface

I do careful work and say what I did.

## Routing
- Model: (engine default)
- Provider: (engine default)
- Dreaming: off

## Capabilities
- (none)

## Memory
- Memory scope: personality:run-code-empty-surface

## Toolset
1 tool:
- run_code
- Script-callable (run_code): none of 1 tools — the script-tool surface is empty. Every other allowed tool is either excluded (code, delegation, MCP, plugins, clarify, credential-bearing terminal/debug) or unavailable in this process.

## Prompt size
- Estimated system-prompt tokens: ~354

## MCP servers
- (none)

## MCP export
- Status: not exported — no other app can ask this personality anything.
- To export it: set mcp_export.enabled: true in config.yaml, then run `ethos mcp serve --personality run-code-empty-surface`.

## Plugins
- (none)

## Filesystem reach
- Read: /data/
- Write: (none)

Publishing: not gated — send_message goes out as soon as the agent calls it

## Boundary
Register status for this personality (the twelve published guarantees).
enforced = kernel-enforced, unchanged here · narrowed = this personality tightens it ·
relaxed = widens or disables something above the non-overridable floor · n/a = nothing here reaches it.

| Guarantee | Status | For this personality |
|---|---|---|
| G-TOOLS | narrowed | 1 tool allowed, re-checked at execution; 0 script-callable |
| G-CAP   | narrowed | tool declarations ∩ personality policy, resolved per call; intersected with fs_reach |
| G-FS    | narrowed | declared reach: 1 read / 0 write prefix (see Filesystem reach) |
| G-NET   | enforced | safeFetch floor: resolved-IP checks, per-hop redirect revalidation |
| G-INJ   | enforced | prelude, provenance wrap, 2-tier classify, post-read downgrade; no opt-out |
| G-SEC   | enforced | SecretsResolver is the only credential path; config carries refs, never values |
| G-RED   | enforced | known credential shapes redacted before observability.db |
| G-APP   | enforced | approvalMode manual — flagged calls held for approval |
| G-EXEC  | enforced | no execution posture resolved on this surface |
| G-WATCH | enforced | out-of-band cross-turn observer; no personality field narrows it |
| G-CHAN  | n/a      | set by channel config, not by this personality — an unconfigured platform is ungated |
| G-AUDIT | enforced | safety decisions land in observability.db; no tamper-evidence |

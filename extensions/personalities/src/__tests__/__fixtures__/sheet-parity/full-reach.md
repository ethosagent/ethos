# full-reach — Full Reach

Every permission section populated

I do careful work and say what I did.

## Routing
- Model: claude-sonnet-4-6
- Provider: anthropic
- Dreaming: off

## Capabilities
- (none)

## Memory
- Memory scope: personality:full-reach

## Toolset
4 tools:
- read_file
- write_file
- web_search
- run_code
- Script-callable (run_code): 2 of 4 tools (excluded: code, delegation, MCP, plugins, clarify, credential-bearing terminal/debug)

## Prompt size
- Estimated system-prompt tokens: ~363

## MCP servers
- github
- linear

## MCP export
- Status: not exported — no other app can ask this personality anything.
- To export it: set mcp_export.enabled: true in config.yaml, then run `ethos mcp serve --personality full-reach`.

## Plugins
- brand-identity

## Filesystem reach
- Read: ${ETHOS_HOME}/shared/, ${CWD}
- Write: ${CWD}/out/
- Workdirs: /srv/docs, /srv/notes

Publishing: not gated — send_message goes out as soon as the agent calls it

## Boundary
Register status for this personality (the twelve published guarantees).
enforced = kernel-enforced, unchanged here · narrowed = this personality tightens it ·
relaxed = widens or disables something above the non-overridable floor · n/a = nothing here reaches it.

| Guarantee | Status | For this personality |
|---|---|---|
| G-TOOLS | narrowed | 4 tools allowed, re-checked at execution; 2 script-callable |
| G-CAP   | narrowed | tool declarations ∩ personality policy, resolved per call; intersected with fs_reach + network allowlist |
| G-FS    | narrowed | declared reach: 2 read / 1 write prefixes (see Filesystem reach); workdirs /srv/docs, /srv/notes |
| G-NET   | narrowed | host allowlist: 1 host over the always-on floor; 1 deny rule |
| G-INJ   | enforced | prelude, provenance wrap, 2-tier classify, post-read downgrade; no opt-out |
| G-SEC   | enforced | SecretsResolver is the only credential path; config carries refs, never values |
| G-RED   | enforced | known credential shapes redacted before observability.db |
| G-APP   | enforced | approvalMode manual — flagged calls held for approval |
| G-EXEC  | enforced | no execution posture resolved on this surface |
| G-WATCH | enforced | out-of-band cross-turn observer; no personality field narrows it |
| G-CHAN  | n/a      | set by channel config, not by this personality — an unconfigured platform is ungated |
| G-AUDIT | enforced | safety decisions land in observability.db; no tamper-evidence |

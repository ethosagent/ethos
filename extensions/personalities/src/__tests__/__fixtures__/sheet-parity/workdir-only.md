# workdir-only — Workdir Only

I do careful work and say what I did.

## Routing
- Model: (engine default)
- Provider: (engine default)
- Dreaming: off

## Capabilities
- (none)

## Memory
- Memory scope: personality:workdir-only

## Toolset
1 tool:
- read_file

## Prompt size
- Estimated system-prompt tokens: ~354

## MCP servers
- (none)

## MCP export
- Status: not exported — no other app can ask this personality anything.
- To export it: set mcp_export.enabled: true in config.yaml, then run `ethos mcp serve --personality workdir-only`.

## Plugins
- (none)

## Filesystem reach
- (default — read: own directory, ~/.ethos/skills/, working directory; write: own directory, working directory)
- Workdir: /srv/project

Publishing: not gated — send_message goes out as soon as the agent calls it

## Boundary
Register status for this personality (the twelve published guarantees).
enforced = kernel-enforced, unchanged here · narrowed = this personality tightens it ·
relaxed = widens or disables something above the non-overridable floor · n/a = nothing here reaches it.

| Guarantee | Status | For this personality |
|---|---|---|
| G-TOOLS | narrowed | 1 tool allowed, re-checked at execution |
| G-CAP   | narrowed | tool declarations ∩ personality policy, resolved per call; intersected with fs_reach |
| G-FS    | narrowed | declared reach: 0 read / 0 write prefixes (see Filesystem reach); workdir /srv/project |
| G-NET   | enforced | safeFetch floor: resolved-IP checks, per-hop redirect revalidation |
| G-INJ   | enforced | prelude, provenance wrap, 2-tier classify, post-read downgrade; no opt-out |
| G-SEC   | enforced | SecretsResolver is the only credential path; config carries refs, never values |
| G-RED   | enforced | known credential shapes redacted before observability.db |
| G-APP   | enforced | approvalMode manual — flagged calls held for approval |
| G-EXEC  | enforced | no execution posture resolved on this surface |
| G-WATCH | enforced | out-of-band cross-turn observer; no personality field narrows it |
| G-CHAN  | n/a      | set by channel config, not by this personality — an unconfigured platform is ungated |
| G-AUDIT | enforced | safety decisions land in observability.db; no tamper-evidence |

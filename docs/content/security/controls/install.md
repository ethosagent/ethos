---
title: "Security controls: skill and plugin install controls"
description: "Pattern scanner, trust tiers, capability grants and MCP env minimization."
kind: reference
audience: shared
updated: 2026-11-03
---

## Synopsis {#synopsis}

The static-analysis scanner, trust tiers, plugin capability grants, MCP environment minimization and allowed skill permissions. Part of the [Security controls](../controls.md).

## Skill and plugin install controls {#skill-and-plugin-install-controls}

### Static-analysis pattern scanner {#static-analysis-pattern-scanner}

*Status: Shipped.*

Skills and plugins are scanned at install and promotion time.

| Scanner | Rules |
|---|---|
| `packages/safety/scanner/src/skill-scanner.ts` | `prompt-injection`, `hidden-unicode`, `base64-blob`, `sensitive-tool-instruction`, `role-override`, `external-url-instruction` |
| `packages/safety/scanner/src/plugin-scanner.ts` | `dynamic-code-exec`, `credential-access`, `fs-write-outside-safe-path`, `exfil-shape`, and `shell-exec` / `network-access` for capabilities the plugin **uses but did not declare** in `ethos.permissions` (`checkShellExec`, `checkNetworkAccess`) |

The scanner has no rule for declared-but-unused permissions and none for required-tool inflation.

The scanner is **pre-install and advisory**. It reads text before the code is installed; it sandboxes nothing, constrains nothing at runtime, and is evaded by string concatenation. It is published as a non-boundary — see [What is not a boundary](.././security-boundary.md#non-boundaries) — and nothing on this page should be read as strengthening that.

- Audit category `install.scan`: one event per scan decision, with code `install.scan.pass`, `install.scan.warn`, `install.scan.needs_ack` or `install.scan.blocked`, built by `installScanEvent` (`packages/wiring/src/observability/install-scan.ts`). Details carry the kind, source, tier, verdict, finding counts and rule ids — never excerpts, file bodies or URL credentials. Emitted by `ethos skills install` (`scanSkillDir` in `apps/ethos/src/commands/skills.ts` → `recordInstallScan` in `apps/ethos/src/wiring.ts`), `ethos plugin install` (`installPlugin` in `apps/ethos/src/commands/plugin.ts` → `recordInstallScan`), and learning promotion (`learningPromoteDeps` in `packages/wiring/src/learning-pipeline.ts` → `recordSkillScan`). Pinned by `packages/wiring/src/__tests__/install-scan.test.ts`, `packages/wiring/src/__tests__/learning-pipeline.test.ts` and `apps/ethos/src/__tests__/install-scan-audit.test.ts`.
- Limitation: three scan paths write no `install.scan` event — plugin install from the web API, the plugin loader's load-time rescans, and `UniversalScanner` discovery.
- Audit category `install.event`: agent-mesh journal entries and `ethos data reset`.

### Trust tiers {#trust-tiers}

*Status: Shipped.*

There are four tiers. A tier is **derived from the source string** the skill or plugin was installed from, on every scan. It is not assigned per skill, cannot be promoted, and produces no audit event — there is no promotion action to record.

| Tier | Derived from | Yellow findings | Red findings |
|---|---|---|---|
| `builtin` | The literal source `builtin` — code shipped inside this repository | Auto-acknowledged | Installs with `--force` |
| `trusted-repo` | `github.com/<org>/<repo>` where `<org>` is listed in `security.trusted_github_orgs` | Acknowledgment required; `--force` stands in for it | Installs with `--force` |
| `community` | Any other `github.com/…`, `clawhub/…`, or `hermeshub/…` source | Acknowledgment required; `--force` stands in for it | Blocked; `--force` is ignored |
| `untrusted` | A local path or a raw URL | Acknowledgment required; `--force` stands in for it | Blocked; `--force` is ignored |

`builtin` is the only tier that auto-acknowledges yellow findings. Overriding a red finding with `--force` is the only privilege `trusted-repo` holds over `community`.

`security.trusted_github_orgs` is operator-configurable and **replaces** the shipped default (`ethosagent, anthropic`) rather than extending it. Set it to a different list to trust different organizations, or to an empty value to trust no organization by name. Organization matching is exact on the path segment. A `github.com/` source with a `.` or `..` segment yields no organization (`extractGitHubOrg`), so it is never `trusted-repo`; it is derived as `community`, not refused. See [`security.trusted_github_orgs`](../../using/reference/config-yaml.md#security-trusted-github-orgs).

Residual risk: a red finding in a configured organization is overridable with `--force`.

- Source: `deriveTier` in `packages/safety/scanner/src/trust-tiers.ts`

### Plugin capability grants {#plugin-capability-grants}

*Status: Shipped.*

A grant is a **consent record, not runtime enforcement**. It is not a boundary and it does not confine a plugin.

`PluginLoader` `import()`s a plugin's entry module directly into the Ethos process. The plugin shares the process, the environment, the filesystem, and your API keys. Installing a plugin is equivalent to running arbitrary code as your user. This is an accepted, documented Tier 1 property — see [Gaps, disclosed](.././security-boundary.md#gaps).

At install the operator is shown what the plugin **declares** in `ethos.permissions` (`shell` — intent to shell out; `network` — declared hosts, or none), told in plain words what installing it means, and their agreement is recorded durably alongside the scan findings as they stood at that moment. The record's field is named `capabilities`, and there are no per-capability toggles: it records what was declared and what was agreed to. Nothing checks a plugin against its declaration while it runs, and an undeclared capability is not blocked.

| Command | What it does |
|---|---|
| `ethos plugin grants` | Lists every recorded grant — package, version, source, what was declared, the scan result at install, and any revocation date |
| `ethos plugin revoke <pluginId>` | Withdraws the grant. The record is kept with a `revokedAt` date rather than deleted |

Revocation prevents the **next** load and blocks lockfile auto-install. It cannot claw back anything an already-loaded plugin did — that code has already run as the user.

- Source: `extensions/plugin-loader/src/grants.ts`
- Record: `<pluginsDir>/grants.json`
- Load-path gate: `extensions/plugin-loader/src/index.ts`

### MCP environment minimization {#mcp-environment-minimization}

*Status: Shipped.*

When Ethos spawns a stdio MCP server, the child's environment is built from an allowlist, not from the parent's environment minus a denylist (`buildMcpEnv`, called from `extensions/tools-mcp/src/index.ts`):

| Variable | Child receives |
|---|---|
| `PATH`, `USER`, `LANG`, `LC_ALL`, `TERM`, `SHELL` | Passed through |
| Names listed in the server's `mcpEnvPassthrough` | Passed through |
| A name matching `KEY`, `TOKEN`, `SECRET` or `PASSWORD` as a `_`-separated word | Dropped, unless listed in `mcpEnvPassthrough` |
| `HOME`, `TMPDIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` | Set to a persistent per-server directory, `~/.ethos/mcp-runtime/<serverId>/` (mode `0700`); the server's own `env` config cannot override them (`PINNED_MCP_KEYS`) |
| Everything else | Dropped |

Limitation: this changes what the child **inherits**, not what it can read. The MCP server runs as your user, and a server that opens `/Users/<you>/.aws/credentials` by absolute path still reads it.

- Source: `packages/safety/scanner/src/mcp-env.ts`

### Allowed skill permissions {#allowed-skill-permissions}

*Status: Shipped.*

`safety.allowed_skill_permissions` limits the **permissions** a skill may declare, per category. It is not a list of tool names.

```yaml
safety:
  allowed_skill_permissions:
    fs_read: ["~/notes"]
    fs_write: false
    network: ["api.github.com"]
    mcp_env_passthrough: false
```

Each of `fs_read`, `fs_write`, `network` and `mcp_env_passthrough` takes a list (only those values), `true` (any value), or `false` / absent (none). `checkSkillPermissions` in `extensions/skills/src/ingest-filter.ts` compares each value a skill declares against the policy and omits the skill (`{ include: false, reason }`) on the first disallowed value. There is no typed error. When the personality declares no `allowed_skill_permissions` block at all, declared permissions are only warned about, not enforced. `mcp_env_passthrough` is deny-by-default when the block is present (`deriveSkillPassthrough`).

A skill's `required_tools` is a separate check: every required tool must be in the personality's effective tool reach — its toolset plus the tools of its attached MCP servers and plugins — or the skill is omitted (`toolNamesForPersonality` in `packages/core/src/tool-registry.ts`, applied in `ingest-filter.ts`).

- Source: `extensions/skills/src/ingest-filter.ts`; `allowed_skill_permissions` in `packages/types/src/personality.ts`

## See also {#see-also}

- [Security controls](../controls.md) — the index page for this reference.

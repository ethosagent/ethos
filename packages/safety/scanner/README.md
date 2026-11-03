# @ethosagent/safety-scanner

## Purpose

Install-time scanning and trust decisions: `scanSkillMd` and `scanPluginCode` produce findings, trust tiers decide whether a source may be installed, and `buildMcpEnv` builds a minimal environment for MCP subprocesses with credential-looking variables stripped.

## Public surface

Single entry point `.` (`src/index.ts`).

| Export | Kind | One line |
|---|---|---|
| `scanSkillMd` | function | Scans a skill file for injection and risky content. |
| `scanPluginCode` | function | Scans plugin code for dynamic execution and other risks. |
| `PluginScanPermissions` | type | Permissions a plugin scan is judged against. |
| `deriveTier` | function | Derives a trust tier from a source string. |
| `getTierPolicy` | function | The policy for a tier. |
| `canInstall` | function | Install decision from a scan result and tier. |
| `DEFAULT_TRUSTED_GITHUB_ORGS` | const | Default trusted GitHub orgs. |
| `TrustTierOptions` | type | Options for tier derivation. |
| `InstallDecision` | type | Result of `canInstall`. |
| `buildMcpEnv` | function | Minimal MCP subprocess environment. |
| `ScanFinding` | type | One finding. |
| `ScanResult` | type | Scan result. |
| `FindingSeverity` | type | Finding severity. |
| `TierPolicy` | type | Per-tier policy. |
| `TrustTier` | type | Trust tier name. |

## Seam

Security-kernel layer (`kernel-reads-contracts` in `architecture.config.ts`); depends on `@ethosagent/types` only. Behaviour is pinned by the tests below; no static rule enforces that every install path calls `canInstall` (limitation).

## Testing

```
pnpm vitest run packages/safety/scanner
```

- `src/__tests__/trust-tiers.test.ts`: tier derivation, including `ethosagent` and `anthropic` orgs.
- `src/__tests__/skill-scanner.test.ts`: injection phrases detected.
- `src/__tests__/plugin-scanner.test.ts`: `eval(`, `new Function(`, `vm.runInNewContext(` detected.
- `src/__tests__/mcp-env.test.ts`: passthrough variables kept, credential variables stripped.

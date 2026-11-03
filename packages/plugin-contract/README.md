# @ethosagent/plugin-contract

## Purpose

Validates the `package.json` of a published Ethos plugin and gates it on the plugin contract major version. Plugins declare the major they were built against under `ethos.pluginContractMajor`; this package checks it against the supported range. Breaking changes are recorded in `MIGRATIONS.md`.

## Public surface

`package.json` `exports` points at `dist`, so build first to consume it.

| Export | Kind | One line |
|---|---|---|
| `validatePluginPackageJson` | function | Validates a plugin `package.json` and returns a `ValidationResult`. |
| `isEthosPlugin` | function | Whether a `package.json` is an Ethos plugin. |
| `normalizeExternalPluginCompatibility` | function | Normalizes compatibility info for external plugins. |
| `checkPluginContractMajor` | function | Checks a declared major against the supported range. |
| `PLUGIN_CONTRACT_MAJOR` | const | Current contract major (4). |
| `MIN_SUPPORTED_PLUGIN_CONTRACT_MAJOR` | const | Oldest accepted major (2). |
| `ContractCompatResult` | type | Result of the major check. |
| `CredentialDeclaration` | interface | A credential a plugin declares. |
| `EthosPluginPackageJson` | interface | Shape of a plugin `package.json`. |
| `ValidationResult` | interface | Result of package validation. |

## Seam

Protects the "Plugin contract" row of the frozen-schema roster (ARCHITECTURE.md section VII), whose drift gate is the contract-major constant. Archcheck layer: `support`. Bump `PLUGIN_CONTRACT_MAJOR` on any breaking change, as documented in `src/version.ts`.

## Testing

```
pnpm vitest run packages/plugin-contract
```

Pinning tests:
- `src/__tests__/plugin-contract.test.ts`: package validation and the major-version gate.

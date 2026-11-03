# @ethosagent/config

## Purpose

Reads, parses, validates and writes `~/.ethos/config.yaml`: the `EthosConfig` type and its sub-configs, provider chains, the model registry, secret references, per-personality decision-site settings, and bot bindings. File access goes through the `Storage` interface.

## Public surface

Plus many more config interfaces and helpers, see `src/index.ts`.

| Export | Kind | One line |
|---|---|---|
| `EthosConfig` | interface | Shape of the parsed config. |
| `parseConfigYaml` | function | Parses config YAML text into `EthosConfig`. |
| `readConfig` | function | Reads the config through `Storage`. |
| `readRawConfig` | function | Reads the config without secret resolution. |
| `writeConfig` | function | Writes the config back. |
| `loadConfigStrict` | function | Loads the config and fails on errors. |
| `resolveEffectiveConfig` | function | Computes the effective config. |
| `resolveConfigSecrets` | function | Resolves secret references in a config. |
| `validateNoPlaintextSecrets` | function | Rejects plaintext secrets in a config object. |
| `configParseNotices` | function | Collects parse errors and warnings. |
| `KNOWN_CONFIG_KEYS` | const | Known top-level config keys. |
| `ethosDir` | function | Resolves the `~/.ethos` directory. |
| `parseProviderChain` | function | Parses a provider chain. |
| `renderProviderChain` | function | Renders a provider chain back to lines. |
| `parseModelRegistry` | function | Parses the model registry. |
| `validateModelRegistry` | function | Validates the model registry. |
| `planChainModelImport` | function | Plans a chain-model import. |
| `externalizeSecret` | function | Moves a secret value into a secret reference. |
| `resolveSecretRef` | function | Resolves a secret reference. |
| `readKeys` | function | Reads key profiles. |
| `writeKeys` | function | Writes key profiles. |
| `deriveBotKey` | function | Derives a bot key. |
| `validateBotBindings` | function | Validates bot bindings. |
| `DECISION_SITES` | const | Decision site ids (`injection`, `approver`, `router`). |
| `nearestKey` | function | Typo suggestion for unknown keys. |

## Seam

Support package that persists operator-side configuration. Archcheck layer: `support`. It imports `deriveBotKey` from `@ethosagent/core` under exception EX-006 for rule `support-packages` in `architecture.config.ts`.

Pinned behaviours:
- Unknown keys warn, and `KNOWN_CONFIG_KEYS` matches what `writeConfig` emits: `src/__tests__/config-unknown-keys.test.ts`.
- Decision-site ids stay in lockstep with the literal unions in `@ethosagent/types`: `src/__tests__/personality-decision-sites-lockstep.test.ts`.

## Testing

```
pnpm vitest run packages/config
```

Pinning tests:
- `src/__tests__/config-unknown-keys.test.ts`: unknown-key warnings and the known-key drift gate.
- `src/__tests__/personality-decision-sites-lockstep.test.ts`: decision sites match `@ethosagent/types`.
- `src/__tests__/config-plaintext-secrets.test.ts`: plaintext-secret validation.
- `src/__tests__/config-write-preserves-keys.test.ts`: writes preserve existing keys.
- `src/__tests__/config-scalar-roundtrip.test.ts`: scalar parse and render round trip.

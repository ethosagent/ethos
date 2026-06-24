# create-ethos-execution-backend

Starter template for an Ethos execution backend plugin.

## Usage

1. Copy this template directory
2. Replace `BACKEND_NAME` in package.json with your backend name
3. Implement the `ExecutionBackend` interface in `src/index.ts`
4. Register via `api.registerExecutionBackend('name', factory)` in activate()

## Key contract

- `exec()` must end with `{ stream: 'exit', code: number }` on natural completion
- `attest()` must honestly reflect confinement capabilities (the framework decides trust, not the name)
- Credentials come from `SecretsResolver`, never from config values
- `mountsFor()` returns mounts derived from personality `fs_reach`; return `[]` if not applicable

## Security

Execution backends are the highest-privilege plugin class. Your backend will be subject to the trusted-plugin allowlist — deployments must explicitly trust your plugin before it can run code.

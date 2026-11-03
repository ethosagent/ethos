# @ethosagent/execution-process-backend

## Purpose

Reference plugin that registers an unsandboxed `process` execution backend through the plugin SDK. It spawns `bash -c` on the host, and exists to prove the `registerExecutionBackend` seam works end to end. It depends only on `@ethosagent/types` and `@ethosagent/plugin-sdk`.

## Public surface

Default export only (the `exports` key in `package.json` is `.`).

| Export | Kind | One line |
|---|---|---|
| `default` | const | An `EthosPlugin` whose `activate` calls `api.registerExecutionBackend('process', factory)`. |

The backend class itself (`ProcessExecutionBackend`) is not exported.

## Seam

Implements `ExecutionBackend` from `@ethosagent/types` and registers through `EthosPluginApi` from `@ethosagent/plugin-sdk`. Archcheck layer: `extensions`. The attestation reports every confinement flag false except `noDockerSocket`, and `mountsFor` returns no mounts.

Pinned in `src/__tests__/process-backend.test.ts`: a timeout kills grandchildren and not just bash, an abort kills the process group, a backgrounded child holding the pipe does not wedge `exec`, a pre-aborted signal refuses without running the command, and secrets are withheld from the child environment (`env allowlist (V-ES-7, V-ES-8)`).

## Testing

```
pnpm vitest run extensions/execution-process-backend
```

Pinning tests: `src/__tests__/process-backend.test.ts` holds process-group teardown, pre-aborted refusal and the env allowlist.

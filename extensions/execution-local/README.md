# @ethosagent/execution-local

## Purpose

`ExecutionBackend` that runs commands as child processes of the host through `bash -c`. It is not a sandbox; its attestation reports every confinement flag false except `noDockerSocket`. It forwards a small environment allowlist rather than the full `process.env`, and kills the whole process group on timeout or abort.

## Public surface

Single entry point, `src/index.ts` (the only `exports` key in `package.json` is `.`).

| Export | Kind | One line |
|---|---|---|
| `LocalExecutionBackend` | class | `ExecutionBackend` named `local`; takes the wiring factory context and ignores it. |
| `ExecAbortedError` | class | Thrown when an an abort signal is already aborted or fires. |
| `ExecTimeoutError` | class | Thrown when a command exceeds its timeout. |

## Seam

Implements `ExecutionBackend` from `@ethosagent/types` (`packages/types/src/execution.ts`). Archcheck layer: `extensions`. Its environment allowlist is copied into `extensions/execution-process-backend`, `extensions/tools-process` and `packages/core/src/scoped/scoped-process.ts`; the comment in `execution-process-backend/src/index.ts` says the four change together.

Pinned by tests: secrets and `.env`-loaded names are withheld from the child environment (`src/__tests__/local.test.ts`, block `env allowlist (V-ES-8)`); an already-aborted signal refuses before bash is spawned, so no side effect starts (`src/__tests__/pre-aborted.test.ts`).

## Testing

```
pnpm vitest run extensions/execution-local
```

Pinning tests in `src/__tests__/`: `src/__tests__/local.test.ts` (execution, process lifetime on POSIX, env handling and allowlist), `src/__tests__/pre-aborted.test.ts`.

# @ethosagent/execution-docker

## Purpose

`ExecutionBackend` that runs a personality's shell commands inside a hardened Docker container. It derives the container's bind mounts from the personality's `fs_reach`, builds the `docker run` arguments (network mode, resource caps, tmpfs scratch), streams output with a byte ceiling, and reports a `SandboxAttestation` read back from `docker inspect`. Choosing the backend and the image is wiring's job.

## Public surface

Single entry point, `src/index.ts` (the only `exports` key in `package.json` is `.`); `export * from './frames'` re-exports the RPC frame codec. 30 names are exported; the main entry points are below.

| Export | Kind | One line |
|---|---|---|
| `DockerExecutionBackend` | class | The backend: `exec`, `spawnSession`, `mountsFor`, `attest`, `isAvailable`, `dispose`. |
| `buildDockerArgs` | function | Builds the `docker run` argument list for one command. |
| `buildKeepAliveArgs` | function | Same for a persistent session container. |
| `attestationFromInspect` | function | Turns `docker inspect` JSON into a `SandboxAttestation`. |
| `resolveNetworkMode` | function | `none` or `bridge` from the personality's network config. |
| `scratchTmpfsFor` | function | tmpfs mounts for scratch dirs a read-only mount would otherwise block. |
| `workdirArgsFor` | function | `--workdir` arguments for a cwd and a mount set. |
| `isForbiddenMount` | function | True for host paths that must never be mounted. |
| `streamChild` | function | Streams a child process as `ExecChunk`s, in framed RPC mode when requested. |
| `withByteCeiling` | function | Caps total output bytes of an `ExecChunk` stream. |
| `StorageDriverInfo` | interface | Storage driver facts used to decide whether a disk quota can be enforced. |
| `encodeFrame` | function | Encodes a `HostFrame` or `ShimFrame`. |
| `FrameParser` | class | Incremental parser for those frames. |
| `RPC_PROTOCOL_VERSION` | const | Frame protocol version. |
| `MAX_FRAME_BYTES` | const | Largest accepted frame. |
| `RECOMMENDED_DOCKER_IMAGE` | const | `node:24-bookworm`. |

The rest are error classes (`MissingDockerImageError`, `DockerUnavailableError`, `ForbiddenMountError`, `ConstitutionMountError`, `InvalidImageRefError`, `ExecAbortedError`, `ExecTimeoutError`, `RpcProtocolError`, `RpcVersionMismatchError`), image-message constants, and `EmptySubstitutionError` re-exported from `@ethosagent/core`.

## Seam

`DockerExecutionBackend` implements `ExecutionBackend` from `@ethosagent/types` (`packages/types/src/execution.ts`). Mount derivation reuses `deriveFsReachPaths` from `@ethosagent/core` so container mounts and `ScopedStorage` prefixes agree. Archcheck layer: `extensions`.

Pinned by tests: personality definitions, `learning/`, global `skills/` and `commands/`, and the state dir are mounted read-only even when a personality declares write reach (`src/__tests__/mounts.test.ts`); macOS path aliases are refused (`src/__tests__/mounts.test.ts`); `fs_reach` prefixes and docker mounts match (`src/__tests__/fs-reach-parity.test.ts`); a disk quota is emitted only when the storage driver can enforce it (`src/__tests__/resource-caps.test.ts`); attestation comes from the inspected container (`src/__tests__/attest.test.ts`).

## Testing

```
pnpm vitest run extensions/execution-docker
```

Pinning tests in `src/__tests__/`: `src/__tests__/mounts.test.ts`, `src/__tests__/fs-reach-parity.test.ts`, `src/__tests__/docker.test.ts` (run arguments, network mode, byte ceiling; the escape and egress cases run only when Docker and a test image are available), `src/__tests__/attest.test.ts`, `src/__tests__/resource-caps.test.ts`, `src/__tests__/rpc-transport.test.ts` (framed RPC mode), `src/__tests__/frames.test.ts`, `src/__tests__/session-recovery.test.ts`.

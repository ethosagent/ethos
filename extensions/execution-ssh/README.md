# @ethosagent/execution-ssh

## Purpose

`ExecutionBackend` that runs commands on a remote host over the system `ssh` client. It builds the `ssh` argument list and the quoted remote command, validates the destination and host-key persistence before spawning anything, and separates ssh transport failures from remote command failures. Key distribution, host choice and the `ssh` binary itself are the operator's.

## Public surface

Single entry point, `src/index.ts` (the only `exports` key in `package.json` is `.`). 17 names are exported; the main entry points are below.

| Export | Kind | One line |
|---|---|---|
| `SshExecutionBackend` | class | The backend, built from the wiring factory context; `probe`, `isAvailable`, `exec`, `spawnSession`, `attest`. |
| `SshTarget` | type | The `ssh` block of `ExecutionBackendConfig`. |
| `buildSshArgs` | function | Builds the `ssh` argument list for a target. |
| `buildRemoteWords` | function | Builds the quoted remote command words. |
| `sshDestinationError` | function | Returns a reason string if the destination is not a plain `user@host`, or `null`. |
| `sshKnownHostsError` | function | Returns a reason if the known-hosts file would not persist, or `null`. |
| `sshKnownHostsUnwritableError` | function | Same check against this machine, using the effective `ssh -G` result. |
| `knownHostsFromSshConfig` | function | Parses `ssh -G` output into the known-hosts list. |
| `SshConfigResolver` | type | Injectable `ssh -G` resolver. |
| `withByteCeiling` | function | Caps total output bytes of an `ExecChunk` stream. |

The rest are error classes: `SshHostMissingError`, `SshDestinationInvalidError`, `SshKnownHostsInvalidError`, `SshEnvUnsupportedError`, `SshTransportError`, `ExecAbortedError`, `ExecTimeoutError`.

## Seam

Implements `ExecutionBackend` from `@ethosagent/types` (`packages/types/src/execution.ts`). Archcheck layer: `extensions`. One `accessSync` writability probe on the known-hosts destination is a carve-out listed in `.claude/rules/fs-carveouts-host.md`.

Pinned in `src/__tests__/ssh.test.ts`: a ProxyCommand-shaped host or user is refused before anything is spawned; a non-persistent known-hosts file (`/dev/null`, `none`) is refused, including when the operator's `ssh -G` resolves to one; a non-empty `env` is rejected instead of silently dropped; exit 255 with an `ssh:` diagnostic is a transport failure; `BatchMode` is emitted by default and the option terminator always precedes the destination. `src/__tests__/remote-words-stdin.test.ts` runs the built remote words through a real shell.

## Testing

```
pnpm vitest run extensions/execution-ssh
```

Pinning tests in `src/__tests__/`: `src/__tests__/ssh.test.ts` (argument building, destination and known-hosts validation, `exec` behaviour, `isAvailable`), `src/__tests__/remote-words-stdin.test.ts` (remote words executed by a real shell).

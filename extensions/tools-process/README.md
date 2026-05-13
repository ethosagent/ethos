# @ethosagent/tools-process

Background process lifecycle tools — start long-running commands, tail their logs, and stop them, all tracked across agent turns.

## Why this exists

`terminal` runs one-shot commands and waits. This package handles the other case: `pnpm dev`, `python server.py`, `docker compose up` — processes that run indefinitely and need to stay alive while the agent does other work.

## Tools provided

| Tool name | Toolset | Purpose |
|---|---|---|
| `process_start` | `process` | Spawn a command detached; returns `id` + `pid` for tracking. |
| `process_list` | `process` | List all tracked processes with live status and duration. |
| `process_logs` | `process` | Return the last N lines of stdout/stderr (or both interleaved). |
| `process_stop` | `process` | Send SIGTERM (with 5 s SIGKILL escalation) or SIGKILL immediately. |
| `process_wait` | `process` | Block until a process exits or a timeout expires. |

Factory: `createProcessTools(dataDir: string, opts?: { capMax?: number }): Tool[]`

## Tool reference

### `process_start`

```
process_start({
  command: string,           // shell command, e.g. "pnpm dev"
  cwd?: string,              // defaults to ctx.workingDir
  env?: Record<string, string>,
  name?: string,             // human label; auto-derived from command if omitted
}) → { id, pid, name, started_at }
```

Cap: 8 concurrent processes **per personality** (counted by `started_by`), overridable via `createProcessTools(dataDir, { capMax })`. Returns `PROCESS_CAP_EXCEEDED` when at capacity. `maxResultChars: 1024`.

When an explicit `cwd` is passed and the turn wires a `ScopedStorage` (`ctx.storage`), `cwd` is validated against the personality's filesystem allowlist — a path outside it returns `INVALID_CWD`. A `cwd` that is in-allowlist but not yet created on disk is not `INVALID_CWD`; it falls through to the spawn, which surfaces `SPAWN_FAILED`.

### `process_list`

```
process_list() → Array<{ id, name, pid, status, started_at, exit_code?, duration_ms }>
```

Status values: `running` | `exited` | `killed` | `orphan`. Runs a liveness check (`process.kill(pid, 0)`) on every call; marks entries as `orphan` when the process died externally. Stale orphans (>24 h since last touch) are reaped automatically.

### `process_logs`

```
process_logs({
  id: string,
  lines?: number,    // default 200
  stream?: 'stdout' | 'stderr' | 'both',  // default 'both'
}) → string
```

Returns `(no output)` if the log files are empty. `maxResultChars: 64_000`.

### `process_stop`

```
process_stop({
  id: string,
  signal?: 'SIGTERM' | 'SIGKILL',  // default 'SIGTERM'
}) → { stopped: boolean, exit_code?: number }
```

When `signal` is `SIGTERM` (default), waits up to 5 s for the process to exit gracefully, then escalates to `SIGKILL`. `exit_code` is present when the spawn exit-handler captured it before the tool returned. A signal other than `SIGTERM`/`SIGKILL` returns `SIGNAL_NOT_SUPPORTED`. `maxResultChars: 1024`.

### `process_wait`

```
process_wait({
  id: string,
  timeout_s?: number,  // default 30
}) → { exited: boolean, exit_code?: number }
```

On timeout, returns `{ exited: false }` (a success result — the wait completed). `maxResultChars: 1024`.

## CLI mirror — `ethos process`

The `process_*` tools are agent-callable. The same registry is also reachable from a shell via `ethos process`, so you can inspect or stop a process started inside `ethos chat` from a separate terminal:

```
ethos process list [--json]
ethos process logs <id> [--lines N] [--stream stdout|stderr|both]
ethos process stop <id> [--signal SIGTERM|SIGKILL]
```

`list` / `logs` / `stop` drive the same `listProcesses` / `readProcessLogs` / `stopProcess` helpers the tools call (re-exported from this package's `index.ts`), so the output shape and the liveness-check / orphan-marking / stale-reap / SIGTERM-escalation behaviour are identical. There is no CLI equivalent of `process_start` or `process_wait` — processes are started from inside a chat turn. See [`docs/content/using/reference/cli.md`](../../docs/content/using/reference/cli.md#ethos-process).

## How it works

**Registry** — `~/.ethos/processes/registry.json` tracks all spawned processes. Writes are atomic (write-to-tmp + rename) and serialized through an advisory lock (`registry.lock`, 5 s stale-reclaim TTL) so concurrent mutations don't lose entries.

**Log files** — Each process gets `~/.ethos/processes/<id>/stdout.log` and `stderr.log`. Each stream rotates at 10 MB (`LOG_MAX_BYTES`), keeping up to 5 generations (`.log.1` .. `.log.5`) — a ~50 MB ceiling per stream.

> **Rotation only happens for non-running processes.** A live detached child holds an open fd to its log inode; renaming it out from under the child would orphan its writes. So rotation runs at three safe points only: `spawnDetached` (before opening fds — a reused id's stale log has no live writer), and `process_list` / `process_logs` (terminal entries only). A long-lived running process is **not** capped at 10 MB while it runs — its logs are rotated once it reaches a terminal state. This is the honest tradeoff that preserves detached spawn; capping a live stream needs a supervising daemon, which v1 does not have.

**Detached spawn** — `child_process.spawn({ detached: true, shell: true })` + `child.unref()`. Killing the parent `ethos chat` process does NOT kill background processes.

**Orphan detection** — `process_list` probes each running entry with `process.kill(pid, 0)`. If it throws `ESRCH`, the entry is marked `orphan`. The spawn exit handler also marks entries — `exited` when the process exits cleanly (code 0, no signal), `orphan` when killed by an external signal.

## Error codes

Tool failures carry a domain-code prefix in the `error` string so callers can branch on the cause:

| Prefix | Tool(s) | Meaning |
|---|---|---|
| `PROCESS_CAP_EXCEEDED` | `process_start` | The starting personality is already at its concurrent-process cap. |
| `INVALID_CWD` | `process_start` | An explicit `cwd` is outside the personality's filesystem allowlist. |
| `SPAWN_FAILED` | `process_start` | The spawn itself failed (e.g. a `cwd` that does not exist on disk). |
| `PROCESS_NOT_FOUND` | `process_logs`, `process_stop`, `process_wait` | No registry entry for the given `id`. |
| `SIGNAL_NOT_SUPPORTED` | `process_stop` | A signal other than `SIGTERM` / `SIGKILL` was requested. |
| `SIGNAL_FAILED` | `process_stop` | `process.kill` failed for a reason other than `ESRCH`. |

## Gotchas

- Max 8 concurrent processes **per personality** (counted by `started_by`; configurable via `capMax`). Start fails with `PROCESS_CAP_EXCEEDED` once that personality's cap is hit — one personality at the cap does not block another. Per-personality cap *values* are deferred (`PersonalityConfig` is a frozen schema).
- Process IDs are UUIDs, not sequential. Use `process_list` to find the `id` for a named process.
- A still-running process's logs are not rotated — the 10 MB cap only applies once it reaches a terminal state (see "How it works"). A long-lived process can accumulate a large `stdout.log` while it runs.
- `process_logs` `stream: 'both'` interleaves by slicing the last N lines from each log separately, not by timestamp. The ordering within the interleaved result is stdout-first.
- The spawn exit handler races with `process_stop`. If the process exits between the stop's liveness check and its `updateEntry` call, the final status is always forced to `killed`.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Five tool definitions (`process_start` / `list` / `logs` / `stop` / `wait`), `createProcessTools()`; re-exports the registry helpers and `operations.ts` for the CLI. |
| `src/operations.ts` | `listProcesses` / `readProcessLogs` / `stopProcess` — the shared list/logs/stop logic both the tools and the `ethos process` CLI call. |
| `src/registry.ts` | `ProcessEntry` type, `loadRegistry` / `saveRegistry` (atomic), `withRegistryLock` (advisory lock), `isAlive`, `reapStale`, `updateEntry`. |
| `src/spawn.ts` | `spawnDetached` — creates log dirs, opens fd streams, spawns detached, registers exit handler; `rotateLogIfNeeded`. |
| `src/__tests__/` | Integration tests (`process.test.ts`) against a real tmp dataDir using actual child processes, plus `registry.test.ts`, `spawn.test.ts`, `operations.test.ts`. |

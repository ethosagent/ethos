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

Factory: `createProcessTools(dataDir: string): Tool[]`

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

Cap: 8 concurrent processes. Returns `PROCESS_CAP_EXCEEDED` when at capacity.

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

Returns `(no output)` if the log files are empty. `maxResultChars: 40_000`.

### `process_stop`

```
process_stop({
  id: string,
  signal?: 'SIGTERM' | 'SIGKILL',  // default 'SIGTERM'
}) → { stopped: boolean, exit_code?: number }
```

When `signal` is `SIGTERM` (default), waits up to 5 s for the process to exit gracefully, then escalates to `SIGKILL`. `exit_code` is present when the spawn exit-handler captured it before the tool returned.

### `process_wait`

```
process_wait({
  id: string,
  timeout_s?: number,  // default 30
}) → { exited: boolean, exit_code?: number }
```

## How it works

**Registry** — `~/.ethos/processes/registry.json` tracks all spawned processes. Writes are atomic (write-to-tmp + rename) to prevent corruption.

**Log files** — Each process gets `~/.ethos/processes/<id>/stdout.log` and `stderr.log`. They are append-only with no rotation in v1.

**Detached spawn** — `child_process.spawn({ detached: true, shell: true })` + `child.unref()`. Killing the parent `ethos chat` process does NOT kill background processes.

**Orphan detection** — `process_list` probes each running entry with `process.kill(pid, 0)`. If it throws `ESRCH`, the entry is marked `orphan`. The spawn exit handler also marks entries — `exited` when the process exits cleanly (code 0, no signal), `orphan` when killed by an external signal.

## Gotchas

- Max 8 concurrent processes per `dataDir`. Start fails with `PROCESS_CAP_EXCEEDED` once the cap is hit.
- Process IDs are UUIDs, not sequential. Use `process_list` to find the `id` for a named process.
- Log files grow indefinitely in v1. Large long-running processes will accumulate large logs.
- `process_logs` `stream: 'both'` interleaves by slicing the last N lines from each log separately, not by timestamp. The ordering within the interleaved result is stdout-first.
- The spawn exit handler races with `process_stop`. If the process exits between the stop's liveness check and its `updateEntry` call, the final status is always forced to `killed`.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Five tool definitions (`process_start` / `list` / `logs` / `stop` / `wait`), `createProcessTools()`. |
| `src/registry.ts` | `ProcessEntry` type, `loadRegistry` / `saveRegistry` (atomic), `isAlive`, `reapStale`, `updateEntry`. |
| `src/spawn.ts` | `spawnDetached` — creates log dirs, opens fd streams, spawns detached, registers exit handler. |
| `src/__tests__/process.test.ts` | Integration tests against a real tmp dataDir using actual child processes. |

# tools-process capabilities and tool reference

Background process lifecycle tools — start long-running commands, tail their logs, and stop them, all tracked across agent turns.

## Capabilities

| Tool | network | secrets | storage | fs_reach | process |
|------|---------|---------|---------|----------|---------|
| `process_start` | — | — | `{ scope: 'session', kind: 'kv' }` | `{ read: 'from-personality', write: 'from-personality' }` | `{ allowedBinaries: ['*'] }` |
| `process_list` | — | — | `{ scope: 'session', kind: 'kv' }` | `{ read: 'from-personality', write: 'from-personality' }` | `{ allowedBinaries: ['*'] }` |
| `process_logs` | — | — | `{ scope: 'session', kind: 'kv' }` | `{ read: 'from-personality', write: 'from-personality' }` | `{ allowedBinaries: ['*'] }` |
| `process_stop` | — | — | `{ scope: 'session', kind: 'kv' }` | `{ read: 'from-personality', write: 'from-personality' }` | `{ allowedBinaries: ['*'] }` |
| `process_wait` | — | — | `{ scope: 'session', kind: 'kv' }` | `{ read: 'from-personality', write: 'from-personality' }` | `{ allowedBinaries: ['*'] }` |

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



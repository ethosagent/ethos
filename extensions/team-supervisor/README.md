# @ethosagent/team-supervisor

## Purpose

Runs a team of personality workers as supervised child processes. It parses and validates the team manifest, allocates ports, keeps a single-supervisor PID file, restarts crashed members behind a rolling-window brake, probes member health, and runs the `Dispatcher` that claims ready kanban tickets and sends them to the assigned member. The kanban board stays the source of truth, and mesh registry and board storage belong to `@ethosagent/agent-mesh` and `@ethosagent/kanban-store`.

## Public surface

Single entry point `.` (`src/index.ts`), about 28 values plus types. Main entry points below.

| Export | Kind | One line |
|---|---|---|
| `runSupervisor` | function | Launches members, restarts them, runs the dispatcher and health loop. |
| `buildMemberLaunchArgs` | function | CLI arguments for one member worker. |
| `resolveRestartLimits` | function | Defaults the restart brake to 5 respawns in 60 seconds. |
| `evaluateRestartGuard` | function | Decides whether a crashed member may be respawned. |
| `Dispatcher` | class | Claims ready tickets, dispatches to running assignees, reclaims stale claims. |
| `DispatcherOptions` | type | Board, supervisor view, mesh, hooks, `secrets` and timing options. |
| `SupervisorState` | type | Minimal supervisor view the dispatcher needs. |
| `defaultDispatchCall` | const | HTTP dispatch to a member's `/notify`. |
| `defaultSpawnDispatchCall` | const | Spawn-style dispatch variant. |
| `parseTeamManifest` | function | Parses and validates a team manifest from YAML. |
| `serializeTeamManifest` | function | Writes a manifest back to YAML. |
| `validateForStart` | function | Start-time manifest checks. |
| `acquirePidFile` | function | Takes the single-supervisor PID file; returns a release function. |
| `hasLiveTeamProcesses` | function | True when any team PID in a directory is alive. |
| `isProcessAlive` | function | Liveness check for a pid. |
| `allocatePorts` | function | Allocates one port per member. |
| `allocatePort` | function | Allocates one free port. |
| `isPortInUse` | function | Whether a port is bound. |
| `probeHealth` | function | One health probe of a member port. |
| `startHealthProbeLoop` | function | Periodic probe loop; returns a stop function. |
| `writeRuntime` | function | Persists `TeamRuntime` state for a team. |
| `readRuntime` | function | Reads it back, or null. |
| `logSupervisorEvent` | function | Appends a JSON line to the supervisor log. |
| `teamsDir` | function | Root directory for team runtime state. |

Also exported: `readRuntimeFrom`, `removeRuntime`, `runtimePath`, `pidFilePath`, `teamLogDir`, `supervisorLogPath`, and the types `RestartLimits`, `RestartLoopGuardConfig`, `MemberRuntime`, `MemberStatus`, `TeamRuntime`, `PortAllocation`, `HealthResponse`, `ProbedMember`, `ProbeFunction`, `SupervisorEventKind`, `SupervisorLogEntry`, `DispatchCall`, `SpawnDispatchCall`.

## Seam

Layer `extensions`. Implements no single `@ethosagent/types` interface; it consumes `TeamManifest`, `TeamMember`, `HookRegistry` and `SecretsResolver` from it, and fires `ticket_claimed`, `ticket_stale_reclaimed` and `dispatch_tick` hooks void-only. `src/pid.ts` and the process spawning use raw `node:fs`; the whole directory is on the allow-list in `apps/ethos/src/__tests__/no-raw-fs.test.ts`, and `.claude/rules/fs-carveouts-locks.md` names `acquirePidFile` as process-management state. Recovery after a supervisor crash is pinned by `src/__tests__/supervisor-reconstruction.test.ts`.

## Testing

```
pnpm vitest run extensions/team-supervisor
```

15 test files in `src/__tests__/`. Main ones:

- `src/__tests__/supervisor-reconstruction.test.ts`: in-flight tickets recovered after a clean stop and after a kill -9, orphaned work reclaimed.
- `src/__tests__/cross-phase-durability.test.ts`: 100 tickets with failures, crashes and stale claims hold the durability invariants together.
- `src/__tests__/dispatcher.test.ts`, `src/__tests__/dispatcher-mesh.test.ts`, `src/__tests__/dispatcher-auth.test.ts`: claim and dispatch, mesh lookup, bearer token via `SecretsResolver`.
- `src/__tests__/restart-loop-guard.test.ts`, `src/__tests__/supervisor-crash.test.ts`: default 5 in 60s, backoff, member marked failed after the limit.
- `src/__tests__/concurrent/pid.test.ts`, `src/__tests__/concurrent/ports.test.ts`: second supervisor refused while the first is alive, concurrent port allocation is unique.

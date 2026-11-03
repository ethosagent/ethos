# @ethosagent/execution-coding-agents

## Purpose

Runs real ACP-native coding-agent CLIs as background-job runners. It is an Agent Client Protocol client (`initialize`, `session/new`, `session/prompt`, `session/update`, `session/request_permission`) over stdio to an agent inside a sandboxed container, with one git worktree per run. The elicitation router and capability registry stay Ethos-side and are shared with `extensions/execution-pi`; the two packages share no files by design (D-ACP1 in `src/index.ts`).

## Public surface

Single entry point, `src/index.ts` (the only `exports` key in `package.json` is `.`). 47 names are exported; the main entry points are below.

| Export | Kind | One line |
|---|---|---|
| `AcpJobRunner` | class | `JobRunner` for one ACP agent; a second agent registers under its own name from the same class. |
| `AcpJobRunnerDeps` | type | Dependencies injected into `AcpJobRunner`. |
| `runAcpHost` | function | Drives the ACP handshake and prompt turn and yields translated `AgentEvent`s. |
| `AcpHostSpec` | type | What `runAcpHost` needs to start one run. |
| `SpawnFn` | type | Injectable process spawner. |
| `AcpConnection` | class | JSON-RPC 2.0 request correlation and framing for one connection. |
| `JsonlReader` | class | Newline-delimited JSON line reader. |
| `AcpEventTranslator` | class | Maps `session/update` notifications onto `AgentEvent`s. |
| `createRouterGate` | function | Permission gate that routes through the shared interaction router. |
| `createPersonalityGate` | function | Permission gate driven by a personality's tool rules. |
| `createAutoApproveGate` | function | Approves every request, preferring `allow_always`. |
| `acpRunnerCapabilities` | function | Builds `RunnerCapabilities` for an ACP agent. |
| `CLAUDE_CODE_ACP_CAPABILITIES` | const | Capabilities recorded for the Claude Code adapter. |
| `CLAUDE_CODE_ACP_RUNNER_NAME` | const | Registry name for that runner. |
| `ACP_METHODS` | const | Method names used on the wire. |
| `ACP_PROTOCOL_VERSION` | const | Protocol version sent on `initialize`. |
| `agentBinaryAvailable` | function | Probes whether a command resolves and answers `--version`. |
| `claudeCliAvailable` | function | The same probe for the Claude CLI. |
| `prepareWorkspace` | function | Creates the run's git worktree. |
| `acpWorkspacePaths` | function | Host paths a run owns under `${ETHOS_HOME}/worktrees/`. |
| `assertWorkspaceInReach` | function | Throws `WorkspaceOutOfReachError` when `fs_reach` does not cover the worktree. |
| `WorkspaceOutOfReachError` | class | Thrown by `assertWorkspaceInReach`. |

The remaining exports are the `Acp*` protocol types from `src/acp-protocol.ts`.

## Seam

`AcpJobRunner` implements `JobRunner` from `@ethosagent/types` (`packages/types/src/background-job.ts`); events are the frozen `AgentEvent` union. Archcheck layer: `extensions`. `src/worktree.ts` and `src/availability.ts` use raw `node:fs` under the host carve-out in `.claude/rules/fs-carveouts-host.md`.

Pinned by tests: a run is refused when the personality's `fs_reach` does not cover the worktree (`src/__tests__/runner.test.ts`, `src/__tests__/worktree.test.ts`); a gate that throws answers `cancelled` and never an allow (`src/__tests__/acp-gate.test.ts`, `src/__tests__/host.test.ts`); a job is marked tainted once the external agent is about to run (`src/__tests__/runner.test.ts`).

Limitation: the gate sees only calls the agent asks permission for; a tool call the agent's own mode runs without `session/request_permission` never reaches it (comment in `src/acp-gate.ts`).

## Testing

```
pnpm vitest run extensions/execution-coding-agents
```

Pinning tests in `src/__tests__/`: `src/__tests__/acp-connection.test.ts` (request correlation, per-call timeout, inbound requests), `src/__tests__/acp-gate.test.ts` (allow and deny paths, malformed options), `src/__tests__/host.test.ts` (handshake, event translation, silent or dead agent surfaced as a failure), `src/__tests__/runner.test.ts` (registration, containment, tainted marking, mounts), `src/__tests__/worktree.test.ts` (workspace paths, reach check, real git worktree).

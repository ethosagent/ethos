# @ethosagent/execution-pi

## Purpose

Runs the Pi coding-agent harness as a background-job runner. It supervises the Pi host process, speaks Pi's stdio JSON-RPC, confines the run to a sandboxed container with one git worktree per job, and translates Pi events into `AgentEvent`s. The elicitation router and capability registry stay Ethos-side and are reused by `extensions/execution-coding-agents`.

## Public surface

Single entry point, `src/index.ts` (the only `exports` key in `package.json` is `.`). 27 names are exported; the main entry points are below. The package also ships a container `docker/Dockerfile` and the in-container gate extension `pi-extension/ethos-gate.ts`, which is not part of the Ethos runtime.

| Export | Kind | One line |
|---|---|---|
| `PiJobRunner` | class | `JobRunner` for Pi; `isAvailable`, `describe`, `run`. |
| `PiJobRunnerDeps` | type | Dependencies injected into `PiJobRunner`. |
| `runPiHost` | function | Spawns and drives the Pi host, yielding translated events. |
| `PiHostSpec` | type | What `runPiHost` needs to start one run. |
| `PiEventTranslator` | class | Maps Pi RPC events onto existing `AgentEvent` variants. |
| `createRouterGate` | function | Gate that asks through the shared interaction router; non-affirmative answers deny. |
| `createPersonalityGate` | function | Gate driven by a personality's tool rules. |
| `createAutoApproveGate` | function | Approves every tool call. |
| `parseGateTitle` | function | Parses the gate extension's request title. |
| `PI_RUNNER_NAME` | const | Registry name of the runner. |
| `PI_RUNNER_CAPABILITIES` | const | Recorded `RunnerCapabilities` for Pi. |
| `piBinaryAvailable` | function | Probes whether the Pi binary resolves. |
| `piCredentialsPresent` | function | Whether Pi credentials exist on this machine. |
| `defaultPiConfigDir` | function | Default Pi config directory. |
| `JsonlReader` | class | Newline-delimited JSON line reader. |
| `prepareWorkspace` | function | Creates the run's git worktree. |
| `piWorkspacePaths` | function | Host paths a run owns under `${ETHOS_HOME}/worktrees/`. |
| `assertWorkspaceInReach` | function | Throws `WorkspaceOutOfReachError` when `fs_reach` does not cover the worktree. |
| `WorkspaceOutOfReachError` | class | Thrown by `assertWorkspaceInReach`. |

The remaining exports are protocol and gate types (`PiCommand`, `PiEvent`, `PiGateAnswer`, `PiGatePolicy`, `PiGateRequest`, `PiGatePersonality`, `PiWorkspacePaths`) and `toolResultText`.

## Seam

`PiJobRunner` implements `JobRunner` from `@ethosagent/types` (`packages/types/src/background-job.ts`); events map onto the frozen `AgentEvent` union without adding variants (comment in `src/translate.ts`). Archcheck layer: `extensions`. `src/worktree.ts` and `src/availability.ts` use raw `node:fs` under the host carve-out in `.claude/rules/fs-carveouts-host.md`.

Pinned by tests: the router gate denies anything that is not an affirmative and a throwing policy denies rather than allows (`src/__tests__/router-gate.test.ts`); a workspace outside the personality's `fs_reach` is refused (`src/__tests__/worktree.test.ts`, `src/__tests__/runner.test.ts`); the runner declares `takeover: 'none'` (`src/__tests__/runner.test.ts`).

## Testing

```
pnpm vitest run extensions/execution-pi
```

Pinning tests in `src/__tests__/`: `src/__tests__/router-gate.test.ts`, `src/__tests__/runner.test.ts` (capabilities, availability, containment), `src/__tests__/translate.test.ts` (text, tool and usage mapping), `src/__tests__/worktree.test.ts`, and `src/__tests__/live.test.ts` (runs against a real Pi in a container; it records why it did not run when the prerequisites are absent).

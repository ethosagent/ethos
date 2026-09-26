// S1 (plan openclaw-2026.9.6-gaps) — the executor behind a goal's `command`
// acceptance checks.
//
// The judge (`extensions/goal-runner/src/judge.ts`) used to run a model-chosen
// `command` through the host's `sh -c` with no gate at all. It now has no shell
// of its own and runs a check only through this executor, which crosses the
// gates the `terminal` tool's path crosses, for the goal's own personality:
//
//   1. D4 — refused outright when the personality's toolset lacks `terminal`
//      (a personality with no shell gets none through its goals).
//   2. `safety.denyRules` — the same matcher core's `enforceBeforeToolCall`
//      applies to a `terminal` call (`matchDenyRule`).
//   3. The danger predicate (`createDangerPredicate`): the hardline first, then
//      the flag set for the personality's approval mode and execution posture.
//      A judge pass has nobody to ask, so a flagged command is REFUSED — the
//      unattended gate's direction (`apps/ethos/src/unattended-approval-gate.ts`).
//      Under a host-local posture `terminal` is always flagged
//      (`LOCAL_POSTURE_CONSEQUENTIAL_TOOLS`), so a local goal's command checks
//      never run on the host.
//   4. The command runs on the personality's resolved execution route — the
//      same `ExecutionRouter` the exec tools read — or is refused in the
//      route's own words when host execution is forbidden.

import { matchDenyRule } from '@ethosagent/core';
import type { AcceptanceCheckExecutor, CommandResult } from '@ethosagent/goal-runner';
import type {
  ExecutionBackend,
  ExecutionPosture,
  ExecutionRouter,
  PersonalityConfig,
} from '@ethosagent/types';
import { createDangerPredicate } from './danger-predicate';

/** Per-check wall clock — the judge's historical 30s bound. */
const CHECK_TIMEOUT_MS = 30_000;

export interface AcceptanceCheckExecutorDeps {
  personalities: { get(id: string): PersonalityConfig | undefined };
  /** Route for `terminal` / `run_tests` / `lint` (`ExecutionRouting.exec`). */
  route: ExecutionRouter;
  /** `ExecutionRouting.resolvePosture` — drives the local-posture flag set. */
  postureFor: (personalityId: string | undefined) => ExecutionPosture | undefined;
  /** The host backend for a route with none that permits host execution. */
  hostBackend: () => Promise<ExecutionBackend>;
  /** Working directory for the check, as the exec tools use it. */
  workingDir: string;
}

function refused(reason: string): Error {
  return new Error(`command check refused: ${reason}`);
}

export function createAcceptanceCheckExecutor(
  deps: AcceptanceCheckExecutorDeps,
): AcceptanceCheckExecutor {
  return async (command, { personalityId }) => {
    const person = deps.personalities.get(personalityId);
    if (!person) throw refused(`personality "${personalityId}" is not in the registry`);
    // An absent toolset means every tool — the registry's own reading
    // (`DefaultToolRegistry.executeParallel` filters only when `allowedTools`
    // is set, packages/core/src/tool-registry.ts).
    if (person.toolset && !person.toolset.includes('terminal')) {
      throw refused(
        `personality "${personalityId}" does not hold the terminal tool, so its goals cannot run commands`,
      );
    }
    const args = { command };
    const deny = matchDenyRule(person.safety?.denyRules, 'terminal', args);
    if (deny) throw refused(`denied by personality deny rule: ${deny}`);

    const danger = await createDangerPredicate({
      getPersonality: () => person,
      getExecutionPosture: () => deps.postureFor(personalityId),
    })({
      sessionId: `goal-judge:${personalityId}`,
      toolCallId: 'acceptance-check',
      toolName: 'terminal',
      args,
    });
    if (danger) throw refused(`${danger} (a goal's judge has no one to approve it)`);

    const route = await deps.route(personalityId);
    let backend = route.backend;
    if (!backend) {
      if (route.hostExecForbidden) {
        throw refused(
          route.hostExecForbiddenMessage ?? 'host execution is forbidden for this posture',
        );
      }
      backend = await deps.hostBackend();
    }
    let stdout = '';
    let stderr = '';
    let code: number | null = null;
    for await (const chunk of backend.exec(command, {
      cwd: deps.workingDir,
      timeoutMs: CHECK_TIMEOUT_MS,
      env: {},
      personality: route.personality ?? person,
      sessionId: `goal-judge:${personalityId}`,
    })) {
      if (chunk.stream === 'exit') code = chunk.code;
      else if (chunk.stream === 'stdout') stdout += chunk.data;
      else stderr += chunk.data;
    }
    const result: CommandResult = { code: code ?? 1, stdout, stderr };
    return result;
  };
}

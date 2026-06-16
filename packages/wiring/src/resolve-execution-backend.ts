import type { PersonalityConfig } from '@ethosagent/types';

/**
 * Tool names that carry shell / code execution and therefore want a sandbox.
 * The personality `toolset` is a flat list of tool NAMES, not toolset groups:
 * `terminal`, the `process_*` family, and `run_code` are the exec-bearing
 * tools today.
 */
function isExecTool(name: string): boolean {
  return name === 'terminal' || name === 'run_code' || name.startsWith('process_');
}

/**
 * Minimal execution-backend selector for Phase 2a.
 *
 * - An explicit `execution:` string on the personality config wins (read
 *   defensively — `execution` is NOT on the frozen PersonalityConfig type).
 * - Any execution-bearing tool → `docker`.
 * - Chat-only (no exec tool) → `none`.
 *
 * Minimal selector; the full posture resolver is Lane E (component b) and will
 * supersede this.
 */
export function resolveExecutionBackendName(
  personality: PersonalityConfig,
): 'docker' | 'local' | 'none' {
  const override = (personality as { execution?: string }).execution;
  if (override === 'docker' || override === 'local' || override === 'none') return override;

  const toolset = personality.toolset ?? [];
  if (toolset.some(isExecTool)) return 'docker';
  return 'none';
}

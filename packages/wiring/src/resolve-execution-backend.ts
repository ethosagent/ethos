import type { PersonalityConfig } from '@ethosagent/types';
import {
  type ContainerizedDetectionInput,
  resolveExecutionPosture,
} from './resolve-execution-posture';

/**
 * Execution-backend selector used by tool composition. Delegates to the full
 * posture resolver (Phase 2a, lane E1) so there is ONE posture-selection rule:
 *
 *   - explicit `execution:` override wins;
 *   - chat-only (no exec tool) → `none`;
 *   - exec-bearing → `docker`, unless Ethos is containerized → `local`.
 *
 * `ssh` is a valid posture, but tool composition routes only `docker` through a
 * backend today (local/ssh/none leave tools on the existing ScopedProcess host
 * path), so callers branch on `=== 'docker'`.
 */
export function resolveExecutionBackendName(
  personality: PersonalityConfig,
  containerized?: ContainerizedDetectionInput,
): 'docker' | 'local' | 'ssh' | 'none' {
  return resolveExecutionPosture({ personality, containerized }).backend;
}

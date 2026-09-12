// Where a promoted skill lives on disk.
//
// `skill_evolution.scope` (packages/types/src/personality.ts) says a skill is
// either SHARED (every personality sees it) or PERSONALITY-scoped (only its
// author does). Two call sites promote a drafted skill — the nightly pass
// (`proposeSkillFromEvidence`) and the human web approve
// (`PersonalitiesService.skillCandidateApprove`) — and they disagreed: the web
// approve always wrote the shared dir, silently widening a personality-only
// skill to the whole deployment. This helper is the one owner of that mapping
// so a third promoter cannot re-open the gap.
//
// Pure: it derives a path and touches no filesystem.

import { join } from 'node:path';

/**
 * Directory a promoted skill for `personalityId` is written to.
 *
 * - `'personality'` → `<dataDir>/personalities/<personalityId>/skills`
 * - `'shared'` or unset → `<dataDir>/skills`
 */
export function liveSkillDir(
  dataDir: string,
  personalityId: string,
  scope: 'personality' | 'shared' | undefined,
): string {
  return scope === 'personality'
    ? join(dataDir, 'personalities', personalityId, 'skills')
    : join(dataDir, 'skills');
}

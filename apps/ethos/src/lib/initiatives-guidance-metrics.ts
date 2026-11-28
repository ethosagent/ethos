import { mapGuidance } from '@ethosagent/initiative-runner';
import type { InitiativeCliPort } from '@ethosagent/wiring';

export interface GuidanceMetrics {
  total: number;
  unreachable: number;
  /** 0..1, or null when there are no guidance lines. */
  ratio: number | null;
}

/**
 * Every tool a guidance line can map to. The CLI has no per-personality toolset, so guidance is
 * mapped as if all of them were present: only lines with no connector at all (Mixpanel, Slack,
 * ...) count as unreachable, which is what decides the next connector to build.
 */
const ALL_CANDIDATE_TOOLS = [
  'web_search',
  'read_file',
  'linkedin_search',
  'reddit_web_search',
  'reddit_search',
  'x_search',
] as const;

/**
 * Unreachable-guidance ratio for one personality. Initiative guidance uses the status saved by
 * InitiativeConfigService (mapGuidance at save time) and falls back to mapGuidance for entries
 * without one; settings.yaml `standingGuidance` goes through mapGuidance.
 * Pinned by apps/ethos/src/commands/__tests__/initiatives-cli.test.ts.
 */
export async function guidanceMetrics(
  port: InitiativeCliPort | null,
  personalityId: string,
  loadStandingGuidance?: (personalityId: string) => Promise<readonly string[]>,
): Promise<GuidanceMetrics> {
  let total = 0;
  let unreachable = 0;
  const count = (status: string | undefined) => {
    total++;
    if (status === 'unreachable') unreachable++;
  };
  if (port) {
    for (const row of port.store.list({ personalityId })) {
      const file = await port.file(row.id);
      for (const g of file?.guidance ?? []) {
        count(
          g.status ??
            mapGuidance([g.text], { toolset: ALL_CANDIDATE_TOOLS, level: 'initiative' })[0]?.status,
        );
      }
    }
  }
  const standing = (await loadStandingGuidance?.(personalityId)) ?? [];
  for (const m of mapGuidance(standing, { toolset: ALL_CANDIDATE_TOOLS, level: 'personality' })) {
    count(m.status);
  }
  return { total, unreachable, ratio: total === 0 ? null : unreachable / total };
}

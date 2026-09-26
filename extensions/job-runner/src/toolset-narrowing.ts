import type { BackgroundJob } from '@ethosagent/types';

/**
 * The toolset a personality gate should check for a job whose spawning turn was
 * narrowed (S12, `BackgroundJob.toolsetNarrowing`): the personality's toolset
 * intersected with `narrow`, minus `exclude`. Used by the out-of-process
 * runners (ACP, Pi), which cannot take `toolsetNarrow`/`toolsetExclude` the way
 * `EthosJobRunner` hands them to an in-process turn.
 *
 * Limitation: a personality with NO toolset (every tool allowed) and an
 * exclusion but no `narrow` has no list to subtract from, so the result is
 * still `undefined` and the exclusion is not applied to that runner's gate.
 */
export function narrowedToolset(
  toolset: string[] | undefined,
  narrowing: BackgroundJob['toolsetNarrowing'],
): string[] | undefined {
  if (!narrowing) return toolset;
  const { narrow, exclude } = narrowing;
  let out = narrow ? (toolset ? toolset.filter((t) => narrow.includes(t)) : [...narrow]) : toolset;
  if (out && exclude) out = out.filter((t) => !exclude.includes(t));
  return out;
}

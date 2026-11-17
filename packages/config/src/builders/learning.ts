import type { EthosConfig } from '../config-types';

/**
 * The four numbers replay-gated learning runs on when `config.yaml` says
 * nothing (plan `trust-before-reach.md` L-D8). One owner: the block on
 * `EthosConfig` is all-optional, so every reader goes through
 * `resolveLearningReplay` instead of repeating a `??` per call site, which is
 * how the three auto-promotion knobs this part replaces drifted apart.
 */
export const LEARNING_REPLAY_DEFAULTS = {
  enabled: true,
  maxCases: 8,
  maxCostUsd: 0.5,
  maxCandidatesPerRun: 5,
} as const;

export interface LearningReplaySettings {
  enabled: boolean;
  maxCases: number;
  maxCostUsd: number;
  maxCandidatesPerRun: number;
}

/** `config.learningReplay` with `LEARNING_REPLAY_DEFAULTS` filled in. */
export function resolveLearningReplay(
  config: Pick<EthosConfig, 'learningReplay'>,
): LearningReplaySettings {
  const lr = config.learningReplay;
  return {
    enabled: lr?.enabled ?? LEARNING_REPLAY_DEFAULTS.enabled,
    maxCases: lr?.maxCases ?? LEARNING_REPLAY_DEFAULTS.maxCases,
    maxCostUsd: lr?.maxCostUsd ?? LEARNING_REPLAY_DEFAULTS.maxCostUsd,
    maxCandidatesPerRun: lr?.maxCandidatesPerRun ?? LEARNING_REPLAY_DEFAULTS.maxCandidatesPerRun,
  };
}

/**
 * `learningReplay.*` (L-D8). Absent block → `undefined`, the same shape every
 * other optional namespace here has: the defaults live in
 * `LEARNING_REPLAY_DEFAULTS` and are applied by `resolveLearningReplay`, not
 * baked into the parse output, so a round trip does not write four lines into
 * a file the operator never touched.
 *
 * Every number is validated as a WHOLE string, for the reason
 * `buildChannelDigestConfig` and `buildBackupConfig` give: `parseInt` and
 * `parseFloat` stop at the first character they cannot use, so "8 cases" would
 * otherwise be accepted as 8 and "0.5usd" as 0.5.
 */
export function buildLearningReplayConfig(
  kv: Record<string, string>,
): EthosConfig['learningReplay'] {
  const present = Object.keys(kv).some((k) => k.startsWith('learningReplay.'));
  if (!present) return undefined;

  const maxCasesRaw = kv['learningReplay.maxCases'];
  const maxCases =
    maxCasesRaw !== undefined && /^\d+$/.test(maxCasesRaw) ? Number(maxCasesRaw) : Number.NaN;
  // The floor is the verdict rule's, not this key's: rule (a) needs at least 3
  // cases in both arms, so a lower cap makes every candidate `incomplete`
  // forever — a gate that never opens, with nothing on screen saying why.
  if (maxCasesRaw !== undefined && !(Number.isSafeInteger(maxCases) && maxCases >= 3)) {
    throw new Error(
      `Invalid learningReplay.maxCases "${maxCasesRaw}". Expected an integer of 3 or more — ` +
        'a replay of fewer than 3 cases can never reach a pass verdict.',
    );
  }

  const maxCostRaw = kv['learningReplay.maxCostUsd'];
  const maxCost =
    maxCostRaw !== undefined && /^\d+(\.\d+)?$/.test(maxCostRaw) ? Number(maxCostRaw) : Number.NaN;
  if (maxCostRaw !== undefined && !(Number.isFinite(maxCost) && maxCost > 0)) {
    throw new Error(
      `Invalid learningReplay.maxCostUsd "${maxCostRaw}". Expected a positive number.`,
    );
  }

  const maxCandidatesRaw = kv['learningReplay.maxCandidatesPerRun'];
  const maxCandidates =
    maxCandidatesRaw !== undefined && /^\d+$/.test(maxCandidatesRaw)
      ? Number(maxCandidatesRaw)
      : Number.NaN;
  if (
    maxCandidatesRaw !== undefined &&
    !(Number.isSafeInteger(maxCandidates) && maxCandidates >= 1)
  ) {
    throw new Error(
      `Invalid learningReplay.maxCandidatesPerRun "${maxCandidatesRaw}". Expected a positive integer.`,
    );
  }

  return {
    ...(kv['learningReplay.enabled'] !== undefined
      ? { enabled: kv['learningReplay.enabled'] === 'true' }
      : {}),
    ...(maxCasesRaw !== undefined ? { maxCases } : {}),
    ...(maxCostRaw !== undefined ? { maxCostUsd: maxCost } : {}),
    ...(maxCandidatesRaw !== undefined ? { maxCandidatesPerRun: maxCandidates } : {}),
  };
}

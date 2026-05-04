import type { RetentionConfig } from '@ethosagent/types';
import { Cron } from 'croner';
import { mergeRetentionConfig, pruneObservabilityByPath } from './retention';

export interface PruneCronOptions {
  /** Absolute path to observability.db */
  obsDbPath: string;
  /** Effective merged config; defaults applied internally by pruneObservabilityByPath */
  config?: RetentionConfig;
  /** Cron expression — default '0 3 * * *' (03:00 local) */
  schedule?: string;
  /** Per-personality configs; personalities with retention overrides get their own prune pass. */
  personalitiesConfig?: Record<string, { retention?: import('@ethosagent/types').RetentionConfig }>;
  /** Absolute path to sessions.db for messages pruning. */
  sessDbPath?: string;
}

/**
 * Start a nightly background job that prunes the observability database.
 * This is a system-level housekeeping job — not user-visible.
 * Prune failures are swallowed so the process is never crashed by a failed prune.
 */
export function startPruneCron(opts: PruneCronOptions): { stop: () => void } {
  const schedule = opts.schedule ?? '0 3 * * *';
  const effectiveConfig: RetentionConfig = opts.config ?? {};

  const job = new Cron(schedule, { protect: true }, () => {
    // Compute personalities that have their own prune pass so the global pass
    // can exclude their rows — prevents a stricter global TTL from deleting rows
    // that a personality override should retain.
    const excludePersonalityIds = opts.personalitiesConfig
      ? Object.entries(opts.personalitiesConfig)
          .filter(([, pCfg]) => pCfg.retention != null)
          .map(([id]) => id)
      : [];

    // Per-personality passes run first so their data is intact when the global
    // pass evaluates what to exclude.
    if (opts.personalitiesConfig) {
      for (const [personalityId, pCfg] of Object.entries(opts.personalitiesConfig)) {
        if (pCfg.retention) {
          try {
            const merged = mergeRetentionConfig(effectiveConfig, pCfg.retention);
            // No sessDbPath: messages are not personality-scoped.
            pruneObservabilityByPath(opts.obsDbPath, merged, { personalityId });
          } catch {
            // Prune is best-effort — never crash the process
          }
        }
      }
    }

    // Global pass: excludes rows belonging to personalities that had their own pass.
    try {
      pruneObservabilityByPath(opts.obsDbPath, effectiveConfig, {
        sessDbPath: opts.sessDbPath,
        excludePersonalityIds: excludePersonalityIds.length > 0 ? excludePersonalityIds : undefined,
      });
    } catch {
      // Prune is best-effort — never crash the process
    }
  });

  return { stop: () => job.stop() };
}

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
  /** Per-subject configs; subjects with retention overrides get their own prune pass. */
  perSubjectConfig?: Record<string, { retention?: import('@ethosagent/types').RetentionConfig }>;
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
    // Compute subjects that have their own prune pass so the global pass can
    // exclude their rows — prevents a stricter global TTL from deleting rows
    // a subject override should retain.
    const excludeSubjectIds = opts.perSubjectConfig
      ? Object.entries(opts.perSubjectConfig)
          .filter(([, sCfg]) => sCfg.retention != null)
          .map(([id]) => id)
      : [];

    // Per-subject passes run first so their data is intact when the global
    // pass evaluates what to exclude.
    if (opts.perSubjectConfig) {
      for (const [subjectId, sCfg] of Object.entries(opts.perSubjectConfig)) {
        if (sCfg.retention) {
          try {
            const merged = mergeRetentionConfig(effectiveConfig, sCfg.retention);
            // No sessDbPath: messages are not subject-scoped.
            pruneObservabilityByPath(opts.obsDbPath, merged, { subjectId });
          } catch {
            // Prune is best-effort — never crash the process
          }
        }
      }
    }

    // Global pass: excludes rows belonging to subjects that had their own pass.
    try {
      pruneObservabilityByPath(opts.obsDbPath, effectiveConfig, {
        sessDbPath: opts.sessDbPath,
        excludeSubjectIds: excludeSubjectIds.length > 0 ? excludeSubjectIds : undefined,
      });
    } catch {
      // Prune is best-effort — never crash the process
    }
  });

  return { stop: () => job.stop() };
}

import type { RetentionConfig } from '@ethosagent/types';
import { Cron } from 'croner';
import { pruneObservabilityByPath } from './retention';

export interface PruneCronOptions {
  /** Absolute path to observability.db */
  obsDbPath: string;
  /** Effective merged config; defaults applied internally by pruneObservabilityByPath */
  config?: RetentionConfig;
  /** Cron expression — default '0 3 * * *' (03:00 local) */
  schedule?: string;
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
    try {
      pruneObservabilityByPath(opts.obsDbPath, effectiveConfig);
    } catch {
      // Prune is best-effort — never crash the process
    }
  });

  return { stop: () => job.stop() };
}

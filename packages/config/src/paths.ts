import { homedir } from 'node:os';
import { join } from 'node:path';

export function ethosDir(): string {
  const override = process.env.ETHOS_STATE_DIR;
  if (override) return override;
  return join(homedir(), '.ethos');
}

/**
 * The cron store root: `jobs.json`, its `jobs.json.lock` and the `output/`
 * run history. The one resolver every host hands to `CronScheduler`'s
 * required `cronDir`; the scheduler has no default of its own, so a caller
 * that forgets it fails to typecheck instead of silently using `~/.ethos`.
 * Follows `ETHOS_STATE_DIR`; without it this is `~/.ethos/cron`, the path
 * every earlier release used, so existing jobs stay where they are.
 */
export function ethosCronDir(): string {
  return join(ethosDir(), 'cron');
}

/**
 * The operator scripts directory cron `script`/`precheck` jobs and webhook
 * prefilters resolve against — `CronScheduler`'s and `runScriptFile`'s
 * required `scriptsDir`. Follows `ETHOS_STATE_DIR`, like `ethosCronDir`.
 */
export function ethosScriptsDir(): string {
  return join(ethosDir(), 'scripts');
}

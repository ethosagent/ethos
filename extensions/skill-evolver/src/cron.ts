// Register a cron job to run `ethos evolve run --quiet` on a schedule.
// Called from app startup when evolver.cron_enabled is true in config.

import { spawn } from 'node:child_process';
import { Cron } from 'croner';

/**
 * Registers an in-process cron job that invokes `ethos evolve run --quiet`
 * on the given schedule. Returns a cleanup function that stops the job.
 *
 * The `spawn`-based invocation keeps the evolver's LLM I/O out of the main
 * process to avoid blocking the interactive chat loop.
 */
export function registerEvolverCron(schedule: string): () => void {
  const job = new Cron(schedule, { protect: true }, () => {
    const [bin, ...argv] = resolveEthosArgv();
    const child = spawn(bin, [...argv, 'evolve', 'run', '--quiet'], {
      detached: false,
      stdio: 'ignore',
    });
    // Fire-and-forget: cron failures are not surfaced to the interactive session.
    child.unref();
  });

  return () => {
    job.stop();
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Resolve the argv prefix for `ethos` in the current environment:
 * - Production: `[process.execPath, '<ethos-bin>']` — Node + compiled script
 * - Dev (tsx): `[process.execPath, '<tsx-runner>', '<source-index>']`
 *
 * We re-use process.argv[0..1] so the child inherits the same runner as the
 * parent, which handles both `pnpm dev` and compiled builds.
 */
function resolveEthosArgv(): [string, ...string[]] {
  const node = process.argv[0];
  const scriptOrBin = process.argv[1];
  if (!node || !scriptOrBin) return ['ethos'];
  return [node, scriptOrBin];
}

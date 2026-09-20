// `CronScheduler` (`@ethosagent/cron`) defaults `cronDir` to
// `join(homedir(), '.ethos', 'cron')` when the caller does not pass one — a
// server run against an isolated `ETHOS_STATE_DIR` would otherwise read and
// write the operator's REAL `~/.ethos/cron/jobs.json` instead of the
// resolved state dir. Every command-layer construction site must pass
// `cronDir` explicitly. This is a source-text drift guard (the same pattern
// as the "both gateway-role commands" check in `cron-deliver.test.ts`)
// rather than a full command run, since constructing `serve`/`boot`/`gateway`
// end to end needs their whole wiring graph.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const commandsDir = join(import.meta.dirname, '..', 'commands');

function readCommand(file: string): string {
  return readFileSync(join(commandsDir, file), 'utf-8');
}

describe('every CronScheduler construction site passes a state-dir-relative cronDir', () => {
  it.each([
    ['serve.ts', "cronDir: join(dir, 'cron')"],
    ['boot.ts', "cronDir: join(dir, 'cron')"],
    ['gateway.ts', "cronDir: join(ethosDir(), 'cron')"],
    ['cron.ts', "cronDir: join(ethosDir(), 'cron')"],
  ])('%s constructs CronScheduler with %s', (file, expected) => {
    const src = readCommand(file);
    const ctor = src.indexOf('new CronScheduler({');
    expect(ctor, `${file} has no CronScheduler construction site`).toBeGreaterThanOrEqual(0);
    // The cronDir line must appear inside that construction's option object,
    // not merely somewhere later in the file.
    const closeParen = src.indexOf('\n  });', ctor);
    const block = src.slice(ctor, closeParen === -1 ? undefined : closeParen);
    expect(block).toContain(expected);
  });
});

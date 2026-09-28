// UBP-025 — `runCronTurn` (cron-turn.ts) returns the final answer as `output`
// and the whole stream as `transcript`; `persistAndDeliver` (extensions/cron)
// writes `transcript ?? output` to the run file and delivers `output`. A host
// whose inline `runJob` drops `transcript` still delivers correctly but writes
// only the final answer to the run file, so every root that calls
// `runCronTurn` must forward it. `createCronRunJob` (gateway, `cron run`) is
// pinned by cron-turn.test.ts; this scans the two inline hosts.
//
// A source scan, the shape watcher-delivery-gate-wiring.test.ts already uses.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMMANDS = join(import.meta.dirname, '..');

describe.each(['boot.ts', 'serve.ts'])('%s cron runJob', (name) => {
  const source = readFileSync(join(COMMANDS, name), 'utf8');
  const start = source.indexOf('await runCronTurn({');
  const body = source.slice(start, source.indexOf('\n    },\n', start));

  it('destructures transcript from runCronTurn and returns it', () => {
    expect(start).toBeGreaterThan(-1);
    const head = source.slice(source.lastIndexOf('const {', start), start);
    expect(head).toContain('transcript');
    expect(body).toContain('...(transcript !== undefined ? { transcript } : {})');
  });
});

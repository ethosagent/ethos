// Every CLI command that builds an agent loop and runs turns with nobody at a
// prompt refuses a flagged tool call instead of running it unasked
// (`gateNonInteractiveLoop`, apps/ethos/src/lib/non-interactive-approval.ts,
// which wires `wireTerminalApprovalGate` with `coordinator: null`).
//
// Source-level, like the chat/acp wiring checks in terminal-approval.test.ts:
// booting any of these commands needs a provider and a state dir. The gate's
// behaviour itself is pinned by terminal-approval.test.ts ('a run that cannot
// ask refuses a flagged call with a clear reason').

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const commands = join(import.meta.dirname, '..', 'commands');

async function source(file: string): Promise<string> {
  return readFile(join(commands, file), 'utf-8');
}

/** Every `createAgentLoop(` / `resolveActiveLoop(` in `src` is followed by a
 *  `gateNonInteractiveLoop(` before the next loop is built. */
function everyLoopGated(src: string): boolean {
  const builds = [...src.matchAll(/await (createAgentLoop|resolveActiveLoop)\(/g)];
  if (builds.length === 0) return false;
  return builds.every((m, i) => {
    const start = m.index ?? 0;
    const end = builds[i + 1]?.index ?? src.length;
    return src.slice(start, end).includes('gateNonInteractiveLoop(');
  });
}

describe('non-interactive CLI loops refuse flagged calls', () => {
  it.each([
    ['zero.ts', 'ethos -z'],
    ['batch.ts', 'ethos batch'],
    ['eval.ts', 'ethos eval / ethos eval local'],
    ['personality-evolve.ts', 'buildJudgeRunner (ethos personality judge, nightly scoring)'],
    ['bench.ts', 'ethos bench'],
  ])('%s (%s) gates every loop it builds', async (file) => {
    expect(everyLoopGated(await source(file))).toBe(true);
  });

  it('cron.ts gates its loop with the unattended rule (gateCronLoop)', async () => {
    const src = await source('cron.ts');
    expect(src).toMatch(
      /runtime = await createAgentLoop\(config\);\s*gateCronLoop\(runtime, config\);/,
    );
  });

  it('mcp.ts gates the operator-console loop (`ethos mcp serve` with no --personality)', async () => {
    const src = await source('mcp.ts');
    expect(src).toMatch(
      /const runtime = await createAgentLoop\(config\);\s*gateNonInteractiveLoop\(runtime, config,/,
    );
  });
});

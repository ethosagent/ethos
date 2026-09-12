import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// F05 (plan architecture-suggestions-2026-09-10) — every loop-construction
// branch of `ethos serve` forwards the goal store + executor pair its loop was
// built with, and `buildServeWebApi` hands that pair to `createWebApi`. A
// branch that drops it leaves web goals refused (GoalsService.requireExecution);
// before F05 it left them stored `running` and never executed. `runServe` is a
// long-running composition root, so this is asserted against source, like
// serve-callcapture-wiring.test.ts.

const root = join(import.meta.dirname, '..', '..', '..', '..', '..');
const read = (path: string): Promise<string> => readFile(join(root, path), 'utf8');

describe('serve.ts — goal backend forwarding', () => {
  it('assigns the pair from createAgentLoop in both non-team branches', async () => {
    const src = await read('apps/ethos/src/commands/serve.ts');
    expect(src.match(/goals = result\.goals;/g) ?? []).toHaveLength(2);
  });

  it('assigns the pair from createTeamAgentLoop in the coordinator branch', async () => {
    const src = await read('apps/ethos/src/commands/serve.ts');
    expect(src).toMatch(/goals: teamGoals,/);
    expect(src).toMatch(/goals = teamGoals;/);
    const wiring = await read('apps/ethos/src/wiring.ts');
    expect(wiring).toMatch(
      /goals: import\('@ethosagent\/wiring'\)\.CreateAgentLoopResult\['goals'\];/,
    );
  });

  it('hands the pair to createWebApi from serve and from boot', async () => {
    const serve = await read('apps/ethos/src/commands/serve.ts');
    expect(serve).toContain('...(goals ? { goals } : {}),');
    const boot = await read('apps/ethos/src/commands/boot.ts');
    expect(boot).toContain('goals: shared.goals,');
  });
});

// A chat turn for a team personality runs on that team's loop; its GOALS used
// to run on the main loop's pair — wrong board, wrong memory, no `ctx.teamId`.
// The team loop's pair now travels with its handle, and web-api resolves the
// pair per personality the same way it resolves the loop.
describe('serve.ts — team loops carry their goal pair', () => {
  it('hands the team loop’s pair to the web API through TeamLoopHandle', async () => {
    const serve = await read('apps/ethos/src/commands/serve.ts');
    expect(serve).toMatch(/return \{\s*loop: team\.loop,[\s\S]*?goals: team\.goals,/);
    const handle = await read('apps/web-api/src/features/chat/team-loops.ts');
    expect(handle).toMatch(/goals\?: GoalsBackend;/);
    const web = await read('apps/web-api/src/index.ts');
    expect(web).toContain(
      'goalsFor: async (personalityId) => (await teamLoops?.handleFor(personalityId))?.goals,',
    );
  });
});

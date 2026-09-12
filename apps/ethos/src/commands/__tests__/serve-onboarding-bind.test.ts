import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serveLoopOptions } from '../serve';

// Onboarding-mode `ethos serve` (no config.yaml) builds its web API before any
// loop exists. It crashed at startup (a hookless stub), and once that was fixed
// the loop it booted still differed from a normal serve loop: the default `cli`
// profile (terminal guard, not the web approval modal) and no danger check.
// Now both branches build from `serveLoopOptions` and `buildServeDangerPredicate`,
// and the web API runs on its own stand-in until `bindAgentLoop` hands it the
// booted loop — behaviour pinned in apps/web-api/src/__tests__/
// onboarding-bind-loop.test.ts. `runServe` never returns while healthy, so the
// wiring is read from source, like serve-callcapture-wiring.test.ts.

const root = join(import.meta.dirname, '..', '..', '..', '..', '..');
const readServe = () => readFile(join(root, 'apps/ethos/src/commands/serve.ts'), 'utf8');

describe('serveLoopOptions', () => {
  it('builds the web profile with the mesh registry, and cron/watchers only when given', () => {
    const onboarding = serveLoopOptions({ meshName: 'default' });
    expect(onboarding.profile).toBe('web');
    expect(onboarding.meshRegistryPath).toMatch(/default/);
    expect(onboarding).not.toHaveProperty('cronScheduler');
    expect(onboarding).not.toHaveProperty('watcherManager');
  });
});

describe('serve.ts — one builder for every serve loop', () => {
  it('builds the onboarding loop and both normal createAgentLoop calls from serveLoopOptions', async () => {
    const src = await readServe();
    expect(src).toMatch(/createAgentLoop\(\s*agentConfig,\s*serveLoopOptions\(/);
    expect(
      src.match(/createAgentLoop\([^;]*?serveLoopOptions\(\{ meshName: activeMeshName/gs),
    ).toHaveLength(2);
    // No createAgentLoop call in serve builds its own option object any more.
    expect(src).not.toMatch(/createAgentLoop\([^)]*\{\s*profile:/s);
  });

  it('gives the web API the same danger check in both modes', async () => {
    const src = await readServe();
    expect(src).toContain(
      'dangerPredicate: buildServeDangerPredicate(loop, personalities, config),',
    );
    expect(src).toMatch(
      /dangerPredicate: \(loop\) =>\s*buildServeDangerPredicate\(loop, personalities, agentConfig\),/,
    );
  });

  it('runs the onboarding web API on its stand-in and binds the booted loop into it', async () => {
    const src = await readServe();
    expect(src).toContain('bootAgentLoop: async () => {');
    // Adopted all-or-nothing (lib/onboarding-boot.ts): the web API, goal pair and
    // tool registry get the loop together, and the loop is only kept — handed
    // to shutdown's dispose — once all of them have it.
    expect(src).toMatch(
      /await adoptBootedLoop\(agentResult, \{[\s\S]*?web: created,[\s\S]*?\}\);\s*disposeRealLoop = agentResult\.dispose;/,
    );
    expect(src).not.toContain('agentLoop: stubLoop');
  });
});

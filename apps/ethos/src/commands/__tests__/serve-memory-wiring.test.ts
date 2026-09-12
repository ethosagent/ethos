import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// F04 (plan architecture-suggestions-2026-09-10) — every loop-construction
// branch of `ethos serve` forwards the memory bundle its loop was built with,
// and `buildServeWebApi` hands that bundle to `createWebApi`. Before F04 the
// web editor got a markdown-only `createMemoryProvider` at dataDir whatever the
// configured backend, so under `memory: vault` a web edit never reached the
// vault the agent reads. `runServe` is a long-running composition root, so
// this is asserted against source, like serve-goals-wiring.test.ts; the
// behaviour itself is pinned in apps/web-api's memory-backend-rpc.test.ts.

const root = join(import.meta.dirname, '..', '..', '..', '..', '..');
const read = (path: string): Promise<string> => readFile(join(root, path), 'utf8');

describe('serve.ts — memory bundle forwarding', () => {
  it('takes the bundle from createAgentLoop in both non-team branches', async () => {
    const src = await read('apps/ethos/src/commands/serve.ts');
    expect(src.match(/memoryBundle = result\.memoryBundle;/g) ?? []).toHaveLength(2);
  });

  it('takes the bundle from createTeamAgentLoop in the coordinator branch', async () => {
    const src = await read('apps/ethos/src/commands/serve.ts');
    expect(src).toContain('memoryBundle: teamMemoryBundle,');
    expect(src).toContain('memoryBundle = teamMemoryBundle;');
    const wiring = await read('apps/ethos/src/wiring.ts');
    expect(wiring).toContain(
      "memoryBundle: import('@ethosagent/wiring').CreateAgentLoopResult['memoryBundle'];",
    );
  });

  it('never hands the web API a markdown-only editor', async () => {
    const serve = await read('apps/ethos/src/commands/serve.ts');
    expect(serve).not.toContain('createMemoryProvider(');
    expect(serve).not.toContain('memoryBackend:');
    const boot = await read('apps/ethos/src/commands/boot.ts');
    expect(boot).toContain('memoryBundle: shared.memoryBundle,');
  });
});

describe('serve.ts — onboarding mode keeps one memory selection', () => {
  // Onboarding builds the web API before any config exists, so its bundle is
  // the default backend; the agent loop boots later, in-process, from whatever
  // config.yaml then says. The wizard never writes `memory:`, but an
  // out-of-band edit could, and the two would disagree until restart — so the
  // lazily booted loop is pinned to the startup selection instead.
  it('builds the onboarding bundle for the default backend and boots the loop on it', async () => {
    const src = await read('apps/ethos/src/commands/serve.ts');
    expect(src).toContain(
      'memoryBundle: createMemoryBundle({ config: {}, dataDir: dir, storage: getStorage() }),',
    );
    expect(src).toContain("(loaded.memory ?? 'markdown') === 'markdown'");
    expect(src).toContain("{ ...loaded, memory: 'markdown' as const }");
    // Booted on `agentConfig` (the pinned selection), with the options every
    // serve loop shares (serve-onboarding-bind.test.ts).
    expect(src).toMatch(/const agentResult = await createAgentLoop\(\s*agentConfig,/);
  });

  it('the onboarding wizard never writes a memory backend', async () => {
    const onboarding = await read('apps/web-api/src/services/onboarding.service.ts');
    const complete = onboarding.slice(onboarding.indexOf('async complete('));
    const update = complete.slice(0, complete.indexOf('onSetupComplete'));
    expect(update).not.toMatch(/\bmemory\b/);
  });
});

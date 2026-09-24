import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Plan openclaw-9.5-adoption item 3 — every CLI host routes approval-`off`
// capture through the evidence queue when `memoryCapture.evidenceSessions > 0`.
//
// The routing decision itself lives in ONE place, `build-agent-loop.ts`, and
// is pinned through the real composition root by
// `packages/wiring/src/__tests__/memory-evidence-wiring.test.ts`. What a host
// can get wrong is handing that root a config without the key. Every host —
// `ethos chat` (index.ts), `gateway start`, `boot`, `serve`, cron, acp, batch
// — builds its loop through THIS app's `createAgentLoop` (`../wiring`), so this
// file pins two things: that function forwards the key and the approval mode
// untouched, and each host imports it from `../wiring` rather than calling the
// package directly with a hand-built config.
// ---------------------------------------------------------------------------

type PackageCreateAgentLoop = typeof import('@ethosagent/wiring')['createAgentLoop'];

const packageCreateAgentLoop = vi.fn<PackageCreateAgentLoop>();

// Bare stubs, not importOriginal(): the real package is the heaviest graph in
// the repo, and `../wiring` only touches these exports inside functions.
vi.mock('@ethosagent/wiring', () => ({
  EthosObservability: class {},
  FunnelTracker: class {},
  createAgentLoop: packageCreateAgentLoop,
  createLLM: vi.fn(),
}));

let savedStateDir: string | undefined;

beforeAll(() => {
  savedStateDir = process.env.ETHOS_STATE_DIR;
  process.env.ETHOS_STATE_DIR = mkdtempSync(join(tmpdir(), 'ethos-evidence-host-'));
});

afterAll(() => {
  if (savedStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
  else process.env.ETHOS_STATE_DIR = savedStateDir;
});

describe('CLI createAgentLoop — memoryCapture.evidenceSessions reaches the composition root', () => {
  // The budget is the module load of `../wiring` (every command's transitive
  // graph), not the assertion — the same cost `llm-secrets-resolver.test.ts` pays.
  it('forwards evidenceSessions with approval off', async () => {
    packageCreateAgentLoop.mockRejectedValue(new Error('__stubbed__'));
    const { createAgentLoop } = await import('../wiring');

    await expect(
      createAgentLoop({
        provider: 'ollama',
        model: 'offline-test',
        apiKey: '',
        personality: 'operator',
        memoryCapture: { enabled: true, evidenceSessions: 3 },
        memoryApproval: { mode: 'off' },
      }),
    ).rejects.toThrow('__stubbed__');

    const passed = packageCreateAgentLoop.mock.calls[0]?.[0];
    expect(passed?.memoryCapture).toEqual({ enabled: true, evidenceSessions: 3 });
    expect(passed?.memoryApproval).toEqual({ mode: 'off' });
  }, 180_000);

  it.each([
    ['commands/gateway.ts'],
    ['commands/boot.ts'],
    ['commands/serve.ts'],
    ['commands/cron.ts'],
    ['commands/acp.ts'],
    ['commands/batch.ts'],
    ['index.ts'],
  ])('%s builds its loop through ../wiring, never the package directly', (file) => {
    const src = readFileSync(join(import.meta.dirname, '..', file), 'utf8');
    expect(src).toMatch(/\bcreateAgentLoop\b/);
    // No host imports the package's createAgentLoop itself.
    expect(src).not.toMatch(
      /import\s*\{[^}]*\bcreateAgentLoop\b[^}]*\}\s*from\s*'@ethosagent\/wiring'/,
    );
    expect(src).toMatch(/from '\.\.?\/wiring'|import\('\.\/wiring'\)/);
  });
});

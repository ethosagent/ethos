import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EthosErrorCode } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runNightly } from '../nightly';
import { EXIT, type JsonCliHarness, parseOneDoc, setupJsonCli } from './json-cli-harness';

// Task 16 (context-budget-2): `ethos nightly run --json` prints exactly one JSON document.
// A full pass needs a live LLM (judge + drafting), so the success case is the cheapest shape:
// no user personalities means no pass runs and the doc lists none. The per-target shape is a gap.

// The lowest seam: the orchestrator's per-personality pass. A real pass needs a live LLM.
const passMock = vi.hoisted(() => ({ runNightlyPass: vi.fn() }));
vi.mock('@ethosagent/nightly-loop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ethosagent/nightly-loop')>()),
  runNightlyPass: passMock.runNightlyPass,
}));
vi.mock('../../wiring', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../wiring')>()),
  createLLM: async () => ({ model: 'test-model' }),
}));

let h: JsonCliHarness;

beforeEach(async () => {
  h = await setupJsonCli('ethos-nightly-json-');
});

afterEach(async () => {
  await h.teardown();
});

describe('nightly --json', () => {
  it('--json success is one JSON doc', async () => {
    await runNightly(['--json']);
    expect(parseOneDoc(h)).toEqual({ ok: true, personalities: [] });
  });

  it('--json unknown personality is one JSON doc', async () => {
    await expect(runNightly(['ghost', '--json'])).rejects.toThrow(`${EXIT}(1)`);
    const doc = parseOneDoc(h);
    const code: EthosErrorCode = 'PERSONALITY_NOT_FOUND';
    expect(doc.ok).toBe(false);
    expect(doc.error?.code).toBe(code);
    expect(doc.error?.message).toContain('ghost');
  });

  it('--json records a failed pass and still runs the remaining personalities', async () => {
    for (const id of ['alpha', 'beta']) {
      await mkdir(join(h.scopeDir, '..', id), { recursive: true });
      await writeFile(join(h.scopeDir, '..', id, 'SOUL.md'), `# ${id}\n`);
    }
    passMock.runNightlyPass.mockImplementation(async (target: string) => {
      if (target === 'alpha') throw new Error('judge exploded');
      return { windowEnd: '2026-01-01T00:00:00.000Z', steps: [] };
    });
    await runNightly(['--json']);
    const doc = parseOneDoc(h);
    const byId = new Map(
      (doc.personalities as Array<{ personality: string; status: string }>).map((p) => [
        p.personality,
        p,
      ]),
    );
    expect(doc.ok).toBe(true);
    expect(byId.get('alpha')).toMatchObject({
      status: 'failed',
      error: { code: expect.any(String), message: expect.stringContaining('judge exploded') },
    });
    expect(byId.get('beta')).toMatchObject({ status: 'ran' });
  });
});

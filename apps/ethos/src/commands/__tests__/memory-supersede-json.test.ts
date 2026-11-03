import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMemorySupersede } from '../memory-supersede';
import { EXIT, type JsonCliHarness, parseOneDoc, setupJsonCli } from './json-cli-harness';

// Task 14 (context-budget-2): `ethos memory supersede --json` prints exactly one JSON
// document on stdout, for success and for errors.

let h: JsonCliHarness;

beforeEach(async () => {
  h = await setupJsonCli('ethos-memory-supersede-json-');
});

afterEach(async () => {
  await h.teardown();
});

describe('memory supersede --json', () => {
  it('--json success is one JSON doc', async () => {
    await writeFile(
      join(h.scopeDir, 'MEMORY.md'),
      '### old-plan\n\n- ship in May\n\n### new-plan\n\n- ship in June\n',
    );
    await runMemorySupersede(['old-plan', '--by', 'new-plan', '--json']);
    expect(parseOneDoc(h)).toMatchObject({
      ok: true,
      slug: 'old-plan',
      supersededBy: 'new-plan',
      fromKey: 'MEMORY.md',
      personality: 'muse',
    });
  });

  it('--json usage error is one JSON doc', async () => {
    await expect(runMemorySupersede(['old-plan', '--json'])).rejects.toThrow(`${EXIT}(1)`);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(false);
    expect(doc.error?.code).toBe('INVALID_INPUT');
    expect(typeof doc.error?.message).toBe('string');
  });

  it('--json not-found is one JSON doc', async () => {
    await expect(runMemorySupersede(['ghost', '--by', 'new-plan', '--json'])).rejects.toThrow(
      `${EXIT}(1)`,
    );
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(false);
    expect(doc.error?.code).toBe('NOT_FOUND');
    expect(doc.error?.message).toContain('ghost');
  });
});

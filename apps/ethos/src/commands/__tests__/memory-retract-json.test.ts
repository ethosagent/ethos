import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMemoryRetract } from '../memory-retract';
import { EXIT, type JsonCliHarness, parseOneDoc, setupJsonCli } from './json-cli-harness';

// Task 14 (context-budget-2): `ethos memory retract --json` prints exactly one JSON
// document on stdout, for success and for errors.

let h: JsonCliHarness;

beforeEach(async () => {
  h = await setupJsonCli('ethos-memory-retract-json-');
});

afterEach(async () => {
  await h.teardown();
});

describe('memory retract --json', () => {
  it('--json success is one JSON doc', async () => {
    await writeFile(join(h.scopeDir, 'MEMORY.md'), '### wrong\n\n- lives in Paris\n');
    await runMemoryRetract(['wrong', '--reason', 'moved', '--json']);
    expect(parseOneDoc(h)).toMatchObject({
      ok: true,
      slug: 'wrong',
      fromKey: 'MEMORY.md',
      personality: 'muse',
    });
  });

  it('--json usage error is one JSON doc', async () => {
    await expect(runMemoryRetract(['--json'])).rejects.toThrow(`${EXIT}(1)`);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(false);
    expect(doc.error?.code).toBe('INVALID_INPUT');
    expect(typeof doc.error?.message).toBe('string');
  });

  it('--json not-found is one JSON doc', async () => {
    await expect(runMemoryRetract(['ghost', '--json'])).rejects.toThrow(`${EXIT}(1)`);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(false);
    expect(doc.error?.code).toBe('NOT_FOUND');
    expect(doc.error?.message).toContain('ghost');
  });
});

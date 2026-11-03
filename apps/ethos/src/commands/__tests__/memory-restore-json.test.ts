import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMemoryRestore } from '../memory-restore';
import { EXIT, type JsonCliHarness, parseOneDoc, setupJsonCli } from './json-cli-harness';

// Task 14 (context-budget-2): `ethos memory restore --json` prints exactly one JSON
// document on stdout, for success and for errors.

let h: JsonCliHarness;

beforeEach(async () => {
  h = await setupJsonCli('ethos-memory-restore-json-');
});

afterEach(async () => {
  await h.teardown();
});

describe('memory restore --json', () => {
  it('--json success is one JSON doc', async () => {
    await writeFile(
      join(h.scopeDir, 'memory-archive.md'),
      `<!-- archived ${new Date().toISOString()} slug=old-project from=MEMORY.md -->\n### old-project\n\nShipped in 2024.`,
    );
    await runMemoryRestore(['old-project', '--json']);
    expect(parseOneDoc(h)).toMatchObject({
      ok: true,
      slug: 'old-project',
      restoredTo: 'MEMORY.md',
      personality: 'muse',
    });
  });

  it('--json usage error is one JSON doc', async () => {
    await expect(runMemoryRestore(['--json'])).rejects.toThrow(`${EXIT}(1)`);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(false);
    expect(doc.error?.code).toBe('INVALID_INPUT');
    expect(typeof doc.error?.message).toBe('string');
  });

  it('--json not-found is one JSON doc', async () => {
    await expect(runMemoryRestore(['ghost', '--json'])).rejects.toThrow(`${EXIT}(1)`);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(false);
    expect(doc.error?.code).toBe('NOT_FOUND');
    expect(doc.error?.message).toContain('ghost');
  });
});

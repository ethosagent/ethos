import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { EthosError } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPersonalityBirth } from '../personality-birth';
import { type JsonCliHarness, parseOneDoc, setupJsonCli } from './json-cli-harness';

// Task 15 (context-budget-2): `ethos personality birth skip <id> --json` prints exactly one
// JSON document on stdout.

let h: JsonCliHarness;

beforeEach(async () => {
  h = await setupJsonCli('ethos-personality-birth-json-');
});

afterEach(async () => {
  await h.teardown();
});

describe('personality birth --json', () => {
  it('--json success is one JSON doc', async () => {
    const root = dirname(dirname(h.scopeDir));
    await mkdir(join(root, 'learning', 'birth'), { recursive: true });
    await writeFile(join(root, 'learning', 'birth', 'muse.json'), '{}');
    await runPersonalityBirth(['skip', 'muse', '--json']);
    const doc = parseOneDoc(h);
    expect(doc).toMatchObject({ ok: true, personality: 'muse' });
    expect(typeof doc.skipped).toBe('boolean');
  });

  it('--json usage error throws EthosError(INVALID_INPUT) for index.ts to render', async () => {
    const err = await runPersonalityBirth(['skip', '--json']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EthosError);
    expect((err as EthosError).code).toBe('INVALID_INPUT');
    expect(h.stdout()).toBe('');
  });

  it('help --json is one usage doc', async () => {
    await runPersonalityBirth(['help', '--json']);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(true);
    expect(String(doc.usage)).toContain('skip <id>');
  });
});

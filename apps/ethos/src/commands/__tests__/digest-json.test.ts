import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EthosErrorCode } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDigest } from '../digest';
import { EXIT, type JsonCliHarness, parseOneDoc, setupJsonCli } from './json-cli-harness';

// Task 16 (context-budget-2): `ethos digest run --json` prints exactly one JSON document.

let h: JsonCliHarness;

beforeEach(async () => {
  h = await setupJsonCli('ethos-digest-json-');
});

afterEach(async () => {
  await h.teardown();
});

describe('digest --json', () => {
  it('--json success is one JSON doc', async () => {
    await writeFile(join(h.scopeDir, 'config.yaml'), 'name: Muse\n');
    await mkdir(join(h.scopeDir, '..', 'scout'), { recursive: true });
    await runDigest(['run', '--json']);
    const doc = parseOneDoc(h);
    expect(doc).toMatchObject({ ok: true, written: true, email: null });
    expect(doc.path).toEqual(expect.stringContaining('digests'));
    expect(doc.week).toMatch(/^\d{4}-W\d{2}$/);
    expect(doc.personalities).toBeGreaterThan(0);
  });

  it('--json with no user personalities is one written:false doc', async () => {
    await runDigest(['run', '--json']);
    expect(parseOneDoc(h)).toEqual({
      ok: true,
      written: false,
      path: null,
      week: null,
      personalities: 0,
      email: null,
    });
  });

  it('--json usage error is one JSON doc', async () => {
    await expect(runDigest(['--json'])).rejects.toThrow(`${EXIT}(1)`);
    const doc = parseOneDoc(h);
    const code: EthosErrorCode = 'INVALID_INPUT';
    expect(doc.ok).toBe(false);
    expect(doc.error?.code).toBe(code);
  });
});

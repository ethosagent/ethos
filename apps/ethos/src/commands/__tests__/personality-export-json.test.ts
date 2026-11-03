import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { EthosErrorCode } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPersonalityExport } from '../personality-export';
import { EXIT, type JsonCliHarness, parseOneDoc, setupJsonCli } from './json-cli-harness';

// Task 15 (context-budget-2): `ethos personality export --json` prints exactly one JSON
// document on stdout; the archive itself goes to --output.

let h: JsonCliHarness;

beforeEach(async () => {
  h = await setupJsonCli('ethos-personality-export-json-');
});

afterEach(async () => {
  await h.teardown();
});

describe('personality export --json', () => {
  it('--json success is one JSON doc', async () => {
    const root = dirname(dirname(h.scopeDir));
    const dir = join(root, 'personalities', 'demo');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'config.yaml'), 'name: Demo\n');
    await writeFile(join(dir, 'SOUL.md'), '# Demo\n');
    await writeFile(join(dir, 'toolset.yaml'), '- read_file\n');
    const out = join(root, 'bundle.tar.gz');
    await runPersonalityExport(['demo', '--output', out, '--json']);
    const doc = parseOneDoc(h);
    expect(doc).toMatchObject({ ok: true, personality: 'demo', path: out });
    expect(doc.files).toBeGreaterThan(0);
  });

  it('--json with nothing to export is one exported:false doc', async () => {
    const root = dirname(dirname(h.scopeDir));
    await mkdir(join(root, 'personalities', 'researcher'), { recursive: true });
    await runPersonalityExport(['researcher', '--json']);
    expect(parseOneDoc(h)).toMatchObject({
      ok: true,
      personality: 'researcher',
      exported: false,
      path: null,
      files: 0,
    });
  });

  it('--json usage error is one JSON doc', async () => {
    await expect(runPersonalityExport(['--json'])).rejects.toThrow(`${EXIT}(1)`);
    const doc = parseOneDoc(h);
    const code: EthosErrorCode = 'INVALID_INPUT';
    expect(doc.ok).toBe(false);
    expect(doc.error?.code).toBe(code);
  });

  it('--json unknown personality is one JSON doc', async () => {
    await expect(runPersonalityExport(['ghost', '--json'])).rejects.toThrow(`${EXIT}(1)`);
    const doc = parseOneDoc(h);
    const code: EthosErrorCode = 'PERSONALITY_NOT_FOUND';
    expect(doc.error?.code).toBe(code);
    expect(doc.error?.message).toContain('ghost');
  });
});

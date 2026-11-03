import { rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { EthosErrorCode } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runPersonalityEvolve,
  runPersonalityJudge,
  runPersonalityRevert,
} from '../personality-evolve';
import { EXIT, type JsonCliHarness, parseOneDoc, setupJsonCli } from './json-cli-harness';

// Task 15 (context-budget-2): `ethos personality judge --json` prints exactly one JSON document.
// `evolve` and `revert` prompt for confirmation, so under --json they refuse with one
// INVALID_INPUT document instead of prompting.

let h: JsonCliHarness;

beforeEach(async () => {
  h = await setupJsonCli('ethos-personality-evolve-json-');
});

afterEach(async () => {
  await h.teardown();
});

describe('personality judge --json', () => {
  it('--json success is one JSON doc', async () => {
    await writeFile(join(h.scopeDir, 'config.yaml'), 'name: Muse\n');
    await writeFile(join(h.scopeDir, 'SOUL.md'), '# Muse\n');
    await writeFile(join(h.scopeDir, 'toolset.yaml'), '- read_file\n');
    await runPersonalityJudge(['muse', '--json']);
    const doc = parseOneDoc(h);
    expect(doc).toMatchObject({ ok: true, personality: 'muse', judged: false });
    expect(typeof doc.reason).toBe('string');
  });

  it('--json usage error is one JSON doc', async () => {
    await expect(runPersonalityJudge(['--json'])).rejects.toThrow(`${EXIT}(1)`);
    const doc = parseOneDoc(h);
    const code: EthosErrorCode = 'INVALID_INPUT';
    expect(doc.ok).toBe(false);
    expect(doc.error?.code).toBe(code);
  });

  it('--json unknown personality is one JSON doc', async () => {
    await expect(runPersonalityJudge(['ghost', '--json'])).rejects.toThrow(`${EXIT}(1)`);
    const doc = parseOneDoc(h);
    const code: EthosErrorCode = 'PERSONALITY_NOT_FOUND';
    expect(doc.error?.code).toBe(code);
  });
});

describe('personality judge --json, no config', () => {
  it('--json missing config is one CONFIG_MISSING doc', async () => {
    await rm(join(dirname(h.scopeDir), '..', 'config.yaml'), { force: true });
    await writeFile(join(h.scopeDir, 'config.yaml'), 'name: Muse\n');
    await writeFile(join(h.scopeDir, 'SOUL.md'), '# Muse\n');
    await expect(runPersonalityJudge(['muse', '--json'])).rejects.toThrow(`${EXIT}(1)`);
    expect(parseOneDoc(h).error?.code).toBe('CONFIG_MISSING');
  });
});

describe('personality evolve / revert --json', () => {
  it('evolve --json usage error is one JSON doc', async () => {
    await expect(runPersonalityEvolve(['--json'])).rejects.toThrow(`${EXIT}(1)`);
    expect(parseOneDoc(h).error?.code).toBe('INVALID_INPUT');
  });

  it('evolve --json (interactive) is one INVALID_INPUT doc', async () => {
    await expect(runPersonalityEvolve(['muse', '--json'])).rejects.toThrow(`${EXIT}(1)`);
    expect(parseOneDoc(h).error?.code).toBe('INVALID_INPUT');
  });

  it('revert --json usage error is one JSON doc', async () => {
    await expect(runPersonalityRevert(['--json'])).rejects.toThrow(`${EXIT}(1)`);
    expect(parseOneDoc(h).error?.code).toBe('INVALID_INPUT');
  });

  it('revert --json (interactive) is one INVALID_INPUT doc', async () => {
    await expect(runPersonalityRevert(['muse', '--json'])).rejects.toThrow(`${EXIT}(1)`);
    expect(parseOneDoc(h).error?.code).toBe('INVALID_INPUT');
  });
});

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBench } from '../bench';
import { EXIT, type JsonCliHarness, parseOneDoc, setupJsonCli } from './json-cli-harness';

// Task 17 (context-budget-2): `ethos bench context --json` prints exactly one JSON document.
// The harness config is removed so the run takes the "no config" path: built-in personalities,
// static table only, no agent loop and no LLM. runBench ends with process.exit, which the
// harness turns into a throw; the document is written before it. Gap: --live needs a provider.

let h: JsonCliHarness;

beforeEach(async () => {
  h = await setupJsonCli('ethos-bench-json-');
  await rm(join(h.scopeDir, '..', '..', 'config.yaml'));
});

afterEach(async () => {
  await h.teardown();
});

describe('bench --json', () => {
  it('--json success is one JSON doc', async () => {
    await expect(runBench(['context', '--json', '--cwd', h.scopeDir])).rejects.toThrow(
      `${EXIT}(0)`,
    );
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(true);
    expect(doc.cwd).toBe(h.scopeDir);
    expect(doc.static).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: expect.any(String), soulChars: expect.any(Number) }),
      ]),
    );
    expect(doc.warnings).toEqual([]);
    expect(doc.live).toEqual([]);
  });

  it('--json with no subcommand exits 0 with the usage, like text mode', async () => {
    await runBench(['--json']);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(true);
    expect(doc.usage).toEqual(expect.stringContaining('Usage: ethos bench context'));
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('--json usage error is one JSON doc', async () => {
    await expect(runBench(['bogus', '--json'])).rejects.toThrow(`${EXIT}(1)`);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(false);
    expect(doc.error?.code).toBe('INVALID_INPUT');
  });

  it('--json bad flag is one JSON doc', async () => {
    await expect(runBench(['context', '--turns', 'x', '--json'])).rejects.toThrow(`${EXIT}(1)`);
    expect(parseOneDoc(h).error?.code).toBe('INVALID_INPUT');
  });
});

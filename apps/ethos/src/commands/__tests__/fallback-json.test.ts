import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runFallback } from '../fallback';
import {
  EXIT,
  expectNoSecret,
  type JsonCliHarness,
  parseOneDoc,
  setupJsonCli,
} from './json-cli-harness';

// Task 17 (context-budget-2): `ethos fallback --json` prints exactly one JSON document.
// `add` prompts for every field, so it is refused under --json. The harness config has no
// `providers:` chain, which is the "top-level only" shape. Gap: remove/clear success need a
// two-entry chain and the vault; their error paths are pinned, the writes are not.

let h: JsonCliHarness;

beforeEach(async () => {
  h = await setupJsonCli('ethos-fallback-json-');
});

afterEach(async () => {
  await h.teardown();
});

describe('fallback --json', () => {
  it('--json success is one JSON doc (list)', async () => {
    await runFallback(['--json']);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(true);
    expect(doc.active).toBe('top-level');
    expect(doc.primary).toMatchObject({ provider: 'anthropic', model: 'claude-test' });
    expect(doc.chain).toEqual([]);
    // The key is masked, never the plaintext sk-test.
    expectNoSecret(h, 'sk-test');
  });

  it('--json success is one JSON doc (clear on an empty chain)', async () => {
    await runFallback(['clear', '--json']);
    expect(parseOneDoc(h)).toEqual({ ok: true, cleared: 0, secretsNotDeleted: [] });
  });

  it('--json usage error is one JSON doc', async () => {
    await expect(runFallback(['remove', 'x', '--json'])).rejects.toThrow(`${EXIT}(1)`);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(false);
    expect(doc.error?.code).toBe('INVALID_INPUT');
  });

  it('--json remove out of range is one JSON doc', async () => {
    await expect(runFallback(['remove', '3', '--json'])).rejects.toThrow(`${EXIT}(1)`);
    expect(parseOneDoc(h).error?.code).toBe('INVALID_INPUT');
  });

  it('--json add is refused (it prompts)', async () => {
    await expect(runFallback(['add', '--json'])).rejects.toThrow(`${EXIT}(1)`);
    expect(parseOneDoc(h).error?.code).toBe('INVALID_INPUT');
  });
});

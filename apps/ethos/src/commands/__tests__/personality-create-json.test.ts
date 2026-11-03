import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPersonalityCreate } from '../personality-create';
import { EXIT, type JsonCliHarness, parseOneDoc, setupJsonCli } from './json-cli-harness';

// Task 15 (context-budget-2): `ethos personality create --json` prints exactly one JSON
// document on stdout. The AI-assisted chat path is interactive and refuses --json.

let h: JsonCliHarness;

beforeEach(async () => {
  h = await setupJsonCli('ethos-personality-create-json-');
});

afterEach(async () => {
  await h.teardown();
});

describe('personality create --json', () => {
  it('--json success is one JSON doc', async () => {
    await runPersonalityCreate(['Scout', '--blank', '--json']);
    const doc = parseOneDoc(h);
    expect(doc).toMatchObject({ ok: true, id: 'scout' });
    expect(doc.path).toBe(join(dirname(h.scopeDir), 'scout'));
    await access(join(dirname(h.scopeDir), 'scout', 'SOUL.md'));
  });

  it('--json --from success is one JSON doc', async () => {
    await runPersonalityCreate(['Copy', '--from', 'researcher', '--json']);
    expect(parseOneDoc(h)).toMatchObject({ ok: true, id: 'copy', from: 'researcher' });
  });

  it('--json usage error is one JSON doc', async () => {
    await expect(runPersonalityCreate(['--blank', '--json'])).rejects.toThrow(`${EXIT}(1)`);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(false);
    expect(doc.error?.code).toBe('INVALID_INPUT');
  });

  it('--json without --blank/--from (interactive chat) is one INVALID_INPUT doc', async () => {
    await expect(runPersonalityCreate(['Scout', '--json'])).rejects.toThrow(`${EXIT}(1)`);
    const doc = parseOneDoc(h);
    expect(doc.error?.code).toBe('INVALID_INPUT');
  });

  it('--json duplicate id throws PERSONALITY_EXISTS for index.ts to render', async () => {
    await runPersonalityCreate(['Scout', '--blank', '--json']);
    const err = await runPersonalityCreate(['Scout', '--blank', '--json']).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'PERSONALITY_EXISTS' });
    expect(h.stdout().trim().split('\n')).toHaveLength(1);
  });
});

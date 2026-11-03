import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSet } from '../set';
import { EXIT, type JsonCliHarness, parseOneDoc, setupJsonCli } from './json-cli-harness';

// Task 17 (context-budget-2): `ethos set --json` prints exactly one JSON document.

// teamsDir() is homedir-based; point it at the temp state dir so no test touches the real ~/.ethos.
const teamsLoc = vi.hoisted(() => ({ dir: '' }));
vi.mock('@ethosagent/team-supervisor', () => ({ teamsDir: () => teamsLoc.dir }));

let h: JsonCliHarness;

beforeEach(async () => {
  h = await setupJsonCli('ethos-set-json-');
  teamsLoc.dir = join(h.scopeDir, '..', '..', 'teams');
});

afterEach(async () => {
  await h.teardown();
});

describe('set --json', () => {
  it('--json success is one JSON doc (show current, also reached by a bare --json)', async () => {
    await runSet(['--json']);
    expect(parseOneDoc(h)).toEqual({ ok: true, personality: 'muse', activeContext: null });
  });

  it('--json success is one JSON doc (set personality)', async () => {
    await runSet(['personality', 'scout', '--json']);
    expect(parseOneDoc(h)).toEqual({ ok: true, kind: 'personality', name: 'scout' });
  });

  it('--json success is one JSON doc (set team)', async () => {
    await mkdir(teamsLoc.dir, { recursive: true });
    await writeFile(join(teamsLoc.dir, 'crew.yaml'), 'name: crew\n');
    await runSet(['team', 'crew', '--json']);
    expect(parseOneDoc(h)).toEqual({ ok: true, kind: 'team', name: 'crew' });
  });

  it('--json usage error is one JSON doc', async () => {
    await expect(runSet(['personality', '--json'])).rejects.toThrow(`${EXIT}(1)`);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(false);
    expect(doc.error?.code).toBe('INVALID_INPUT');
  });

  it('--json unknown team throws FILE_NOT_FOUND for the top-level catch', async () => {
    await expect(runSet(['team', 'ghost', '--json'])).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
    });
    expect(h.stdout()).toBe('');
  });
});

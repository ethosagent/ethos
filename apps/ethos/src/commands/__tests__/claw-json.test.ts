import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runClaw } from '../claw';
import { EXIT, type JsonCliHarness, parseOneDoc, setupJsonCli } from './json-cli-harness';

// Task 17 (context-budget-2): `ethos claw migrate --json` prints exactly one JSON document.
// The migrator is a double (the real one reads ~/.openclaw). It prompts for confirmation, so
// --json requires --yes or --dry-run (refuseJson).

const migrator = vi.hoisted(() => ({
  exists: true,
  ops: [{ kind: 'copy-memory', label: 'MEMORY.md' }],
}));

vi.mock('@ethosagent/claw-migrate', () => ({
  ClawMigrator: class {
    source = '/fake/.openclaw';
    async sourceExists() {
      return migrator.exists;
    }
    async plan() {
      return {
        source: '/fake/.openclaw',
        target: '/fake/.ethos',
        workspace: '/fake/ws',
        ops: migrator.ops,
        detected: { agents: false },
        summary: { memories: migrator.ops.length, skills: 0, platformTokens: 0, apiKeys: 0 },
        personality: { requested: null, resolved: 'researcher', becomesMigrated: false },
      };
    }
    async execute() {
      return {
        copied: 1,
        skipped: 1,
        failed: 1,
        items: [
          { label: 'MEMORY.md', status: 'copied' },
          { label: 'skill-a', status: 'skipped', reason: 'exists' },
          { label: 'key', status: 'failed', reason: 'boom' },
        ],
      };
    }
  },
}));

let h: JsonCliHarness;

beforeEach(async () => {
  h = await setupJsonCli('ethos-claw-json-');
  migrator.exists = true;
  migrator.ops = [{ kind: 'copy-memory', label: 'MEMORY.md' }];
});

afterEach(async () => {
  await h.teardown();
});

describe('claw --json', () => {
  it('--json --yes success is one JSON doc with per-item statuses', async () => {
    await runClaw(['migrate', '--yes', '--json']);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(true);
    expect(doc.dryRun).toBe(false);
    expect(doc.failed).toBe(1);
    expect(doc.items).toEqual([
      { label: 'MEMORY.md', status: 'copied' },
      { label: 'skill-a', status: 'skipped', reason: 'exists' },
      { label: 'key', status: 'failed', reason: 'boom' },
    ]);
    expect(doc.plan).toMatchObject({ source: '/fake/.openclaw', ops: migrator.ops });
  });

  it('--json --dry-run success is one JSON doc and needs no --yes', async () => {
    await runClaw(['migrate', '--dry-run', '--json']);
    expect(parseOneDoc(h)).toMatchObject({ ok: true, dryRun: true });
  });

  it('--json with nothing to migrate is one JSON doc', async () => {
    migrator.ops = [];
    await runClaw(['migrate', '--yes', '--json']);
    expect(parseOneDoc(h)).toMatchObject({ ok: true, items: [] });
  });

  it('--json usage error is one JSON doc', async () => {
    await expect(runClaw(['bogus', '--json'])).rejects.toThrow(`${EXIT}(1)`);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(false);
    expect(doc.error?.code).toBe('INVALID_INPUT');
  });

  it('--json without --yes is refused as one JSON doc', async () => {
    await expect(runClaw(['migrate', '--json'])).rejects.toThrow(`${EXIT}(1)`);
    expect(parseOneDoc(h).error?.code).toBe('INVALID_INPUT');
  });

  it('--json with no OpenClaw install is one JSON doc', async () => {
    migrator.exists = false;
    await expect(runClaw(['migrate', '--yes', '--json'])).rejects.toThrow(`${EXIT}(1)`);
    expect(parseOneDoc(h).error?.code).toBe('FILE_NOT_FOUND');
  });
});

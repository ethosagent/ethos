import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FilePersonalityRegistry, renderCharacterSheet } from '@ethosagent/personalities';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `ethos-diff-${Date.now()}-${randomBytes(4).toString('hex')}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function seedPersonality(
  id: string,
  config: string,
  soulMd = `# ${id}\n\nIdentity text.\n`,
  toolset = '- read_file\n',
): Promise<void> {
  const dir = join(testDir, 'personalities', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'config.yaml'), config);
  await writeFile(join(dir, 'SOUL.md'), soulMd);
  await writeFile(join(dir, 'toolset.yaml'), toolset);
}

function makeRegistry(): FilePersonalityRegistry {
  return new FilePersonalityRegistry(new FsStorage(), testDir);
}

describe('personality diff', () => {
  it('produces identical sheets for same config rendered twice', async () => {
    await seedPersonality('alpha', 'name: Alpha\ndescription: Same thing\n');

    const reg = makeRegistry();
    await reg.loadFromDirectory(join(testDir, 'personalities'));

    const desc = reg.describe('alpha');
    expect(desc).not.toBeNull();
    if (!desc) return;

    const soul = await reg.readSoulMd('alpha');
    const sheetA = renderCharacterSheet(desc.config, soul);
    const sheetB = renderCharacterSheet(desc.config, soul);
    expect(sheetA).toBe(sheetB);
  });

  it('detects differences between two distinct personalities', async () => {
    await seedPersonality(
      'engineer',
      'name: Engineer\ndescription: Writes code\nmodel: claude-sonnet-4-6\n',
      '# Engineer\n\nI write working code.\n',
      '- read_file\n- write_file\n- terminal\n',
    );
    await seedPersonality(
      'researcher',
      'name: Researcher\ndescription: Deep analysis\nmodel: claude-opus-4\n',
      '# Researcher\n\nI analyze problems deeply.\n',
      '- read_file\n- web_search\n',
    );

    const reg = makeRegistry();
    await reg.loadFromDirectory(join(testDir, 'personalities'));

    const descA = reg.describe('engineer');
    const descB = reg.describe('researcher');
    expect(descA).not.toBeNull();
    expect(descB).not.toBeNull();
    if (!descA || !descB) return;

    const soulA = await reg.readSoulMd('engineer');
    const soulB = await reg.readSoulMd('researcher');

    const sheetA = renderCharacterSheet(descA.config, soulA);
    const sheetB = renderCharacterSheet(descB.config, soulB);

    expect(sheetA).not.toBe(sheetB);
    expect(sheetA).toContain('engineer');
    expect(sheetB).toContain('researcher');
  });

  it('returns null for unknown personality id', async () => {
    await seedPersonality('alpha', 'name: Alpha\n');

    const reg = makeRegistry();
    await reg.loadFromDirectory(join(testDir, 'personalities'));

    const desc = reg.describe('nonexistent');
    expect(desc).toBeNull();
  });
});

// P-T3 — `ethos personality diff` classifies permission changes over the
// structured surface. Driven as a REAL process, like
// `personality-show-mcp-export.test.ts`: `apps/ethos/src/index.ts` dispatches at
// module top level, so there is no exported function to call.
describe('ethos personality diff — classified permission changes (P-T3)', () => {
  const run = promisify(execFile);
  const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

  async function diffOutput(a: string, b: string): Promise<string> {
    const result = await run(
      process.execPath,
      ['--import', 'tsx', join(ROOT, 'apps/ethos/src/index.ts'), 'personality', 'diff', a, b],
      {
        cwd: ROOT,
        env: { ...process.env, ETHOS_STATE_DIR: testDir, NO_COLOR: '1' },
        timeout: 240_000,
      },
    );
    return result.stdout;
  }

  async function seedState(): Promise<void> {
    // A dead `baseUrl` keeps the export case hermetic: the loop is built only
    // for its tool registry, never to answer anything.
    await writeFile(
      join(testDir, 'config.yaml'),
      [
        'schemaVersion: 1',
        'provider: anthropic',
        'baseUrl: http://127.0.0.1:1',
        'model: test',
        'personality: gated',
        '',
      ].join('\n'),
    );
  }

  it('marks a widening change', async () => {
    await seedState();
    await seedPersonality('gated', 'name: Gated\noutbound_policy.approve_before_send: true\n');
    await seedPersonality(
      'ungated',
      'name: Ungated\noutbound_policy.approve_before_send: false\n',
      undefined,
      '- read_file\n- terminal\n',
    );

    const out = await diffOutput('gated', 'ungated');
    expect(out).toContain('Permission changes: gated → ungated — 2 widen, 0 narrow, 0 other');
    expect(out).toContain('  + WIDENS   toolset: + terminal');
    expect(out).toContain('  + WIDENS   outbound_policy.approve_before_send: true → false');
    // The text diff still follows the classified rows.
    expect(out).toContain('+++ ungated');
  }, 300_000);

  it('classifies an export from the resolved slice', async () => {
    await seedState();
    await seedPersonality('gated', 'name: Gated\n');
    await seedPersonality(
      'exporter',
      'name: Exporter\nmcp_export.enabled: true\nmcp_export.expose_tools: read_file\n',
    );

    const out = await diffOutput('gated', 'exporter');
    expect(out).toContain(
      '  + WIDENS   mcp_export.enabled: not exported → exported (tools: read_file; memory none; conversations not exposed; auth localhost)',
    );
  }, 300_000);
});

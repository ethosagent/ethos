// Pins commands/sessions-repair.ts (plan session-db-repair 5.4, 5.6).

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EthosError } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSessionsCommand } from '../sessions';
import { runSessionsRepair } from '../sessions-repair';
import { blankFtsBlocks, seedSessionsDb, smashHeap } from './sessions-db-fixture';

let dir: string;
let lines: string[];
const out = (l: string) => lines.push(l);
const run = (argv: string[], confirm?: (q: string) => Promise<boolean>) =>
  runSessionsRepair(argv, { dataDir: dir, out, ...(confirm ? { confirm } : {}) });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sessions-repair-cli-'));
  lines = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function captureJson(): () => Record<string, unknown> {
  const spy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  return () => JSON.parse(String(spy.mock.calls[0]?.[0])) as Record<string, unknown>;
}

interface JsonFailure {
  ok: boolean;
  error: { code: string; message: string };
}

describe('ethos sessions repair', () => {
  it('check prints the plan and exits 1 on findings', async () => {
    const db = await seedSessionsDb(dir);
    blankFtsBlocks(db);
    expect(await run([])).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain('Class: fts');
    expect(text).toContain('ethos sessions repair --apply');
    expect(text).toContain('rebuild messages_fts');
  });

  it('check leaves the file untouched and exits 0 when healthy', async () => {
    const db = await seedSessionsDb(dir);
    const before = { bytes: readFileSync(db), mtime: statSync(db).mtimeMs };
    expect(await run([])).toBe(0);
    expect(lines.join('\n')).toContain('healthy');
    expect(readFileSync(db).equals(before.bytes)).toBe(true);
    expect(statSync(db).mtimeMs).toBe(before.mtime);
  });

  it('a missing sessions.db is healthy', async () => {
    expect(await run([])).toBe(0);
    expect(lines.join('\n')).toContain('No sessions.db yet');
  });

  it('--json is one object with the documented keys', async () => {
    const db = await seedSessionsDb(dir);
    blankFtsBlocks(db);
    const read = captureJson();
    expect(await run(['--json'])).toBe(1);
    const doc = read();
    for (const k of [
      'ok',
      'database',
      'classification',
      'integrity',
      'fts',
      'rows',
      'plan',
      'applied',
    ]) {
      expect(doc).toHaveProperty(k);
    }
    expect(doc.ok).toBe(false);
    expect(doc.classification).toBe('fts');
    expect(doc.plan).toEqual(['rebuild_fts']);
    expect(doc.applied).toBeNull();
  });

  it('--apply without --yes prompts and cancels on N', async () => {
    const db = await seedSessionsDb(dir);
    blankFtsBlocks(db);
    const confirm = vi.fn(async () => false);
    expect(await run(['--apply'], confirm)).toBe(1); // declined on a damaged file
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(lines).toContain('Cancelled.');
    expect(readdirSync(dir).includes('.pre-repair')).toBe(false);
    expect(await run([])).toBe(1); // still damaged
  });

  it('exit 0 and verified:true after a repaired FTS', async () => {
    const db = await seedSessionsDb(dir);
    blankFtsBlocks(db);
    const read = captureJson();
    expect(await run(['--apply', '--yes', '--json'])).toBe(0);
    const doc = read() as {
      ok: boolean;
      applied: { verified: boolean; actions: string[]; copy: string };
    };
    expect(doc.ok).toBe(true);
    expect(doc.applied.verified).toBe(true);
    expect(doc.applied.actions).toEqual(['rebuild_fts']);
    expect(readdirSync(join(dir, '.pre-repair')).length).toBe(1);
    vi.restoreAllMocks();
    expect(await run([])).toBe(0);
  });

  /** Run `argv` with `process.exit` trapped; returns the JSON error document and exit code. */
  async function jsonFailure(argv: string[]): Promise<{ doc: JsonFailure; code: number }> {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
      throw new Error(`exit:${c}`);
    }) as never);
    await expect(run(argv)).rejects.toThrow(/^exit:/);
    const doc = JSON.parse(String(write.mock.calls[0]?.[0])) as JsonFailure;
    return { doc, code: exit.mock.calls[0]?.[0] as number };
  }

  it('--json: heap damage on --apply is a DB_CORRUPT JSON error, exit 1', async () => {
    const db = await seedSessionsDb(dir, 5000);
    smashHeap(db);
    const { doc, code } = await jsonFailure(['--apply', '--yes', '--json']);
    expect(code).toBe(1);
    expect(doc.ok).toBe(false);
    expect(doc.error.code).toBe('DB_CORRUPT');
  });

  it('--json: an unknown flag is an INVALID_INPUT JSON error', async () => {
    const { doc, code } = await jsonFailure(['--force', '--json']);
    expect(code).toBe(1);
    expect(doc.error.code).toBe('INVALID_INPUT');
  });

  it('--json: --apply without --yes is an INVALID_INPUT JSON error', async () => {
    const { doc } = await jsonFailure(['--apply', '--json']);
    expect(doc.ok).toBe(false);
    expect(doc.error.code).toBe('INVALID_INPUT');
  });

  it('--json: a garbage file under --apply --yes is a JSON error, never DB_BUSY', async () => {
    writeFileSync(join(dir, 'sessions.db'), Buffer.alloc(8192, 0x41));
    const { doc } = await jsonFailure(['--apply', '--yes', '--json']);
    expect(doc.ok).toBe(false);
    expect(doc.error.code).not.toBe('DB_BUSY');
  });

  it('runSessionsCommand repair leaves an old-schema file unmigrated', async () => {
    const db = join(dir, 'sessions.db');
    const raw = new DatabaseSync(db);
    raw.exec(
      'CREATE TABLE sessions (id TEXT PRIMARY KEY, key TEXT); CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp TEXT);',
    );
    raw.close();
    const snapshot = () => {
      const d = new DatabaseSync(db, { readOnly: true });
      const schema = d.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all();
      const version = d.prepare('PRAGMA user_version').get();
      d.close();
      return { schema, version, bytes: readFileSync(db), mtime: statSync(db).mtimeMs };
    };
    const before = snapshot();
    expect((before.version as { user_version: number }).user_version).toBe(0);
    vi.stubEnv('ETHOS_STATE_DIR', dir);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const prev = process.exitCode;
    try {
      await runSessionsCommand('repair', []);
    } finally {
      process.exitCode = prev;
      vi.unstubAllEnvs();
    }
    const after = snapshot();
    expect(after.schema).toEqual(before.schema);
    expect(after.version).toEqual(before.version);
    expect(after.mtime).toBe(before.mtime);
    expect(after.bytes.equals(before.bytes)).toBe(true);
  });

  it('--apply on heap damage throws DB_CORRUPT naming ethos import', async () => {
    const db = await seedSessionsDb(dir, 5000);
    smashHeap(db);
    const err = await run(['--apply', '--yes']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EthosError);
    expect((err as EthosError).code).toBe('DB_CORRUPT');
    expect((err as EthosError).action).toContain('ethos import <archive>');
  });

  it('unknown flag is INVALID_INPUT', async () => {
    const err = await run(['--force']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EthosError);
    expect((err as EthosError).code).toBe('INVALID_INPUT');
  });

  it('no raw Error is thrown by the command file', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'sessions-repair.ts'), 'utf8');
    expect(src).not.toMatch(/new Error\(/);
  });
});

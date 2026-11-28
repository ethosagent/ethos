// Pins commands/sessions-share.ts and the `sessions delete` revoke hook (plan share-links Lane G,
// §3 CLI, D4, D7, D13, §10). Real stores under a temp ETHOS_STATE_DIR; the refusal logic itself is
// wiring's publishShare (packages/wiring/src/__tests__/share-publish.test.ts), so these cases pin
// the CLI mapping, the copy-once output and the loopback warning.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { EthosError } from '@ethosagent/types';
import { SqliteShareLinkStore, shareLinksDbPath } from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSessionsCommand } from '../sessions';

let dir: string;
let sessionId: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let outSpy: ReturnType<typeof vi.spyOn>;
const prev = {
  state: process.env.ETHOS_STATE_DIR,
  host: process.env.ETHOS_WEB_HOST,
  port: process.env.ETHOS_WEB_PORT,
  tool: process.env.ETHOS_TOOL_PROCESS,
};

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  estimatedCostUsd: 0,
  apiCallCount: 0,
  compactionCount: 0,
};

function writeConfig(...extra: string[]): void {
  writeFileSync(
    join(dir, 'config.yaml'),
    ['provider: anthropic', 'model: claude-sonnet-5', 'apiKey: sk-test', ...extra].join('\n'),
  );
}

let seq = 0;
async function seedSession(
  metadata?: Record<string, unknown>,
  title = 'Plan the launch',
): Promise<string> {
  const store = new SQLiteSessionStore(join(dir, 'sessions.db'));
  try {
    const s = await store.createSession({
      key: `cli:demo-${++seq}`,
      platform: 'cli',
      model: 'm',
      provider: 'p',
      personalityId: 'researcher',
      title,
      usage,
      ...(metadata ? { metadata } : {}),
    });
    await store.appendMessage({ sessionId: s.id, role: 'user', content: 'What is the plan?' });
    await store.appendMessage({ sessionId: s.id, role: 'assistant', content: 'Ship on Friday.' });
    return s.id;
  } finally {
    store.close();
  }
}

const printed = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
const stdout = () => printed(logSpy) + printed(outSpy);
const stderr = () => printed(errSpy);
const run = (...argv: string[]) => runSessionsCommand('share', argv);
const lastJson = (): unknown => {
  const call = outSpy.mock.calls.at(-1)?.[0];
  return JSON.parse(String(call));
};
const tokenOf = (output: string): string => {
  const m = /\/share\/(\S+)/.exec(output);
  if (!m?.[1]) throw new Error(`no share url in output:\n${output}`);
  return m[1];
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ethos-sessions-share-'));
  process.env.ETHOS_STATE_DIR = dir;
  delete process.env.ETHOS_WEB_HOST;
  delete process.env.ETHOS_WEB_PORT;
  delete process.env.ETHOS_TOOL_PROCESS;
  writeConfig('shareLinks.enabled: true');
  sessionId = await seedSession();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  outSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  for (const [key, name] of [
    ['state', 'ETHOS_STATE_DIR'],
    ['host', 'ETHOS_WEB_HOST'],
    ['port', 'ETHOS_WEB_PORT'],
    ['tool', 'ETHOS_TOOL_PROCESS'],
  ] as const) {
    if (prev[key] === undefined) delete process.env[name];
    else process.env[name] = prev[key];
  }
});

function rows(): ShareRow[] {
  const store = new SqliteShareLinkStore(shareLinksDbPath(dir));
  try {
    return store.list({ activeOnly: false });
  } finally {
    store.close();
  }
}
type ShareRow = ReturnType<SqliteShareLinkStore['list']>[number];

async function expectRefusal(code: string, ...argv: string[]): Promise<EthosError> {
  const err = await run(...argv).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(EthosError);
  if (!(err instanceof EthosError)) throw new Error('unreachable');
  expect(err.code).toBe(code);
  return err;
}

describe('ethos sessions share <id>', () => {
  it('prints the URL exactly once with prefix, expiry and the copy-once notice; the row has no token', async () => {
    await run(sessionId);
    const out = stdout();
    expect(out.match(/\/share\//g)).toHaveLength(1);
    const token = tokenOf(out);
    expect(out).toContain("You won't see this link again");
    const [row] = rows();
    expect(row?.prefix).toBe(token.slice(0, 8));
    expect(out).toContain(`prefix ${row?.prefix}`);
    expect(out).toContain(`expires ${row?.expiresAt}`);
    expect(JSON.stringify(row)).not.toContain(token);
    // default expiry is 7d
    const days = (Date.parse(row?.expiresAt ?? '') - Date.parse(row?.createdAt ?? '')) / 86_400_000;
    expect(days).toBeCloseTo(7, 1);
  });

  it('honours --expires and rejects an unknown value', async () => {
    await run(sessionId, '--expires', '1h');
    const [row] = rows();
    const hours = (Date.parse(row?.expiresAt ?? '') - Date.parse(row?.createdAt ?? '')) / 3_600_000;
    expect(hours).toBeCloseTo(1, 1);
    await expectRefusal('INVALID_INPUT', sessionId, '--expires', '2d');
    expect(rows()).toHaveLength(1);
  });

  it('refuses with NOT_CONFIGURED when the feature is off, and stores nothing', async () => {
    writeConfig();
    await expectRefusal('NOT_CONFIGURED', sessionId);
    expect(rows()).toHaveLength(0);
  });

  it('refuses a shared-room or incognito session', async () => {
    const shared = await seedSession({ roomAudience: 'shared' });
    await expectRefusal('FORBIDDEN', shared);
    expect(rows()).toHaveLength(0);
  });

  it('refuses an excluded personality and an unknown session', async () => {
    writeConfig('shareLinks.enabled: true', 'shareLinks.excludePersonalities: researcher');
    await expectRefusal('FORBIDDEN', sessionId);
    await expectRefusal('SESSION_NOT_FOUND', 'no-such-session');
  });

  it('warns for a loopback base, in text mode on stdout', async () => {
    await run(sessionId);
    expect(stdout()).toContain('http://127.0.0.1:3000/share/');
    expect(stdout()).toContain(
      'Opens only on this machine — set webBaseUrl and expose the port to share',
    );
  });

  it('does not warn when webBaseUrl is a public https origin, and builds the URL on it', async () => {
    writeConfig('shareLinks.enabled: true', 'webBaseUrl: https://ethos.example.com');
    await run(sessionId);
    expect(stdout()).toContain('https://ethos.example.com/share/');
    expect(stdout()).not.toContain('Opens only on this machine');
    expect(stderr()).not.toContain('Opens only on this machine');
  });

  it('follows the bind host/port `ethos serve` would use; a wildcard bind reads as this machine', async () => {
    process.env.ETHOS_WEB_HOST = '0.0.0.0';
    process.env.ETHOS_WEB_PORT = '4100';
    await run(sessionId);
    expect(stdout()).toContain('http://localhost:4100/share/');
    expect(stdout()).not.toContain('0.0.0.0');
    expect(stdout()).toContain('Opens only on this machine');
  });

  it('a LAN bind builds the URL on that host with no loopback warning', async () => {
    process.env.ETHOS_WEB_HOST = '192.168.1.5';
    process.env.ETHOS_WEB_PORT = '4100';
    await run(sessionId);
    expect(stdout()).toContain('http://192.168.1.5:4100/share/');
    expect(stdout()).not.toContain('Opens only on this machine');
  });

  it('D12: create refuses inside a tool process (ETHOS_TOOL_PROCESS=1) and stores nothing', async () => {
    process.env.ETHOS_TOOL_PROCESS = '1';
    const err = await expectRefusal('FORBIDDEN', sessionId, '--no-pii', '--json');
    expect(err.cause).toContain('ETHOS_TOOL_PROCESS=1');
    expect(err.action).toContain('tripwire');
    expect(stdout()).not.toContain('/share/');
    expect(rows()).toHaveLength(0);
  });

  it('D12: list and revoke still work inside a tool process (killing a link is always allowed)', async () => {
    await run(sessionId);
    const prefix = tokenOf(stdout()).slice(0, 8);
    process.env.ETHOS_TOOL_PROCESS = '1';
    logSpy.mockClear();
    await run('list');
    expect(stdout()).toContain(prefix);
    await run('revoke', prefix);
    expect(rows().filter((r) => r.revokedAt === null)).toHaveLength(0);
  });

  it('--json prints one document with url/prefix/expiresAt/loopback and warns on stderr', async () => {
    await run(sessionId, '--json');
    const doc = lastJson() as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(['expiresAt', 'loopback', 'prefix', 'url']);
    expect(doc.loopback).toBe(true);
    expect(String(doc.url)).toMatch(/^http:\/\/127\.0\.0\.1:3000\/share\//);
    expect(outSpy.mock.calls).toHaveLength(1);
    expect(printed(logSpy)).toBe('');
    expect(stderr()).toContain('Opens only on this machine');
  });
});

describe('ethos sessions share list / revoke', () => {
  it('list shows title, prefix, created, expires, views and last viewed, never the token', async () => {
    await run(sessionId);
    const token = tokenOf(stdout());
    logSpy.mockClear();
    outSpy.mockClear();
    await run('list');
    const out = stdout();
    expect(out).toContain(token.slice(0, 8));
    expect(out).toContain('Plan the launch');
    expect(out).toMatch(/created .*expires .*views 0 {2}last viewed never/);
    expect(out).not.toContain(token);
  });

  it('list --json is an array without tokens or snapshots', async () => {
    await run(sessionId);
    const token = tokenOf(stdout());
    outSpy.mockClear();
    await run('list', '--json');
    const doc = lastJson() as Array<Record<string, unknown>>;
    expect(doc).toHaveLength(1);
    expect(Object.keys(doc[0] ?? {}).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'id',
      'lastViewedAt',
      'prefix',
      'sessionId',
      'title',
      'viewCount',
    ]);
    expect(JSON.stringify(doc)).not.toContain(token);
  });

  it('revoke by prefix removes the link from later lists; unknown prefix is NOT_FOUND', async () => {
    await run(sessionId);
    const prefix = tokenOf(stdout()).slice(0, 8);
    logSpy.mockClear();
    await run('revoke', prefix);
    expect(stdout()).toContain(`Revoked  ${prefix}`);
    logSpy.mockClear();
    await run('list');
    expect(stdout()).toContain('No active share links.');
    await expectRefusal('NOT_FOUND', 'revoke', 'zzzzzzzz');
  });

  it('revoke --json prints {revoked, id, prefix}', async () => {
    await run(sessionId);
    const prefix = tokenOf(stdout()).slice(0, 8);
    outSpy.mockClear();
    await run('revoke', prefix, '--json');
    expect(lastJson()).toMatchObject({ revoked: true, prefix });
  });

  it('refuses an ambiguous prefix and a too-short prefix', async () => {
    await run(sessionId);
    await run(sessionId);
    const [a, b] = rows();
    expect(a && b).toBeTruthy();
    // Both tokens are random, so share a prefix by rewriting the cleartext column.
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(shareLinksDbPath(dir));
    raw.exec("UPDATE share_links SET prefix = 'aaaa0000'");
    raw.close();
    const ambiguous = await expectRefusal('INVALID_INPUT', 'revoke', 'aaaa');
    expect(ambiguous.cause).toContain('Multiple share links');
    const short = await expectRefusal('INVALID_INPUT', 'revoke', 'aa');
    expect(short.cause).toContain('too short');
    expect(rows().filter((r) => r.revokedAt !== null)).toHaveLength(0);
  });
});

describe('terminal-control characters in titles', () => {
  it('list and revoke print a title with ANSI and newlines as inert text', async () => {
    const evil = await seedSession(undefined, 'Plan\x1b[31mRED\x1b[0m\nRevoked  deadbeef  fake');
    await run(evil);
    const prefix = tokenOf(stdout()).slice(0, 8);
    logSpy.mockClear();
    await run('list');
    const listed = stdout();
    expect(listed).not.toContain('\x1b');
    expect(listed).not.toContain('\nRevoked  deadbeef');
    logSpy.mockClear();
    await run('revoke', prefix);
    expect(stdout()).not.toContain('\x1b');
    expect(stdout().trimEnd().split('\n')).toHaveLength(1);
  });
});

describe('ethos sessions delete', () => {
  it("revokes that session's links and says how many", async () => {
    const other = await seedSession();
    await run(sessionId);
    await run(sessionId);
    await run(other);
    logSpy.mockClear();
    await runSessionsCommand('delete', [sessionId, '--yes']);
    expect(stdout()).toContain(`Deleted: ${sessionId}`);
    expect(stdout()).toContain('Revoked 2 share links.');
    const live = rows().filter((r) => r.revokedAt === null);
    expect(live.map((r) => r.subjectId)).toEqual([other]);
  });

  it('says nothing about links when there were none, and reports nothing', async () => {
    await runSessionsCommand('delete', [sessionId, '--yes']);
    expect(stdout()).not.toContain('share link');
  });

  it('revokes before it deletes: a revoke failure leaves the session intact and throws', async () => {
    await run(sessionId);
    // A corrupt share-links.db makes the store constructor throw — the failing revoke.
    writeFileSync(shareLinksDbPath(dir), 'not a sqlite database'.repeat(50));
    const err = await runSessionsCommand('delete', [sessionId, '--yes']).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EthosError);
    expect(String((err as EthosError).cause)).toContain('session was not deleted');
    expect(stdout()).not.toContain('Deleted:');
    const sessions = new SQLiteSessionStore(join(dir, 'sessions.db'));
    try {
      expect(await sessions.getSession(sessionId)).not.toBeNull();
    } finally {
      sessions.close();
    }
  });

  it('unknown id is SESSION_NOT_FOUND and opens no share store', async () => {
    const dbPath = shareLinksDbPath(dir);
    writeFileSync(dbPath, 'not a sqlite database'.repeat(50)); // would throw if opened
    const err = await runSessionsCommand('delete', ['no-such-session', '--yes']).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EthosError);
    expect((err as EthosError).code).toBe('SESSION_NOT_FOUND');
  });
});

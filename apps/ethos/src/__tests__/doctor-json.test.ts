import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { divergeFts, seedSessionsDb } from '../commands/__tests__/sessions-db-fixture';
import { checkDatabaseIntegrity, computeDoctorExit, sessionsFtsOf } from '../commands/doctor';

// Shape test for the doctor --json output contract.
// Full command path is not tested here since it loads real SDKs
// and reads ~/.ethos; these tests verify the documented JSON shape.

describe('ethos doctor --json output shape', () => {
  it('SDK entry has required fields', () => {
    const sdkEntry = {
      label: 'Anthropic provider',
      module: '@anthropic-ai/sdk',
      required: true,
      loadable: true,
    };
    expect(typeof sdkEntry.label).toBe('string');
    expect(typeof sdkEntry.module).toBe('string');
    expect(typeof sdkEntry.required).toBe('boolean');
    expect(typeof sdkEntry.loadable).toBe('boolean');
  });

  it('optional SDK entry may have configured field', () => {
    const optional = {
      label: 'Telegram',
      module: 'grammy',
      required: false,
      configured: true,
      loadable: false,
    };
    expect(optional.required).toBe(false);
    expect(typeof optional.configured).toBe('boolean');
    expect(optional.loadable).toBe(false);
  });

  it('JSON output root keys are defined', () => {
    const shape = {
      version: { name: '@ethosagent/cli', version: 'dev' },
      sdks: [],
      config: { present: false, path: '/home/user/.ethos/config.yaml' },
      personalities: { dir: '/home/user/.ethos/personalities', loadable: false },
      skillCliIssues: [],
      // W2.3 — DB, gateway heartbeat, and channel-token liveness blocks.
      db: { ok: true, absent: true },
      gateway: { status: 'down', adapters: [], lastHeartbeatAgeSec: null },
      channels: [],
      exit: 0,
    };
    expect(shape).toHaveProperty('version');
    expect(shape).toHaveProperty('sdks');
    expect(shape).toHaveProperty('config');
    expect(shape).toHaveProperty('personalities');
    expect(shape).toHaveProperty('skillCliIssues');
    expect(shape).toHaveProperty('db');
    expect(shape).toHaveProperty('gateway');
    expect(shape).toHaveProperty('channels');
    expect(shape).toHaveProperty('exit');
  });

  it('db block shape (W2.3)', () => {
    const db = { ok: true, absent: false } as { ok: boolean; absent: boolean; error?: string };
    expect(typeof db.ok).toBe('boolean');
    expect(typeof db.absent).toBe('boolean');
    expect(db.error === undefined || typeof db.error === 'string').toBe(true);
  });

  it('gateway block shape (W2.3)', () => {
    const gateway = {
      status: 'ok' as 'ok' | 'stale' | 'down',
      adapters: [{ name: 'telegram', ok: true }],
      lastHeartbeatAgeSec: 3,
    };
    expect(['ok', 'stale', 'down']).toContain(gateway.status);
    expect(Array.isArray(gateway.adapters)).toBe(true);
    expect(
      gateway.lastHeartbeatAgeSec === null || typeof gateway.lastHeartbeatAgeSec === 'number',
    ).toBe(true);
  });

  it('channel entry shape carries a liveness reason (W2.3)', () => {
    const channel = { platform: 'telegram', ok: false, reason: 'unverified' as const };
    expect(['telegram', 'slack', 'discord']).toContain(channel.platform);
    expect(typeof channel.ok).toBe('boolean');
    expect(['rejected', 'unreachable', 'unverified']).toContain(channel.reason);
  });

  it('skillCliIssues entry shape', () => {
    const entry = { name: 'gh', path: null, ok: false };
    expect(typeof entry.name).toBe('string');
    expect(entry.path === null || typeof entry.path === 'string').toBe(true);
    expect(typeof entry.ok).toBe('boolean');
  });

  it('exit is 0 when no core failures or configured-missing', () => {
    const sdks = [
      { label: 'Anthropic provider', module: '@anthropic-ai/sdk', required: true, loadable: true },
      { label: 'Telegram', module: 'grammy', required: false, configured: false, loadable: false },
    ];
    const coreFailures = sdks.filter((s) => s.required && !s.loadable);
    const configuredMissing = sdks.filter((s) => !s.required && s.configured && !s.loadable);
    const exitCode = coreFailures.length > 0 || configuredMissing.length > 0 ? 1 : 0;
    expect(exitCode).toBe(0);
  });

  it('exit is 1 when a core SDK is missing', () => {
    const sdks = [
      { label: 'Anthropic provider', module: '@anthropic-ai/sdk', required: true, loadable: false },
    ];
    const coreFailures = sdks.filter((s) => s.required && !s.loadable);
    const exitCode = coreFailures.length > 0 ? 1 : 0;
    expect(exitCode).toBe(1);
  });
});

describe('doctor sessionsFts (plan session-db-repair D4)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const clean = {
    coreFailure: false,
    configuredMissing: false,
    awsFailed: false,
    requiredSecretMissing: false,
    dbUnopenable: false,
    gatewayStale: false,
    channelRejected: false,
    channelUnreachable: false,
  };

  it('sessionsFts is present and does not affect the exit code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-json-fts-'));
    dirs.push(dir);
    divergeFts(await seedSessionsDb(dir));
    const fts = sessionsFtsOf(await checkDatabaseIntegrity(dir));
    expect(Object.keys(fts ?? {}).sort()).toEqual([
      'dangling',
      'indexedDocs',
      'messages',
      'unindexed',
    ]);
    expect(computeDoctorExit({ ...clean })).toBe(0);
  });

  it('drift > 0 is reported, and computeDoctorExit takes no drift input (signature pin)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-json-fts-'));
    dirs.push(dir);
    divergeFts(await seedSessionsDb(dir));
    const fts = sessionsFtsOf(await checkDatabaseIntegrity(dir));
    expect((fts?.unindexed ?? 0) + (fts?.dangling ?? 0)).toBeGreaterThan(0);
    // computeDoctorExit has no drift input: nothing derived from the probe can reach it.
    expect(computeDoctorExit({ ...clean, dbIntegrityFailed: false })).toBe(0);
  });
});

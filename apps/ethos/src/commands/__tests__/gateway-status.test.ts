import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteInboundSpool } from '@ethosagent/inbound-spool';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyGatewayStatus,
  formatGatewayStatus,
  gatewayStatusExitCode,
  readGatewayStatus,
  runGatewaySpool,
  runGatewayStatus,
} from '../gateway-status';

function deadPid(): number {
  for (let p = 4_000_000; p > 100_000; p -= 7919) {
    try {
      process.kill(p, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return p;
    }
  }
  throw new Error('could not find a dead pid');
}

let dir: string;
let log: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gateway-status-'));
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  log.mockRestore();
  err.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

function writeLock(pid: number): void {
  writeFileSync(join(dir, 'gateway.lock'), JSON.stringify({ token: 't', pid }));
}
function writeHeartbeat(ageMs: number): void {
  writeFileSync(
    join(dir, 'gateway-health.json'),
    JSON.stringify({ pid: process.pid, updatedAt: new Date(Date.now() - ageMs).toISOString() }),
  );
}

describe('ethos gateway status — the four states', () => {
  it('running: live lock holder, fresh heartbeat → exit 0', async () => {
    writeLock(process.pid);
    writeHeartbeat(4_000);
    const s = await readGatewayStatus(dir);
    expect(s.state).toBe('running');
    expect(formatGatewayStatus(s)).toMatch(
      new RegExp(`^running \\(pid ${process.pid}, heartbeat 4s ago\\)$`),
    );
    expect(await runGatewayStatus([], dir)).toBe(0);
  });

  it('stale: the holder pid is gone → exit 1, next start takes it over', async () => {
    const pid = deadPid();
    writeLock(pid);
    const s = await readGatewayStatus(dir);
    expect(s.state).toBe('stale');
    expect(formatGatewayStatus(s)).toBe(
      `stale lock (pid ${pid} not running) — next start will take it over`,
    );
    expect(await runGatewayStatus([], dir)).toBe(1);
  });

  it('unhealthy: live holder, old heartbeat → exit 2', async () => {
    writeLock(process.pid);
    writeHeartbeat(95_000);
    const s = await readGatewayStatus(dir);
    expect(formatGatewayStatus(s)).toBe(`unhealthy (pid ${process.pid} alive, heartbeat 95s old)`);
    expect(await runGatewayStatus([], dir)).toBe(2);
  });

  it('stopped: no lock → exit 1, even with a leftover heartbeat', async () => {
    writeHeartbeat(1_000);
    expect((await readGatewayStatus(dir)).state).toBe('stopped');
    expect(await runGatewayStatus([], dir)).toBe(1);
  });

  it('exit codes by state', () => {
    expect(gatewayStatusExitCode('running')).toBe(0);
    expect(gatewayStatusExitCode('stopped')).toBe(1);
    expect(gatewayStatusExitCode('stale')).toBe(1);
    expect(gatewayStatusExitCode('unhealthy')).toBe(2);
    expect(classifyGatewayStatus({ holder: 'live', pid: 1, startedAt: null }, null, 0).state).toBe(
      'unhealthy',
    );
  });
});

describe('ethos gateway status --json', () => {
  it('prints { state, pid, heartbeatAgeMs, lockPath, spool, ledger }', async () => {
    writeLock(process.pid);
    writeHeartbeat(2_000);
    const spool = new SQLiteInboundSpool(join(dir, 'inbound-spool.db'));
    spool.accept({
      platform: 'telegram',
      botKey: 'b',
      chatId: 'c',
      messageId: 'm',
      laneKey: 'l',
      payload: '{}',
    });
    spool.close();
    await runGatewayStatus(['--json'], dir);
    const out = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(
      ['heartbeatAgeMs', 'ledger', 'lockPath', 'pid', 'spool', 'state'].sort(),
    );
    expect(out).toMatchObject({
      state: 'running',
      pid: process.pid,
      lockPath: join(dir, 'gateway.lock'),
      spool: { received: 1, processing: 0, done: 0, dead: 0 },
      // No ledger file here — and a status read must not create one.
      ledger: null,
    });
    expect(typeof out.heartbeatAgeMs).toBe('number');
  });
});

describe('ethos gateway spool replay|discard', () => {
  function deadRow(messageId: string): string {
    const spool = new SQLiteInboundSpool(join(dir, 'inbound-spool.db'));
    const { id } = spool.accept({
      platform: 'telegram',
      botKey: 'b',
      chatId: 'c',
      messageId,
      laneKey: 'l',
      payload: '{}',
    });
    spool.markDead(id, 'poison');
    spool.close();
    return id;
  }

  it('replay requeues a dead row; discard closes one', () => {
    const a = deadRow('a');
    const b = deadRow('b');
    expect(runGatewaySpool(['replay', a], dir)).toBe(0);
    expect(runGatewaySpool(['discard', b], dir)).toBe(0);
    const spool = new SQLiteInboundSpool(join(dir, 'inbound-spool.db'));
    expect(spool.get(a)).toMatchObject({ status: 'received', attempts: 0 });
    expect(spool.get(b)).toMatchObject({ status: 'done', lastError: 'discarded' });
    spool.close();
    // Not dead any more → refused.
    expect(runGatewaySpool(['discard', a], dir)).toBe(1);
  });

  it('refuses an unknown id, a missing spool, and bad usage', () => {
    expect(runGatewaySpool(['replay', 'nope'], dir)).toBe(1);
    deadRow('x');
    expect(runGatewaySpool(['replay', 'nope'], dir)).toBe(1);
    expect(runGatewaySpool(['frobnicate', 'x'], dir)).toBe(1);
  });
});

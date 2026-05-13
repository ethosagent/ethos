import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listProcesses, readProcessLogs, stopProcess } from '../operations';
import { type ProcessEntry, saveRegistry } from '../registry';

let dataDir: string;

function makeEntry(id: string, patch: Partial<ProcessEntry> = {}): ProcessEntry {
  const now = new Date().toISOString();
  return {
    id,
    name: id,
    pid: 999_999,
    command: 'sleep 1',
    cwd: dataDir,
    status: 'exited',
    startedAt: now,
    lastTouchedAt: now,
    started_by: 'tester',
    exitCode: 0,
    ...patch,
  };
}

function writeLogs(id: string, stdout: string, stderr: string): void {
  const dir = join(dataDir, 'processes', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stdout.log'), stdout, 'utf8');
  writeFileSync(join(dir, 'stderr.log'), stderr, 'utf8');
}

beforeEach(() => {
  dataDir = join(
    tmpdir(),
    `tools-process-ops-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('listProcesses', () => {
  it('returns the same shape as the process_list tool', async () => {
    saveRegistry(dataDir, { a: makeEntry('a', { name: 'job-a', pid: 111, exitCode: 2 }) });
    const items = await listProcesses(dataDir);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item).toMatchObject({
      id: 'a',
      name: 'job-a',
      pid: 111,
      status: 'exited',
      exit_code: 2,
    });
    expect(typeof item?.started_at).toBe('string');
    expect(typeof item?.duration_ms).toBe('number');
  });

  it('marks a dead running entry as orphan via the liveness check', async () => {
    saveRegistry(dataDir, { a: makeEntry('a', { status: 'running', pid: 999_999 }) });
    const items = await listProcesses(dataDir);
    expect(items[0]?.status).toBe('orphan');
  });

  it('omits exit_code when the entry has none', async () => {
    saveRegistry(dataDir, {
      a: makeEntry('a', { status: 'running', pid: process.pid, exitCode: undefined }),
    });
    const items = await listProcesses(dataDir);
    expect(items[0]).not.toHaveProperty('exit_code');
  });
});

describe('readProcessLogs', () => {
  it('returns interleaved stdout and stderr lines by default', async () => {
    saveRegistry(dataDir, { a: makeEntry('a') });
    writeLogs('a', 'out1\nout2\n', 'err1\n');
    const result = await readProcessLogs(dataDir, 'a', {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.lines).toEqual(['[stdout] out1', '[stdout] out2', '[stderr] err1']);
    }
  });

  it('honours the lines and stream options', async () => {
    saveRegistry(dataDir, { a: makeEntry('a') });
    writeLogs('a', 'o1\no2\no3\n', 'e1\n');
    const result = await readProcessLogs(dataDir, 'a', { lines: 2, stream: 'stdout' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.lines).toEqual(['[stdout] o2', '[stdout] o3']);
    }
  });

  it('reports not-found for an unknown id', async () => {
    const result = await readProcessLogs(dataDir, 'nope', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('PROCESS_NOT_FOUND');
    }
  });
});

describe('stopProcess', () => {
  it('reports not-found for an unknown id', async () => {
    const result = await stopProcess(dataDir, 'nope', 'SIGTERM');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('PROCESS_NOT_FOUND');
    }
  });

  it('returns stopped:false for an already-terminal process', async () => {
    saveRegistry(dataDir, { a: makeEntry('a', { status: 'exited', exitCode: 0 }) });
    const result = await stopProcess(dataDir, 'a', 'SIGTERM');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stopped).toBe(false);
    }
  });

  it('rejects an unsupported signal', async () => {
    saveRegistry(dataDir, { a: makeEntry('a', { status: 'running' }) });
    // @ts-expect-error — intentionally passing an unsupported signal
    const result = await stopProcess(dataDir, 'a', 'SIGHUP');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('SIGNAL_NOT_SUPPORTED');
    }
  });
});

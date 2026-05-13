import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ProcessEntry, saveRegistry } from '@ethosagent/tools-process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runProcessCommand } from '../process';

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

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  return { lines, restore: () => spy.mockRestore() };
}

beforeEach(() => {
  dataDir = join(
    tmpdir(),
    `ethos-process-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('ethos process list', () => {
  it('prints a table row for each tracked process', async () => {
    saveRegistry(dataDir, {
      a: makeEntry('a', { name: 'dev-server', pid: 4242, status: 'exited' }),
    });
    const { lines, restore } = captureLog();
    await runProcessCommand('list', [], dataDir);
    restore();
    const output = lines.join('\n');
    expect(output).toContain('dev-server');
    expect(output).toContain('4242');
    expect(output).toContain('exited');
  });

  it('reports an empty registry without throwing', async () => {
    const { lines, restore } = captureLog();
    await runProcessCommand('list', [], dataDir);
    restore();
    expect(lines.join('\n')).toMatch(/no .*process/i);
  });

  it('emits JSON with --json', async () => {
    saveRegistry(dataDir, { a: makeEntry('a', { name: 'dev-server', pid: 4242 }) });
    const { lines, restore } = captureLog();
    await runProcessCommand('list', ['--json'], dataDir);
    restore();
    const parsed = JSON.parse(lines.join('\n'));
    expect(parsed[0]).toMatchObject({ id: 'a', name: 'dev-server', pid: 4242 });
  });
});

describe('ethos process logs', () => {
  it('prints the tail of a process log', async () => {
    saveRegistry(dataDir, { a: makeEntry('a') });
    const dir = join(dataDir, 'processes', 'a');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'stdout.log'), 'hello\nworld\n', 'utf8');
    writeFileSync(join(dir, 'stderr.log'), '', 'utf8');
    const { lines, restore } = captureLog();
    await runProcessCommand('logs', ['a'], dataDir);
    restore();
    expect(lines.join('\n')).toContain('hello');
    expect(lines.join('\n')).toContain('world');
  });

  it('exits non-zero for an unknown id', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runProcessCommand('logs', ['nope'], dataDir)).rejects.toThrow('exit');
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('PROCESS_NOT_FOUND'));
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('errors when no id is given', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runProcessCommand('logs', [], dataDir)).rejects.toThrow('exit');
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});

describe('ethos process stop', () => {
  it('reports stopped:false for an already-terminal process', async () => {
    saveRegistry(dataDir, { a: makeEntry('a', { status: 'exited', exitCode: 0 }) });
    const { lines, restore } = captureLog();
    await runProcessCommand('stop', ['a'], dataDir);
    restore();
    expect(lines.join('\n')).toMatch(/not running|already/i);
  });

  it('exits non-zero for an unknown id', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runProcessCommand('stop', ['nope'], dataDir)).rejects.toThrow('exit');
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('PROCESS_NOT_FOUND'));
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});

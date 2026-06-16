import { ScopedProcessImpl } from '@ethosagent/core';
import type { ExecChunk, ExecOpts, ExecutionBackend } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { createCodeTools } from '../index';

// ---------------------------------------------------------------------------
// Fake execution backend
// ---------------------------------------------------------------------------

interface FakeBackend extends ExecutionBackend {
  lastCmd?: string;
  lastOpts?: ExecOpts;
}

function makeBackend(
  available: boolean,
  result?: Partial<{ stdout: string; stderr: string }>,
): FakeBackend {
  const backend: FakeBackend = {
    name: 'docker',
    isAvailable: vi.fn().mockResolvedValue(available),
    exec(cmd: string, opts: ExecOpts): AsyncIterable<ExecChunk> {
      backend.lastCmd = cmd;
      backend.lastOpts = opts;
      async function* gen(): AsyncIterable<ExecChunk> {
        if (result?.stdout) yield { stream: 'stdout', data: result.stdout };
        if (result?.stderr) yield { stream: 'stderr', data: result.stderr };
      }
      return gen();
    },
    spawnSession(personalityId: string) {
      return {
        personalityId,
        exec: (cmd: string, opts: ExecOpts = {}) => backend.exec(cmd, opts),
        dispose: () => Promise.resolve(),
      };
    },
    mountsFor: () => [],
    dispose: () => Promise.resolve(),
  };
  return backend;
}

const ctx = {
  sessionId: 'test',
  sessionKey: 'cli:test',
  platform: 'cli',
  workingDir: '/tmp',
  currentTurn: 1,
  messageCount: 1,
  abortSignal: new AbortController().signal,
  emit: () => {},
  resultBudgetChars: 80_000,
  scopedProcess: new ScopedProcessImpl(new Set(['*'])),
};

// ---------------------------------------------------------------------------
// createCodeTools
// ---------------------------------------------------------------------------

describe('createCodeTools', () => {
  it('returns 3 tools (run_code, run_tests, lint)', () => {
    const tools = createCodeTools({ backend: makeBackend(false) });
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual(['run_code', 'run_tests', 'lint']);
  });
});

// ---------------------------------------------------------------------------
// run_code
// ---------------------------------------------------------------------------

describe('run_code', () => {
  it('isAvailable reflects whether a backend is wired', () => {
    const [withBackend] = createCodeTools({ backend: makeBackend(true) });
    const [withoutBackend] = createCodeTools({});
    expect(withBackend.isAvailable?.()).toBe(true);
    expect(withoutBackend.isAvailable?.()).toBe(false);
  });

  it('returns input_invalid when runtime is missing', async () => {
    const [runCode] = createCodeTools({ backend: makeBackend(true) });
    const result = await runCode.execute({ code: 'print(1)' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('returns input_invalid when code is missing', async () => {
    const [runCode] = createCodeTools({ backend: makeBackend(true) });
    const result = await runCode.execute({ runtime: 'python' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('returns input_invalid for unknown runtime', async () => {
    const [runCode] = createCodeTools({ backend: makeBackend(true) });
    const result = await runCode.execute({ runtime: 'cobol', code: 'hello' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('input_invalid');
      expect(result.error).toMatch(/Unknown runtime/);
    }
  });

  it('returns not_available when no backend is wired', async () => {
    const [runCode] = createCodeTools({});
    const result = await runCode.execute({ runtime: 'python', code: 'print(42)' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_available');
  });

  it('returns not_available when the backend is down', async () => {
    const [runCode] = createCodeTools({ backend: makeBackend(false) });
    const result = await runCode.execute({ runtime: 'python', code: 'print(42)' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_available');
  });

  it('routes through backend.exec with the runtime command, clean env, and code on stdin', async () => {
    const backend = makeBackend(true, { stdout: '42\n' });
    const [runCode] = createCodeTools({ backend });
    const result = await runCode.execute({ runtime: 'python', code: 'print(42)' }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('42');
    expect(backend.lastCmd).toBe('python3 -');
    expect(backend.lastOpts?.stdin).toBe('print(42)');
    expect(backend.lastOpts?.env).toEqual({});
  });

  it('returns "(no output)" for empty successful run', async () => {
    const backend = makeBackend(true, { stdout: '' });
    const [runCode] = createCodeTools({ backend });
    const result = await runCode.execute({ runtime: 'bash', code: ':' }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('(no output)');
  });

  it.each(['python', 'js', 'bash'])('accepts runtime: %s', async (runtime) => {
    const backend = makeBackend(true, { stdout: 'ok' });
    const [runCode] = createCodeTools({ backend });
    const result = await runCode.execute({ runtime, code: 'hello' }, ctx);
    expect(result.ok).toBe(true);
  });
});

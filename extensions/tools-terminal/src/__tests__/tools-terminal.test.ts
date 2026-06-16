import { ScopedProcessImpl } from '@ethosagent/core';
import type { ExecChunk, ExecOpts, ExecutionBackend, PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { createTerminalTools, terminalTool } from '../index';

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

describe('terminal', () => {
  it('runs a simple command and returns output', async () => {
    const result = await terminalTool.execute({ command: 'echo "hello ethos"' }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('hello ethos');
  });

  it('captures stderr output', async () => {
    const result = await terminalTool.execute({ command: 'echo "err" >&2' }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('err');
  });

  it('returns execution_failed for non-zero exit codes', async () => {
    const result = await terminalTool.execute({ command: 'exit 1' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('execution_failed');
  });

  it('returns input_invalid if command is missing', async () => {
    const result = await terminalTool.execute({}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('respects cwd option', async () => {
    const result = await terminalTool.execute({ command: 'pwd', cwd: '/tmp' }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('/tmp');
  });

  it('returns not_available when scopedProcess is absent', async () => {
    const ctxNoProcess = { ...ctx, scopedProcess: undefined };
    const result = await terminalTool.execute({ command: 'echo hi' }, ctxNoProcess);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_available');
  });
});

// ---------------------------------------------------------------------------
// Routing (Phase 2a lane c) — local preserved, docker routed with clean env
// ---------------------------------------------------------------------------

interface FakeBackend extends ExecutionBackend {
  lastCmd?: string;
  lastOpts?: ExecOpts;
}

function makeBackend(out: string): FakeBackend {
  const be: FakeBackend = {
    name: 'docker',
    isAvailable: () => Promise.resolve(true),
    exec(cmd: string, opts: ExecOpts): AsyncIterable<ExecChunk> {
      be.lastCmd = cmd;
      be.lastOpts = opts;
      async function* gen(): AsyncIterable<ExecChunk> {
        yield { stream: 'stdout', data: out };
      }
      return gen();
    },
    spawnSession: (personalityId: string) => ({
      personalityId,
      exec: (cmd: string, opts: ExecOpts = {}) => be.exec(cmd, opts),
      dispose: () => Promise.resolve(),
    }),
    mountsFor: () => [],
    dispose: () => Promise.resolve(),
  };
  return be;
}

describe('terminal routing', () => {
  it('uses ctx.scopedProcess when NO backend is injected (local preserved)', async () => {
    const spawn = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'local out', stderr: '' });
    const localCtx = { ...ctx, scopedProcess: { spawn } as unknown as typeof ctx.scopedProcess };
    const [tool] = createTerminalTools();
    const result = await tool.execute({ command: 'echo hi' }, localCtx);
    expect(spawn).toHaveBeenCalledWith('bash', ['-c', 'echo hi'], expect.any(Object));
    expect(result.ok).toBe(true);
  });

  it('routes through backend.exec with a clean env and the personality (#3)', async () => {
    const backend = makeBackend('routed out');
    const personality = { id: 'p', name: 'p' } as unknown as PersonalityConfig;
    const spawn = vi.fn();
    const routedCtx = { ...ctx, scopedProcess: { spawn } as unknown as typeof ctx.scopedProcess };
    const [tool] = createTerminalTools({ backend, personality });
    const result = await tool.execute({ command: 'whoami' }, routedCtx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('routed out');
    expect(backend.lastCmd).toBe('whoami');
    expect(backend.lastOpts?.env).toEqual({});
    expect(backend.lastOpts?.personality).toBe(personality);
    // The local path must NOT be used when routed.
    expect(spawn).not.toHaveBeenCalled();
  });
});

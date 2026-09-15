import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// G5 — `ethos -z` must surface failures via process.exitCode so the CLI's
// final `process.exit(process.exitCode ?? 0)` propagates a non-zero status
// to shell pipelines. These tests drive runZero with a mocked wiring layer.

vi.mock('../wiring', () => ({
  getStorage: vi.fn(() => ({})),
  getSecretsResolver: vi.fn(async () => ({})),
  resolveActiveLoop: vi.fn(),
}));

vi.mock('@ethosagent/config', () => ({
  readConfig: vi.fn(),
}));

// Only `fstatSync` is replaced, and it delegates to the real one unless a test
// says otherwise — Q-151 / D47 decide what stdin is from its fstat.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, fstatSync: vi.fn(actual.fstatSync) };
});

import { fstatSync } from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import { readConfig } from '@ethosagent/config';
import { runZero } from '../commands/zero';
import { resolveActiveLoop } from '../wiring';

const FAKE_CONFIG = {
  provider: 'anthropic',
  model: 'claude-test',
  apiKey: 'k',
  personality: 'default',
};

describe('runZero exit-code propagation (G5)', () => {
  let savedExitCode: number | string | undefined;
  let savedIsTTY: boolean;

  beforeEach(() => {
    savedExitCode = process.exitCode ?? undefined;
    process.exitCode = undefined;
    // Force the TTY branch so runZero never tries to drain process.stdin.
    savedIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
    process.stdin.isTTY = savedIsTTY;
    vi.restoreAllMocks();
  });

  it('sets exitCode 1 when the loop yields an error event', async () => {
    vi.mocked(readConfig).mockResolvedValue(FAKE_CONFIG as never);
    vi.mocked(resolveActiveLoop).mockResolvedValue({
      loop: {
        run: async function* () {
          yield { type: 'error', error: 'model not found', code: 'PROVIDER_ERROR' };
        },
      },
      personalityId: 'default',
    } as never);

    await runZero(['-z', 'hello'], 'hello');
    expect(process.exitCode).toBe(1);
  });

  it('sets exitCode 1 when the loop throws', async () => {
    vi.mocked(readConfig).mockResolvedValue(FAKE_CONFIG as never);
    vi.mocked(resolveActiveLoop).mockResolvedValue({
      loop: {
        // biome-ignore lint/correctness/useYield: throws before yielding
        run: async function* () {
          throw new Error('boom');
        },
      },
      personalityId: 'default',
    } as never);

    await runZero(['-z', 'hello'], 'hello');
    expect(process.exitCode).toBe(1);
  });

  it('sets exitCode 1 when no config exists', async () => {
    vi.mocked(readConfig).mockResolvedValue(null as never);

    await runZero(['-z', 'hello'], 'hello');
    expect(process.exitCode).toBe(1);
  });

  // A `returnDirect` tool's answer reaches the turn only as `done.text`, after
  // any preamble the model streamed: streaming output still prints it, once.
  it('streams a returnDirect answer that only `done.text` carries', async () => {
    vi.mocked(readConfig).mockResolvedValue(FAKE_CONFIG as never);
    vi.mocked(resolveActiveLoop).mockResolvedValue({
      loop: {
        run: async function* () {
          yield { type: 'text_delta', text: 'Let me look that up.' };
          yield { type: 'done', text: 'DIRECT ANSWER', turnCount: 1 };
        },
      },
      personalityId: 'default',
    } as never);

    await runZero(['-z', 'hello'], 'hello');
    const written = vi
      .mocked(process.stdout.write)
      .mock.calls.map((c) => String(c[0]))
      .join('');
    expect(written).toContain('Let me look that up.\n\nDIRECT ANSWER');
    expect(written.split('DIRECT ANSWER')).toHaveLength(2);
  });

  it('leaves exitCode unset on a successful turn', async () => {
    vi.mocked(readConfig).mockResolvedValue(FAKE_CONFIG as never);
    vi.mocked(resolveActiveLoop).mockResolvedValue({
      loop: {
        run: async function* () {
          yield { type: 'text_delta', text: 'hi' };
          yield { type: 'done', text: 'hi', turnCount: 1 };
        },
      },
      personalityId: 'default',
    } as never);

    await runZero(['-z', 'hello'], 'hello');
    expect(process.exitCode).toBeUndefined();
  });

  // Q-151 / D47 — stdin is read only when it is a pipe or a redirected file.
  describe('stdin', () => {
    afterEach(() => {
      // Undo the stdin getter spy before the outer afterEach restores isTTY on
      // the real process.stdin.
      vi.restoreAllMocks();
    });

    function mockLoop() {
      const run = vi.fn(async function* (_prompt: string) {
        yield { type: 'done', text: 'ok', turnCount: 1 };
      });
      vi.mocked(readConfig).mockResolvedValue(FAKE_CONFIG as never);
      vi.mocked(resolveActiveLoop).mockResolvedValue({
        loop: { run },
        personalityId: 'default',
      } as never);
      return run;
    }

    function useStdin(stream: NodeJS.ReadableStream, kind: 'fifo' | 'file' | 'char'): void {
      vi.spyOn(process, 'stdin', 'get').mockReturnValue(stream as never);
      vi.mocked(fstatSync).mockImplementationOnce(
        () =>
          ({
            isFIFO: () => kind === 'fifo',
            isFile: () => kind === 'file',
          }) as never,
      );
    }

    it('does not read stdin that is not a pipe or a file', async () => {
      const run = mockLoop();
      // Never ends: reading it would hang the test until it times out.
      useStdin(new PassThrough(), 'char');

      await runZero(['-z', 'hello'], 'hello');
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[0]).toBe('hello');
    }, 2_000);

    it('does not read stdin when fstat on it fails', async () => {
      const run = mockLoop();
      vi.spyOn(process, 'stdin', 'get').mockReturnValue(new PassThrough() as never);
      vi.mocked(fstatSync).mockImplementationOnce(() => {
        throw new Error('EBADF');
      });

      await runZero(['-z', 'hello'], 'hello');
      expect(run.mock.calls[0]?.[0]).toBe('hello');
    }, 2_000);

    it.each(['fifo', 'file'] as const)('reads stdin that is a %s', async (kind) => {
      const run = mockLoop();
      useStdin(Readable.from([Buffer.from('piped text')]), kind);

      await runZero(['-z', 'hello'], 'hello');
      const prompt = String(run.mock.calls[0]?.[0]);
      expect(prompt.startsWith('hello')).toBe(true);
      expect(prompt).toContain('piped text');
    });
  });
});

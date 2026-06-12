import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// G5 — `ethos -z` must surface failures via process.exitCode so the CLI's
// final `process.exit(process.exitCode ?? 0)` propagates a non-zero status
// to shell pipelines. These tests drive runZero with a mocked wiring layer.

vi.mock('../wiring', () => ({
  getStorage: vi.fn(() => ({})),
  getSecretsResolver: vi.fn(async () => ({})),
  resolveActiveLoop: vi.fn(),
}));

vi.mock('../config', () => ({
  readConfig: vi.fn(),
}));

import { runZero } from '../commands/zero';
import { readConfig } from '../config';
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
});

import { LEARNING_REPLAY_DEFAULTS, resolveLearningReplay } from '@ethosagent/config';
import { describe, expect, it, vi } from 'vitest';

// Mock electron-store before importing serve (store.ts depends on it)
vi.mock('electron-store', () => ({
  default: class MockStore {
    get(_key: string) {
      return undefined;
    }
  },
}));

// Mock keychain (depends on Electron safeStorage)
vi.mock('../keychain', () => ({
  getKeychainValue: vi.fn().mockResolvedValue(null),
}));

const replayer = vi.fn(async (candidateId: string) => ({ replayed: candidateId }));
const createLearningReplayer = vi.fn((..._args: unknown[]) => replayer);
const createLLM = vi.fn(async () => ({ name: 'grader' }));

vi.mock('@ethosagent/wiring', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ethosagent/wiring')>()),
  createLearningReplayer: (...args: unknown[]) => createLearningReplayer(...args),
  createLLM: () => createLLM(),
}));

const { desktopLearningReplay } = await import('../serve');

const wiringConfig = { provider: 'anthropic', model: 'm', apiKey: 'k', personality: 'operator' };
// The registry is only passed through to the replayer here.
const personalities = {} as Parameters<typeof desktopLearningReplay>[0]['personalities'];

// Gap: the desktop host built its web API without `learningReplay`, so
// `learning.replay` refused `REPLAY_UNAVAILABLE` there while `ethos serve` ran
// it. `desktopLearningReplay` is what `bootRuntime` spreads into
// `createWebApi`.
describe('desktopLearningReplay', () => {
  it('passes learningReplay, replaying with the shared settings and the default LLM as grader', async () => {
    const settings = resolveLearningReplay({ learningReplay: { maxCases: 4, maxCostUsd: 0.25 } });

    const option = desktopLearningReplay({
      settings,
      wiringConfig,
      dataDir: '/data',
      personalities,
    });

    expect(option.learningReplay).toBeTypeOf('function');
    expect(await option.learningReplay?.('cand-1')).toEqual({ replayed: 'cand-1' });
    expect(createLearningReplayer).toHaveBeenCalledWith(
      wiringConfig,
      expect.objectContaining({
        dataDir: '/data',
        personalities,
        expressions: personalities,
        grader: { name: 'grader' },
        settings: expect.objectContaining({ maxCases: 4, maxCostUsd: 0.25 }),
        actor: 'web',
      }),
    );
    expect(replayer).toHaveBeenCalledWith('cand-1');
  });

  it('passes learningReplay under the defaults when the shared config has no learningReplay block', () => {
    expect(LEARNING_REPLAY_DEFAULTS.enabled).toBe(true);
    const option = desktopLearningReplay({
      settings: resolveLearningReplay({}),
      wiringConfig,
      dataDir: '/data',
      personalities,
    });
    expect(option.learningReplay).toBeTypeOf('function');
  });

  it('passes nothing when learningReplay.enabled is false, or the settings could not be read', () => {
    expect(
      desktopLearningReplay({
        settings: resolveLearningReplay({ learningReplay: { enabled: false } }),
        wiringConfig,
        dataDir: '/data',
        personalities,
      }),
    ).toEqual({});
    expect(
      desktopLearningReplay({ settings: null, wiringConfig, dataDir: '/data', personalities }),
    ).toEqual({});
  });
});

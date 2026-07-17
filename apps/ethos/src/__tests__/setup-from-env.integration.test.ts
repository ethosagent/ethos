import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerRejectedLine, runSetupFromEnv } from '../commands/setup-from-env';

// End-to-end coverage for runSetupFromEnv (W2.4). The unit test alongside
// covers resolveProviderFromEnv + the last-line strings; this exercises the
// full flow: config skip-if-exists, secret re-sync, the liveness split, and
// the ETHOS_SKIP_VALIDATION escape hatch.

const probeProvider = vi.fn();
vi.mock('@ethosagent/wiring', () => ({ probeProvider: (...a: unknown[]) => probeProvider(...a) }));

const validateTelegramToken = vi.fn();
vi.mock('@ethosagent/platform-telegram/validate', () => ({
  validateTelegramToken: (...a: unknown[]) => validateTelegramToken(...a),
}));

const readRawConfig = vi.fn();
const writeConfig = vi.fn();
vi.mock('@ethosagent/config', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@ethosagent/config')>();
  return {
    ...orig,
    readRawConfig: (...a: unknown[]) => readRawConfig(...a),
    writeConfig: (...a: unknown[]) => writeConfig(...a),
  };
});

const scaffoldEthosDir = vi.fn();
vi.mock('../commands/setup', () => ({
  scaffoldEthosDir: (...a: unknown[]) => scaffoldEthosDir(...a),
}));

const secretStore = new Map<string, string>();
const secretsGet = vi.fn(async (ref: string) => secretStore.get(ref) ?? null);
const secretsSet = vi.fn(async (ref: string, val: string) => {
  secretStore.set(ref, val);
});
const recordSetupCompleted = vi.fn(async () => {});
vi.mock('../wiring', () => ({
  getStorage: () => ({ mkdir: async () => {}, write: async () => {}, exists: async () => false }),
  getSecretsResolver: async () => ({ get: secretsGet, set: secretsSet }),
  getFunnelTracker: () => ({ recordSetupCompleted }),
}));

const run = runSetupFromEnv;

describe('runSetupFromEnv — W2.4 headless bootstrap', () => {
  const ORIGINAL_ENV = process.env;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env = { PATH: ORIGINAL_ENV.PATH };
    secretStore.clear();
    probeProvider.mockReset();
    validateTelegramToken.mockReset();
    readRawConfig.mockReset().mockResolvedValue(null);
    writeConfig.mockReset().mockResolvedValue(undefined);
    scaffoldEthosDir.mockReset().mockResolvedValue(undefined);
    secretsGet.mockClear();
    secretsSet.mockClear();
    recordSetupCompleted.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.restoreAllMocks();
  });

  it('(a) skips writeConfig when a config already exists', async () => {
    readRawConfig.mockResolvedValue({ provider: 'anthropic', model: 'claude-opus-4-7' });
    process.env.ANTHROPIC_API_KEY = 'sk-ant-new';
    probeProvider.mockResolvedValue({ ok: true, latencyMs: 5 });

    await run();

    expect(writeConfig).not.toHaveBeenCalled();
    expect(scaffoldEthosDir).not.toHaveBeenCalled();
    // Secret is still re-synced from env (env is authoritative in Docker).
    expect(secretsSet).toHaveBeenCalledWith('providers/anthropic/apiKey', 'sk-ant-new');
  });

  it('(b) does not re-validate when the key is unchanged since last boot', async () => {
    secretStore.set('providers/anthropic/apiKey', 'sk-ant-same');
    process.env.ANTHROPIC_API_KEY = 'sk-ant-same';

    await run();

    expect(probeProvider).not.toHaveBeenCalled();
  });

  it('(c) aborts with exit(1) on a definitively rejected key', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-bad';
    probeProvider.mockResolvedValue({ ok: false, reason: 'rejected', error: 'Unauthorized' });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(run()).rejects.toThrow('process.exit(1)');
    expect(errSpy).toHaveBeenCalledWith(providerRejectedLine('ANTHROPIC_API_KEY'));
  });

  it('(d) warns and proceeds (no exit) when the provider is unreachable', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    probeProvider.mockResolvedValue({ ok: false, reason: 'unreachable', error: 'ETIMEDOUT' });

    await run();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(writeConfig).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('(e) skips all probing when ETHOS_SKIP_VALIDATION=1', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    process.env.ETHOS_SKIP_VALIDATION = '1';

    await run();

    expect(probeProvider).not.toHaveBeenCalled();
    expect(secretsSet).toHaveBeenCalledWith('providers/anthropic/apiKey', 'sk-ant-key');
  });

  it('never leaks the raw apiKey into the unreachable warning (secret redaction)', async () => {
    const apiKey = 'sk-ant-supersecret-abcdef0123456789';
    process.env.ANTHROPIC_API_KEY = apiKey;
    // Simulate an SDK error that echoes the key back (e.g. in a URL).
    probeProvider.mockResolvedValue({
      ok: false,
      reason: 'unreachable',
      error: `fetch failed for https://api/x?key=${apiKey}`,
    });

    await run();

    const warned = warnSpy.mock.calls.flat().join(' ');
    expect(warned).not.toContain(apiKey);
    expect(warned).toContain('[redacted]');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock wiring so getStorage/getSecretsResolver don't hit the filesystem.
vi.mock('../wiring', () => ({
  getStorage: () => ({}),
  getSecretsResolver: async () => ({}),
}));

// Mock config module — only readConfig needs to be swappable.
vi.mock('@ethosagent/config', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@ethosagent/config')>();
  return {
    ...orig,
    readConfig: vi.fn(),
  };
});

describe('ETHOS_MANAGED mode', () => {
  const originalEnv = process.env.ETHOS_MANAGED;

  beforeEach(() => {
    delete process.env.ETHOS_MANAGED;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ETHOS_MANAGED;
    } else {
      process.env.ETHOS_MANAGED = originalEnv;
    }
    vi.restoreAllMocks();
  });

  it('exits 2 with managed-mode message when ETHOS_MANAGED=1 and no config', async () => {
    process.env.ETHOS_MANAGED = '1';

    const { readConfig } = await import('@ethosagent/config');
    vi.mocked(readConfig).mockResolvedValue(null);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => {
      throw new Error(`process.exit(${_code})`);
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { loadRequiredConfig } = await import('../managed-mode');

    await expect(loadRequiredConfig()).rejects.toThrow('process.exit(2)');
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('managed mode (ETHOS_MANAGED=1)'),
    );

    stderrSpy.mockRestore();
  });

  it('returns config when ETHOS_MANAGED=1 and config exists', async () => {
    process.env.ETHOS_MANAGED = '1';

    const fakeConfig = { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' } as never;

    const { readConfig } = await import('@ethosagent/config');
    vi.mocked(readConfig).mockResolvedValue(fakeConfig);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => {
      throw new Error(`process.exit(${_code})`);
    });

    const { loadRequiredConfig } = await import('../managed-mode');

    const result = await loadRequiredConfig();
    expect(result).toBe(fakeConfig);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits 1 with "Run ethos setup first" when ETHOS_MANAGED is unset and no config', async () => {
    delete process.env.ETHOS_MANAGED;

    const { readConfig } = await import('@ethosagent/config');
    vi.mocked(readConfig).mockResolvedValue(null);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => {
      throw new Error(`process.exit(${_code})`);
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { loadRequiredConfig } = await import('../managed-mode');

    await expect(loadRequiredConfig()).rejects.toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith('Run ethos setup first.');
  });

  it('returns config when ETHOS_MANAGED is unset and config exists', async () => {
    delete process.env.ETHOS_MANAGED;

    const fakeConfig = { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' } as never;

    const { readConfig } = await import('@ethosagent/config');
    vi.mocked(readConfig).mockResolvedValue(fakeConfig);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => {
      throw new Error(`process.exit(${_code})`);
    });

    const { loadRequiredConfig } = await import('../managed-mode');

    const result = await loadRequiredConfig();
    expect(result).toBe(fakeConfig);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

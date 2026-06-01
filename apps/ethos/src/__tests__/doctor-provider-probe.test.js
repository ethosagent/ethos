import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock wiring — control createLLM and getStorage without hitting real infra.
const mockCreateLLM = vi.fn();
vi.mock('../wiring', () => ({
  getStorage: () => ({
    exists: async () => false,
    read: async () => null,
    write: async () => {},
    mkdir: async () => {},
    mtime: async () => null,
    list: async () => [],
  }),
  createLLM: (...args) => mockCreateLLM(...args),
}));
// Mock config — readRawConfig is swappable per test.
const mockReadRawConfig = vi.fn();
vi.mock('../config', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    readRawConfig: (...args) => mockReadRawConfig(...args),
  };
});
// Mock skills so the full doctor path doesn't try to scan the filesystem.
vi.mock('@ethosagent/skills', () => ({
  UniversalScanner: class {
    async scan() {
      return new Map();
    }
  },
  bundledSkillsSource: () => ({}),
}));
// Mock error-log to avoid filesystem access in the --recent-errors path.
vi.mock('../error-log', () => ({
  errorLogExists: () => false,
  errorLogPath: () => '/tmp/errors.jsonl',
  readRecentErrors: () => [],
}));
function fakeConfig(overrides = {}) {
  return {
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    apiKey: 'sk-ant-test',
    personality: 'researcher',
    ...overrides,
  };
}
describe('ethos doctor --check-provider', () => {
  let exitSpy;
  let stdoutSpy;
  let consoleSpy;
  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => {
      throw new Error(`process.exit(${_code})`);
    });
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockReadRawConfig.mockReset();
    mockCreateLLM.mockReset();
  });
  afterEach(() => {
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    consoleSpy.mockRestore();
  });
  it('reports reachable when provider responds (JSON mode)', async () => {
    mockReadRawConfig.mockResolvedValue(fakeConfig());
    // Simulate a successful 1-token completion.
    async function* fakeStream() {
      yield { type: 'text_delta', text: 'p' };
      yield { type: 'done', finishReason: 'end_turn' };
    }
    mockCreateLLM.mockResolvedValue({
      name: 'anthropic',
      model: 'claude-opus-4-7',
      complete: () => fakeStream(),
    });
    const { runDoctor } = await import('../commands/doctor');
    await runDoctor(['--check-provider', '--json']);
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const output = stdoutSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.provider).toBe('anthropic');
    expect(parsed.model).toBe('claude-opus-4-7');
    expect(parsed.reachable).toBe(true);
    expect(typeof parsed.latencyMs).toBe('number');
    expect(parsed.error).toBeNull();
    expect(parsed.exit).toBe(0);
  });
  it('reports unreachable when provider throws (JSON mode)', async () => {
    mockReadRawConfig.mockResolvedValue(fakeConfig());
    mockCreateLLM.mockResolvedValue({
      name: 'anthropic',
      model: 'claude-opus-4-7',
      complete: () => {
        throw new Error('Authentication failed');
      },
    });
    const { runDoctor } = await import('../commands/doctor');
    await expect(runDoctor(['--check-provider', '--json'])).rejects.toThrow('process.exit(1)');
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const output = stdoutSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.reachable).toBe(false);
    expect(parsed.error).toBe('Authentication failed');
    expect(parsed.latencyMs).toBeNull();
    expect(parsed.exit).toBe(1);
  });
  it('reports unreachable when config is missing (JSON mode)', async () => {
    mockReadRawConfig.mockResolvedValue(null);
    const { runDoctor } = await import('../commands/doctor');
    await expect(runDoctor(['--check-provider', '--json'])).rejects.toThrow('process.exit(1)');
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const output = stdoutSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.provider).toBe('unknown');
    expect(parsed.reachable).toBe(false);
    expect(parsed.error).toContain('No config found');
    expect(parsed.exit).toBe(1);
  });
  it('prints human-readable success without --json', async () => {
    mockReadRawConfig.mockResolvedValue(fakeConfig());
    async function* fakeStream() {
      yield { type: 'done', finishReason: 'end_turn' };
    }
    mockCreateLLM.mockResolvedValue({
      name: 'anthropic',
      model: 'claude-opus-4-7',
      complete: () => fakeStream(),
    });
    const { runDoctor } = await import('../commands/doctor');
    await runDoctor(['--check-provider']);
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const msg = consoleSpy.mock.calls[0][0];
    expect(msg).toContain('anthropic');
    expect(msg).toContain('claude-opus-4-7');
    expect(msg).toContain('ms');
  });
  it('prints human-readable failure without --json', async () => {
    mockReadRawConfig.mockResolvedValue(fakeConfig());
    mockCreateLLM.mockRejectedValue(new Error('Invalid API key'));
    const { runDoctor } = await import('../commands/doctor');
    await expect(runDoctor(['--check-provider'])).rejects.toThrow('process.exit(1)');
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const msg = consoleSpy.mock.calls[0][0];
    expect(msg).toContain('anthropic');
    expect(msg).toContain('Invalid API key');
  });
  it('plain doctor (no --check-provider) does NOT call createLLM', async () => {
    // --recent-errors returns early without hitting SDK checks or live calls,
    // proving the provider probe is opt-in rather than part of the default path.
    const { runDoctor } = await import('../commands/doctor');
    await runDoctor(['--recent-errors']);
    expect(mockCreateLLM).not.toHaveBeenCalled();
  });
});

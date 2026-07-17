import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Coverage for `ethos doctor --funnel` (W4.2): the duration formatter branches
// and the report renderer across null / legacy / full state, NO_COLOR, and the
// --json shape.

const readState = vi.fn();
vi.mock('../wiring', () => ({
  getFunnelTracker: () => ({ readState }),
}));

// Keep the static import of doctor.ts light — the funnel report path never
// scans skills, but importing the real scanner pulls a heavy dependency tree.
vi.mock('@ethosagent/skills', () => ({
  UniversalScanner: class {
    async scan() {
      return new Map();
    }
  },
  bundledSkillsSource: () => ({}),
}));

import { formatFunnelDuration, runFunnelReport } from '../commands/doctor';

describe('formatFunnelDuration', () => {
  it('renders sub-minute deltas as seconds', () => {
    expect(formatFunnelDuration(0)).toBe('0s');
    expect(formatFunnelDuration(8_400)).toBe('8s');
    expect(formatFunnelDuration(59_000)).toBe('59s');
  });

  it('renders minute deltas with optional trailing seconds', () => {
    expect(formatFunnelDuration(60_000)).toBe('1m');
    expect(formatFunnelDuration(128_000)).toBe('2m 8s');
  });

  it('renders hour deltas with optional trailing minutes', () => {
    expect(formatFunnelDuration(3_600_000)).toBe('1h');
    expect(formatFunnelDuration(3_600_000 + 5 * 60_000)).toBe('1h 5m');
  });
});

describe('runFunnelReport', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    readState.mockReset();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.NO_COLOR;
  });

  it('reports a legacy install when there is no setup stamp', async () => {
    readState.mockResolvedValue(null);
    await runFunnelReport(false);
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('legacy');
  });

  it('renders the full funnel with durations', async () => {
    const setup = 1_000_000;
    readState.mockResolvedValue({
      setupCompletedAt: setup,
      setupProvider: 'anthropic',
      setupWizardPath: 'env',
      setupChannels: ['telegram'],
      firstReplyAt: setup + 128_000,
      channelFirstReplyAt: { telegram: setup + 3_600_000 },
    });
    await runFunnelReport(false);
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('Setup completed');
    expect(out).toContain('+2m 8s');
    expect(out).toContain('+1h');
  });

  it('honors NO_COLOR (no ANSI escapes in output)', async () => {
    process.env.NO_COLOR = '1';
    readState.mockResolvedValue({ setupCompletedAt: 1_000_000, firstReplyAt: 1_060_000 });
    await runFunnelReport(false);
    const out = logSpy.mock.calls.flat().join('\n');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes
    expect(out).not.toMatch(/\x1b\[/);
  });

  it('--json emits the raw state object', async () => {
    const state = { setupCompletedAt: 42, firstReplyAt: 100 };
    readState.mockResolvedValue(state);
    await runFunnelReport(true);
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const written = (stdoutSpy.mock.calls[0] as string[])[0] as string;
    expect(JSON.parse(written)).toEqual(state);
  });

  it('--json emits {} when state is null', async () => {
    readState.mockResolvedValue(null);
    await runFunnelReport(true);
    const written = (stdoutSpy.mock.calls[0] as string[])[0] as string;
    expect(JSON.parse(written)).toEqual({});
  });
});

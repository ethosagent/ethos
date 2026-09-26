import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Plan hermes-0.21.4-fixes §7.6 — `ethos -z --format text|json|stream-json`
// driven through runZero with the same mocked wiring as zero-exit-code.test.ts.
// Every stdout line is JSON.parse'd: stdout is the protocol (D31, D32).

// The approval gate is pinned elsewhere (terminal-approval.test.ts); these
// fake loops carry no hook registry to wire it on.
vi.mock('../lib/non-interactive-approval', () => ({ gateNonInteractiveLoop: vi.fn() }));

vi.mock('../wiring', () => ({
  getStorage: vi.fn(() => ({})),
  getSecretsResolver: vi.fn(async () => ({})),
  resolveActiveLoop: vi.fn(),
}));

vi.mock('@ethosagent/config', () => ({
  readConfig: vi.fn(),
  ethosDir: vi.fn(() => '/tmp/ethos-test'),
}));

import { readConfig } from '@ethosagent/config';
import { parseZeroArgs, runZero } from '../commands/zero';
import { resolveActiveLoop } from '../wiring';

const FAKE_CONFIG = {
  provider: 'anthropic',
  model: 'claude-test',
  apiKey: 'k',
  personality: 'default',
};

type Line = Record<string, unknown> & { type: string; v: number };

let stdout: string[];
let stderr: string[];
let savedExitCode: number | string | undefined;
let savedIsTTY: boolean;
const savedConsole = { log: console.log, info: console.info, debug: console.debug };

function capture(sink: string[]) {
  return ((chunk: unknown, a?: unknown, b?: unknown) => {
    sink.push(String(chunk));
    const cb = typeof a === 'function' ? a : b;
    if (typeof cb === 'function') cb();
    return true;
  }) as typeof process.stdout.write;
}

function stdoutLines(): Line[] {
  const text = stdout.join('');
  expect(text.endsWith('\n')).toBe(true);
  return text
    .slice(0, -1)
    .split('\n')
    .map((l) => JSON.parse(l) as Line);
}

function useLoop(run: () => AsyncGenerator<unknown>) {
  vi.mocked(readConfig).mockResolvedValue(FAKE_CONFIG as never);
  vi.mocked(resolveActiveLoop).mockResolvedValue({
    loop: { run },
    personalityId: 'default',
  } as never);
}

async function* fullTurn() {
  yield { type: 'run_start', provider: 'anthropic', model: 'claude-test', source: 'default' };
  yield { type: 'text_delta', text: 'Hello' };
  yield { type: 'tool_start', toolCallId: 'c1', toolName: 'read_file', args: { path: 'a' } };
  yield { type: 'tool_end', toolCallId: 'c1', toolName: 'read_file', ok: true, durationMs: 4 };
  yield { type: 'usage', inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.01 };
  yield { type: 'halt', kind: 'budget', rule: 'tool-budget', message: 'stopped early' };
  yield { type: 'done', text: 'Hello', turnCount: 1, traceId: 'trace-1' };
  // After `done`: the drain rule says the turn is not over yet.
  yield { type: 'usage', inputTokens: 3, outputTokens: 0, estimatedCostUsd: 0.002 };
}

beforeEach(() => {
  stdout = [];
  stderr = [];
  savedExitCode = process.exitCode ?? undefined;
  process.exitCode = undefined;
  savedIsTTY = process.stdin.isTTY;
  process.stdin.isTTY = true;
  vi.spyOn(process.stdout, 'write').mockImplementation(capture(stdout));
  vi.spyOn(process.stderr, 'write').mockImplementation(capture(stderr));
});

afterEach(() => {
  process.exitCode = savedExitCode;
  process.stdin.isTTY = savedIsTTY;
  console.log = savedConsole.log;
  console.info = savedConsole.info;
  console.debug = savedConsole.debug;
  vi.restoreAllMocks();
});

describe('runZero --format stream-json', () => {
  it('writes init first, events, and exactly one result last, after the drained tail', async () => {
    useLoop(fullTurn);
    await runZero(['-z', '--format', 'stream-json', 'hello']);

    const lines = stdoutLines();
    expect(lines.every((l) => l.v === 1)).toBe(true);
    expect(lines[0]).toMatchObject({ type: 'init', personalityId: 'default' });
    expect(lines.at(-1)?.type).toBe('result');
    expect(lines.filter((l) => l.type === 'result')).toHaveLength(1);
    expect(lines.map((l) => l.type)).toEqual([
      'init',
      'run_start',
      'text_delta',
      'tool_start',
      'tool_end',
      'usage',
      'halt',
      'usage',
      'result',
    ]);

    const result = lines.at(-1);
    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      text: 'Hello',
      turnCount: 1,
      traceId: 'trace-1',
      usage: { inputTokens: 13, outputTokens: 5 },
      halt: { kind: 'budget', rule: 'tool-budget' },
      error: null,
    });
    const usage = result?.usage as { estimatedCostUsd: number } | undefined;
    expect(usage?.estimatedCostUsd).toBeCloseTo(0.012);
    expect(result?.sessionKey).toBe(lines[0]?.sessionKey);
    // A halt exits 0; the consumer reads it from result.halt.
    expect(process.exitCode).toBeUndefined();
  });

  it('keeps stdout pure JSON when something calls console.log', async () => {
    useLoop(async function* () {
      console.log('noise');
      yield { type: 'text_delta', text: 'hi' };
      yield { type: 'done', text: 'hi', turnCount: 1 };
    });
    await runZero(['-z', '--format', 'stream-json', 'hello']);

    expect(stdoutLines().at(-1)?.type).toBe('result');
    expect(stdout.join('')).not.toContain('noise');
    expect(stderr.join('')).toContain('noise');
  });

  it('reports an error event in result and exits 1', async () => {
    useLoop(async function* () {
      yield { type: 'error', error: 'model not found', code: 'PROVIDER_ERROR' };
      yield { type: 'done', text: '', turnCount: 1 };
    });
    await runZero(['-z', '--format', 'stream-json', 'hello']);

    const lines = stdoutLines();
    expect(lines.find((l) => l.type === 'error')).toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(lines.at(-1)).toMatchObject({
      type: 'result',
      ok: false,
      exitCode: 1,
      error: { code: 'PROVIDER_ERROR', message: 'model not found' },
    });
    expect(process.exitCode).toBe(1);
  });

  it('writes a result line when the loop throws', async () => {
    useLoop(
      // biome-ignore lint/correctness/useYield: throws before yielding
      async function* () {
        throw new Error('boom');
      },
    );
    await runZero(['-z', '--format', 'stream-json', 'hello']);

    const lines = stdoutLines();
    expect(lines.at(-1)).toMatchObject({ type: 'result', ok: false, exitCode: 1 });
    const error = lines.at(-1)?.error as { message: string } | undefined;
    expect(error?.message).toBe('boom');
    expect(process.exitCode).toBe(1);
  });

  it('writes one result line when no config exists', async () => {
    vi.mocked(readConfig).mockResolvedValue(null as never);
    await runZero(['-z', '--format', 'stream-json', 'hello']);

    const lines = stdoutLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      type: 'result',
      ok: false,
      exitCode: 1,
      error: { code: 'CONFIG_MISSING' },
    });
    expect(process.exitCode).toBe(1);
  });

  it('writes a result line for a setup throw, then rethrows it to the top-level handler', async () => {
    vi.mocked(readConfig).mockResolvedValue(FAKE_CONFIG as never);
    vi.mocked(resolveActiveLoop).mockRejectedValue(new Error('wiring failed'));

    await expect(runZero(['-z', '--format', 'json', 'hello'])).rejects.toThrow('wiring failed');
    const lines = stdoutLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ type: 'result', ok: false, exitCode: 1 });
    expect(process.exitCode).toBe(1);
  });
});

describe('runZero --format json', () => {
  it('prints exactly one line, the result', async () => {
    useLoop(fullTurn);
    await runZero(['-z', '--format', 'json', 'hello']);

    const lines = stdoutLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ type: 'result', ok: true, text: 'Hello' });
  });
});

describe('runZero --format text', () => {
  it('is byte-identical to the default text output', async () => {
    const run = async function* () {
      yield { type: 'text_delta', text: 'Let me look that up.' };
      yield { type: 'done', text: 'DIRECT ANSWER', turnCount: 1 };
    };
    useLoop(run);
    await runZero(['-z', '--format', 'text', 'hello']);
    const explicit = stdout.join('');

    stdout.length = 0;
    useLoop(run);
    await runZero(['-z', 'hello']);

    expect(explicit).toBe('Let me look that up.\n\nDIRECT ANSWER\n');
    expect(stdout.join('')).toBe(explicit);
  });

  it('refuses an unknown --format with nothing on stdout', async () => {
    await runZero(['-z', '--format', 'xml', 'hello']);
    expect(stdout.join('')).toBe('');
    expect(stderr.join('')).toContain('xml');
    expect(process.exitCode).toBe(1);
  });
});

// openclaw-9.5 item 1 — `-z` has no masked input: a turn refused for a
// missing plugin credential ends with the one-line CLI instruction.
describe('runZero — credential_required', () => {
  const CMD = 'ethos plugin credentials weather --set API_KEY';
  async function* refused() {
    yield {
      type: 'credential_required',
      pluginId: 'weather',
      credentialKey: 'API_KEY',
      kind: 'api_key',
      label: 'Weather API key',
      sessionKey: 'k',
      pendingUserMessage: 'forecast?',
    };
    yield { type: 'done', text: '', turnCount: 0 };
  }

  it('text: opts in, prints the instruction on stderr, exits 1', async () => {
    const run = vi.fn(refused);
    useLoop(run);
    await runZero(['-z', 'forecast?']);
    expect(run).toHaveBeenCalledWith(
      'forecast?',
      expect.objectContaining({ credentialPrompt: true }),
    );
    expect(stderr.join('')).toContain(CMD);
    expect(process.exitCode).toBe(1);
  });

  for (const format of ['json', 'stream-json'] as const) {
    it(`${format}: result.error carries CREDENTIAL_REQUIRED and the instruction`, async () => {
      useLoop(refused);
      await runZero(['-z', '--format', format, 'forecast?']);
      const lines = stdoutLines();
      // The event itself stays off the wire (allow-list, D27).
      expect(lines.some((l) => l.type === 'credential_required')).toBe(false);
      const result = lines.at(-1);
      expect(result).toMatchObject({ type: 'result', ok: false, exitCode: 1 });
      const error = result?.error as { code: string; message: string } | undefined;
      expect(error?.code).toBe('CREDENTIAL_REQUIRED');
      expect(error?.message).toContain(CMD);
      expect(stderr.join('')).toContain(CMD);
      expect(process.exitCode).toBe(1);
    });
  }
});

describe('parseZeroArgs', () => {
  it('takes the first token after -z that is not a known flag or its value', () => {
    expect(parseZeroArgs(['-z', '--format', 'stream-json', '--model', 'm', 'hi'])).toMatchObject({
      prompt: 'hi',
      format: 'stream-json',
    });
    expect(parseZeroArgs(['-z', '-5 degrees?']).prompt).toBe('-5 degrees?');
    expect(parseZeroArgs(['--zero', '--no-stream', 'hi'])).toMatchObject({
      prompt: 'hi',
      noStream: true,
      format: 'text',
    });
    expect(parseZeroArgs(['-z', '--session', 'k1', 'hi'])).toMatchObject({
      prompt: 'hi',
      sessionKey: 'k1',
    });
  });

  it('refuses a --format outside text|json|stream-json', () => {
    expect(() => parseZeroArgs(['-z', '--format', 'xml', 'hi'])).toThrow(/xml/);
    expect(() => parseZeroArgs(['-z', 'hi', '--format'])).toThrow(/--format/);
  });
});

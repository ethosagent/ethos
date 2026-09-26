import { describe, expect, it } from 'vitest';
import { EthosError, formatError, isEthosError, toEthosError } from '../errors';

describe('EthosError', () => {
  it('extends Error and exposes structured fields', () => {
    const err = new EthosError({
      code: 'INVALID_INPUT',
      cause: 'foo missing',
      action: 'pass --foo',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('EthosError');
    expect(err.message).toBe('foo missing');
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.cause).toBe('foo missing');
    expect(err.action).toBe('pass --foo');
  });

  it('isEthosError narrows', () => {
    const err: unknown = new EthosError({ code: 'INTERNAL', cause: 'x', action: 'y' });
    expect(isEthosError(err)).toBe(true);
    expect(isEthosError(new Error('boom'))).toBe(false);
    expect(isEthosError('string')).toBe(false);
    expect(isEthosError(null)).toBe(false);
  });

  it('toEthosError passes through EthosError instances', () => {
    const original = new EthosError({
      code: 'CONFIG_MISSING',
      cause: 'no config',
      action: 'setup',
    });
    expect(toEthosError(original)).toBe(original);
  });

  it('toEthosError wraps plain Error with INTERNAL by default', () => {
    const wrapped = toEthosError(new Error('boom'));
    expect(wrapped).toBeInstanceOf(EthosError);
    expect(wrapped.code).toBe('INTERNAL');
    expect(wrapped.cause).toBe('boom');
  });

  it('toEthosError respects fallbackCode', () => {
    const wrapped = toEthosError(new Error('net down'), 'NETWORK_ERROR');
    expect(wrapped.code).toBe('NETWORK_ERROR');
  });

  it('toEthosError handles non-Error throwables', () => {
    const wrapped = toEthosError('plain string');
    expect(wrapped.code).toBe('INTERNAL');
    expect(wrapped.cause).toBe('plain string');
  });

  it('formatError renders code, cause, and action', () => {
    const err = new EthosError({
      code: 'INVALID_INPUT',
      cause: '--foo missing',
      action: 'pass --foo',
    });
    const out = formatError(err);
    expect(out).toContain('INVALID_INPUT');
    expect(out).toContain('--foo missing');
    expect(out).toContain('pass --foo');
    // Default: no ANSI escapes
    expect(out).not.toContain('\x1b[');
  });

  it('formatError emits ANSI when color: true', () => {
    const err = new EthosError({ code: 'INTERNAL', cause: 'x', action: 'y' });
    const out = formatError(err, { color: true });
    expect(out).toContain('\x1b[');
  });

  // N2 — the error path points at the diagnostics it just wrote.
  it('formatError appends a diagnostics line when diagnostics are given', () => {
    const err = new EthosError({ code: 'INTERNAL', cause: 'x', action: 'y' });
    const out = formatError(err, {
      diagnostics: { logPath: '~/.ethos/errors.log', traceId: '7f3a2c1e' },
    });
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe(
      '  logged ~/.ethos/errors.log · ethos errors --recent 5 · ethos trace 7f3a2c1e',
    );
  });

  it('formatError omits the trace segment when no traceId is given', () => {
    const err = new EthosError({ code: 'INTERNAL', cause: 'x', action: 'y' });
    const out = formatError(err, { diagnostics: { logPath: '~/.ethos/errors.log' } });
    expect(out).toContain('logged ~/.ethos/errors.log · ethos errors --recent 5');
    expect(out).not.toContain('ethos trace');
  });

  it('formatError renders no diagnostics line when diagnostics are absent', () => {
    const err = new EthosError({ code: 'INTERNAL', cause: 'x', action: 'y' });
    expect(formatError(err).split('\n')).toHaveLength(2);
    expect(formatError(err)).not.toContain('logged');
  });

  it('the diagnostics line is dim when color is on', () => {
    const err = new EthosError({ code: 'INTERNAL', cause: 'x', action: 'y' });
    const out = formatError(err, {
      color: true,
      diagnostics: { logPath: '/tmp/errors.log' },
    });
    const last = out.split('\n')[2] ?? '';
    expect(last).toContain('\x1b[2m');
  });
});

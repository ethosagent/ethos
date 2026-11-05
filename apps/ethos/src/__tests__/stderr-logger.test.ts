import { afterEach, describe, expect, it, vi } from 'vitest';
import { StderrLogger } from '../logger';

describe('StderrLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function spy() {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    return { err, out, log };
  }

  it('writes info lines with meta to stderr in ConsoleLogger format, nothing on stdout', () => {
    const { err, out, log } = spy();
    new StderrLogger({ component: 'mcp' }).info('mcp.oauth.login', { server: 'x', n: 2 });
    expect(err).toHaveBeenCalledWith('[mcp] mcp.oauth.login server=x n=2\n');
    expect(out).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('child() merges meta over base meta', () => {
    const { err } = spy();
    new StderrLogger({ component: 'mcp' }).child({ server: 'y' }).warn('hello');
    expect(err).toHaveBeenCalledWith('[mcp] hello server=y\n');
  });

  it('honours the level gate', () => {
    const { err } = spy();
    new StderrLogger({ component: 'mcp' }, 'warn').info('quiet');
    expect(err).not.toHaveBeenCalled();
  });
});

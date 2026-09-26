// A config the gateway cannot start with exits CONFIG_INVALID_EXIT_CODE (78,
// EX_CONFIG), not 1, and points at `ethos doctor` (plan openclaw-2026.9.6-gaps
// R3). Exit 1 is "crashed, restart me": under `Restart=on-failure` a bad config
// restarted every 5s forever, re-polling the platform on each attempt.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_INVALID_EXIT_CODE, GATEWAY_LOCK_EXIT_CODE } from '@ethosagent/wiring';
import { describe, expect, it, vi } from 'vitest';
import { exitIfConfigInvalid } from '../lib/config-exit';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

describe('exitIfConfigInvalid', () => {
  it('is 78 (EX_CONFIG) and distinct from the lock-held code', () => {
    expect(CONFIG_INVALID_EXIT_CODE).toBe(78);
    expect(CONFIG_INVALID_EXIT_CODE).not.toBe(GATEWAY_LOCK_EXIT_CODE);
  });

  it('a config parse failure prints each error, suggests ethos doctor, and exits 78', () => {
    const lines: string[] = [];
    const exit = vi.fn();
    exitIfConfigInvalid('Config parse errors', ['bind.type: unknown "persona"'], {
      log: (line) => lines.push(line),
      exit,
    });
    expect(exit).toHaveBeenCalledWith(CONFIG_INVALID_EXIT_CODE);
    const out = lines.join('\n');
    expect(out).toContain('Config parse errors');
    expect(out).toContain('bind.type: unknown "persona"');
    expect(out).toContain('ethos doctor');
  });

  it('no errors: prints nothing and does not exit', () => {
    const log = vi.fn();
    const exit = vi.fn();
    exitIfConfigInvalid('Config parse errors', [], { log, exit });
    expect(log).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  for (const file of ['gateway.ts', 'boot.ts']) {
    it(`${file} routes its parse and binding errors through it`, async () => {
      const src = await readFile(join(ROOT, 'apps/ethos/src/commands', file), 'utf8');
      expect(src).toMatch(/exitIfConfigInvalid\('Config parse errors', loaded\.parseErrors\)/);
      expect(src).toMatch(/exitIfConfigInvalid\('Bot binding errors', bindErrors\)/);
    });
  }
});

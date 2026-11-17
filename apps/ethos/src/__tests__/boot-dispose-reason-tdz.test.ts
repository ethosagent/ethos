// `releaseBotLoops` (commands/boot.ts) formats a rejected loop dispose with
// `reason(...)`. It runs during cold boot: when a cold-booted bot's
// `registerBotLive` throws, its `undo()` releases the bot's loops, and a
// dispose that rejects there calls `reason`. `reason` used to be declared
// ~700 lines further down `runBoot`, so that call hit the temporal dead zone
// and threw a ReferenceError out of `undo()` — replacing the registration
// error the operator needed with "Cannot access 'reason' before
// initialization".
//
// Source-level, like the other boot wiring tests: `runBoot` is a long-running
// composition root that cannot run under vitest.

import { describe, expect, it } from 'vitest';
import { readBootSource } from '../commands/__tests__/boot-sources';

describe('boot — the dispose reason formatter is in scope before any release', () => {
  it('declares `reason` once, above `releaseBotLoops` and the cold-boot registration', () => {
    const src = readBootSource('boot.ts');
    const decl = 'const reason = (err: unknown): string =>';
    expect(src.split(decl).length - 1).toBe(1);
    const at = src.indexOf(decl);
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(src.indexOf('const releaseBotLoops = async ('));
    expect(at).toBeLessThan(src.indexOf('await registerBotLive(bot, wiring, own ? [own] : [])'));
  });
});

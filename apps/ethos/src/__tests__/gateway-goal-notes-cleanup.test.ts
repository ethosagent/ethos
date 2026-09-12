import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DefaultHookRegistry } from '@ethosagent/core';
import { registerGoalNotifications } from '@ethosagent/goal-runner';
import { describe, expect, it, vi } from 'vitest';

// `registerGoalNotifications` returns the cleanup for the three hooks it puts
// on a BORROWED registry (the loop's). The gateway discarded it, so a loop
// rebuilt in-process (config reload, bot hot-add) kept every earlier
// registration firing into a gateway that no longer routes for it. The cleanup
// now runs with that loop's own runtime release.

describe('registerGoalNotifications cleanup', () => {
  it('takes its hooks back off the borrowed registry', async () => {
    const hooks = new DefaultHookRegistry();
    const send = vi.fn(async () => {});
    const off = registerGoalNotifications(hooks, send);

    await hooks.fireVoid('goal_completed', {
      goalId: 'g1',
      title: 't',
      summary: 's',
      outputMd: '',
      origin: 'telegram:-100',
      personalityId: 'p',
      costUsd: null,
      durationMs: 1,
    });
    expect(send).toHaveBeenCalledTimes(1);

    off();
    await hooks.fireVoid('goal_completed', {
      goalId: 'g2',
      title: 't',
      summary: 's',
      outputMd: '',
      origin: 'telegram:-100',
      personalityId: 'p',
      costUsd: null,
      durationMs: 1,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('is kept and released by the gateway, per loop', async () => {
    const root = join(import.meta.dirname, '..', '..', '..', '..');
    const src = await readFile(join(root, 'apps/ethos/src/commands/gateway.ts'), 'utf8');
    // Each bot's cleanup runs before that bot's runtime release...
    expect(src).toMatch(
      /const off = registerGoalNotifications\(bot\.loop\.hooks, sendGoalNote\);\s*\n\s*botLoopDisposers\.unshift\(async \(\) => off\(\)\);/,
    );
    // ...and the system loop's runs with its own.
    expect(src).toContain('goalNoteCleanups.push(offSystemGoalNotes);');
    expect(src).toMatch(/for \(const off of goalNoteCleanups\.splice\(0\)\) off\(\);/);
  });
});

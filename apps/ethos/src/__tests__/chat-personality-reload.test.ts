// N3 (plan ux-feedback-and-config-clarity §4) — the chat REPL reloads the
// personality registry before each turn and prints one dim line per failure
// (serving last-good) and per reload. Once per content change is the
// registry's fingerprint contract: `lastLoadReport` is replaced whole per
// call and an unchanged directory contributes nothing.

import { describe, expect, it } from 'vitest';
import {
  createPersonalityReloadNotifier,
  type PersonalityLoadReportLike,
  type ReloadablePersonalityRegistry,
} from '../lib/personality-reload';

function fakeRegistry(opts: {
  report?: PersonalityLoadReportLike;
  throws?: boolean;
}): ReloadablePersonalityRegistry & { calls: string[] } {
  const registry = {
    calls: [] as string[],
    lastLoadReport: opts.report ?? { failures: [], reloaded: [] },
    async loadFromDirectory(dir: string) {
      registry.calls.push(dir);
      if (opts.throws) throw new Error('1 of 3 failed to load');
    },
  };
  return registry;
}

describe('chat personality reload (N3)', () => {
  it('a failure is named with its error, marked as serving last-good', async () => {
    const registry = fakeRegistry({
      report: {
        failures: [{ id: 'reviewer', error: "config.yaml:4 unknown model alias 'opus-fast'" }],
        reloaded: [],
      },
      // loadFromDirectory still throws on failures — the notifier reads the
      // report that survives the throw instead of letting the turn die.
      throws: true,
    });
    const refresh = createPersonalityReloadNotifier(() => registry, '/tmp/personalities');

    const lines = await refresh();
    expect(registry.calls).toEqual(['/tmp/personalities']);
    expect(lines).toEqual([
      "[personality] reviewer: config.yaml:4 unknown model alias 'opus-fast' — serving last-good copy",
    ]);
  });

  it('a reload names the personality and the changed inputs', async () => {
    const registry = fakeRegistry({
      report: { failures: [], reloaded: [{ id: 'engineer', changed: ['SOUL.md'] }] },
    });
    const refresh = createPersonalityReloadNotifier(() => registry, '/tmp/p');

    expect(await refresh()).toEqual(['[personality] engineer reloaded (SOUL.md changed)']);
  });

  it('an unchanged directory prints nothing (empty report per registry contract)', async () => {
    const registry = fakeRegistry({});
    const refresh = createPersonalityReloadNotifier(() => registry, '/tmp/p');
    expect(await refresh()).toEqual([]);
  });

  it('a registry without lastLoadReport (plain contract) prints nothing', async () => {
    const calls: string[] = [];
    const refresh = createPersonalityReloadNotifier(
      () => ({
        async loadFromDirectory(dir: string) {
          calls.push(dir);
        },
      }),
      '/tmp/p',
    );
    expect(await refresh()).toEqual([]);
    expect(calls).toEqual(['/tmp/p']);
  });

  it('the getter is read per refresh, so a /model rebuild swaps the registry', async () => {
    const first = fakeRegistry({});
    const second = fakeRegistry({
      report: { failures: [], reloaded: [{ id: 'coach', changed: ['toolset.yaml'] }] },
    });
    let current: ReloadablePersonalityRegistry = first;
    const refresh = createPersonalityReloadNotifier(() => current, '/tmp/p');

    await refresh();
    current = second;
    expect(await refresh()).toEqual(['[personality] coach reloaded (toolset.yaml changed)']);
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
  });
});

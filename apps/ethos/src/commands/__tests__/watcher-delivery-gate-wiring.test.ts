// O-T12 (plan/phases/trust-before-reach.md) — every root that constructs a
// `WatcherManager` gives it its delivery gate AT CONSTRUCTION.
//
// The delivery-time hold (`WatcherManager.dispatchChange`) is unit-tested in
// `extensions/tools-watchers/src/__tests__/outbox-deliver-refusal.test.ts`. What
// a unit test cannot see is whether a root passes the gate at all: absent, every
// stored `deliver` goes out and every gate test still passes. The gate used to
// be late-bound by each composed loop, which left a tick before the first loop
// unchecked and let the last-composed loop's gate win in a multi-bot gateway.
//
// Each gate also gets `reload` over that same registry: a watcher fires off the
// cron tick, with no turn in between to refresh personalities, so the gate must
// reload before it reads `outbound_policy`. The behaviour is pinned by
// `packages/wiring/src/__tests__/watcher-policy-refresh.test.ts`.
//
// A source scan, the shape `__tests__/outbox-gate-live.test.ts` already uses.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMMANDS = join(import.meta.dirname, '..');
const read = (name: string) => readFileSync(join(COMMANDS, name), 'utf8');

// [root, source, the registry declaration the gate reads]
const ROOTS: ReadonlyArray<readonly [string, string, string]> = [
  [
    'gateway.ts',
    read('gateway.ts'),
    '\n  const seamPersonalities = await createPersonalityRegistry(',
  ],
  ['boot.ts', read('boot.ts'), '\n  const personalities = await createPersonalityRegistry({'],
  ['serve.ts', read('serve.ts'), '\n  const personalities = await createPersonalityRegistry({'],
];

describe.each(ROOTS)('%s', (_name, source, registryDecl) => {
  it('constructs its WatcherManager with a policy delivery gate', () => {
    const call = source.slice(source.indexOf('new WatcherManager({'));
    expect(call.slice(0, call.indexOf('\n  });'))).toContain(
      'deliveryGate: createOutboundPolicyGate({',
    );
  });

  it('reloads the registry the gate reads before each delivery decision', () => {
    const call = source.slice(source.indexOf('new WatcherManager({'));
    const gate = call.slice(call.indexOf('deliveryGate: createOutboundPolicyGate({'));
    const reload = gate
      .slice(0, gate.indexOf('\n    }),'))
      .match(/reload: \(\) => (\w+)\.loadFromDirectory\(/);
    const registryName = registryDecl.match(/const (\w+) =/)?.[1];
    expect(reload?.[1]).toBe(registryName);
  });

  it('declares the registry the gate reads before the manager is constructed', () => {
    const registry = source.indexOf(registryDecl);
    expect(registry).toBeGreaterThan(-1);
    expect(registry).toBeLessThan(source.indexOf('new WatcherManager({'));
  });
});

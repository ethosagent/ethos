// O-T3/O-T12 (plan/phases/trust-before-reach.md) — the policy half of the
// approval gate.
//
// `outbound_policy` lives on the personality, so wiring is the only layer that
// can answer "does this send need approval". The two tool packages that ask
// (`@ethosagent/tools-messaging`, `@ethosagent/tools-watchers`) declare the
// shape structurally and never import each other or this; `createOutboxGate` is
// the one implementation both get.

import type { PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createOutboxGate, type OutboxWiring } from '../compose-tools';

const GATED: PersonalityConfig = {
  id: 'coordinator',
  name: 'Coordinator',
  outbound_policy: { approve_before_send: true },
};

const SLACK_ONLY: PersonalityConfig = {
  id: 'pr',
  name: 'PR',
  outbound_policy: { approve_before_send: true, channels: ['slack'] },
};

const OFF: PersonalityConfig = {
  id: 'support',
  name: 'Support',
  outbound_policy: { approve_before_send: false, channels: ['telegram'] },
};

const NO_POLICY: PersonalityConfig = { id: 'plain', name: 'Plain' };

const OUTBOX: OutboxWiring = {
  ownerTarget: (platform) => (platform === 'telegram' ? '4242' : undefined),
  propose: async () => ({ ok: true, itemId: 'obx_1', revision: 1 }),
};

function gateOver(...people: PersonalityConfig[]) {
  const registry = new Map(people.map((p) => [p.id, p]));
  return {
    registry,
    gate: createOutboxGate({
      lookupPersonality: (id) => registry.get(id),
      outbox: OUTBOX,
    }),
  };
}

describe('createOutboxGate', () => {
  it('gates every platform when channels is absent', () => {
    const { gate } = gateOver(GATED);
    expect(gate.gates('coordinator', 'telegram')).toBe(true);
    expect(gate.gates('coordinator', 'slack')).toBe(true);
  });

  it('gates only the platforms channels names', () => {
    const { gate } = gateOver(SLACK_ONLY);
    expect(gate.gates('pr', 'slack')).toBe(true);
    expect(gate.gates('pr', 'telegram')).toBe(false);
  });

  it('reads an empty channels list as every platform, not as none', () => {
    const { gate } = gateOver({
      id: 'empty',
      name: 'Empty',
      outbound_policy: { approve_before_send: true, channels: [] },
    });
    expect(gate.gates('empty', 'telegram')).toBe(true);
  });

  it('ignores channels when approve_before_send is off', () => {
    const { gate } = gateOver(OFF);
    expect(gate.gates('support', 'telegram')).toBe(false);
  });

  it('does not gate a personality with no policy, or one it has never heard of', () => {
    const { gate } = gateOver(NO_POLICY);
    expect(gate.gates('plain', 'telegram')).toBe(false);
    expect(gate.gates('ghost', 'telegram')).toBe(false);
  });

  it('reads the policy on every call, so a hot-reloaded personality applies next call', () => {
    const { registry, gate } = gateOver(NO_POLICY);
    expect(gate.gates('plain', 'telegram')).toBe(false);

    // What `FilePersonalityRegistry.loadFromDirectory` does when the file's
    // mtime moves: the same id, a new config object.
    registry.set('plain', {
      id: 'plain',
      name: 'Plain',
      outbound_policy: { approve_before_send: true },
    });

    expect(gate.gates('plain', 'telegram')).toBe(true);
  });

  it('passes the operator’s own chat and the proposal through to the app layer', async () => {
    const { gate } = gateOver(GATED);
    expect(gate.ownerTarget('telegram')).toBe('4242');
    expect(gate.ownerTarget('slack')).toBeUndefined();
    await expect(
      gate.propose({
        personalityId: 'coordinator',
        platform: 'telegram',
        target: 'C1',
        body: 'hi',
      }),
    ).resolves.toEqual({ ok: true, itemId: 'obx_1', revision: 1 });
  });
});

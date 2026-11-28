// plan world-model 8.4: the optional "World changes" section. The source is injected
// (`WeeklyDigestInput.worldChanges`), so this package never imports world-service. The
// audience filter lives in `buildWeeklyDigest` (`worldSection`), pinned here.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { buildWeeklyDigest, type WorldChangesReport, type WorldDigestEntry } from '../index';

const now = new Date('2026-06-17T12:00:00Z');
const DISCLAIMER = 'A graph path is a reason to look, not advice.';
const personalities: PersonalityConfig[] = [{ id: 'coder', name: 'coder' }];

const watch: WorldDigestEntry = {
  world: 'watch',
  audience: 'shareable',
  linksOpened: 3,
  linksClosed: 1,
  newEvents: ['fab outage'],
  pendingProposals: 2,
  ripples: ['fab outage: FABR → NVX → SKYC (sources: https://news.example/a)'],
};
const vault: WorldDigestEntry = {
  world: 'vault',
  audience: 'owner_only',
  linksOpened: 9,
  linksClosed: 4,
  newEvents: ['secret merger'],
  pendingProposals: 5,
  ripples: ['secret merger: ACME → BOLT (sources: https://private.example/x)'],
};

function digest(
  worlds: WorldDigestEntry[] | undefined,
  deliveryAudience?: 'private' | 'shared',
): Promise<string> {
  const windows: Array<{ from: Date; to: Date }> = [];
  const report: WorldChangesReport = { worlds: worlds ?? [], rippleDisclaimer: DISCLAIMER };
  return buildWeeklyDigest({
    personalities,
    storage: new InMemoryStorage(),
    dataDir: '/tmp/ethos-digest-world',
    now,
    ...(worlds
      ? {
          worldChanges: async (w) => {
            windows.push(w);
            return report;
          },
        }
      : {}),
    ...(deliveryAudience ? { deliveryAudience } : {}),
  });
}

describe('digest world section', () => {
  it('section lists opened/closed counts and ripple notices', async () => {
    const md = await digest([watch], 'shared');
    expect(md).toContain('## World changes');
    expect(md).toContain('### watch');
    expect(md).toContain('Links opened: 3, closed: 1');
    expect(md).toContain('New events: fab outage');
    expect(md).toContain('Pending proposals: 2');
    expect(md).toContain('fab outage: FABR → NVX → SKYC (sources: https://news.example/a)');
    expect(md).toContain(DISCLAIMER);
  });

  it('owner_only world omitted when the digest target is shared', async () => {
    for (const audience of ['shared', undefined] as const) {
      const md = await digest([watch, vault], audience);
      expect(md).toContain('### watch');
      expect(md).not.toContain('vault');
      expect(md).not.toContain('secret merger');
    }
    const priv = await digest([watch, vault], 'private');
    expect(priv).toContain('### vault');
    expect(priv).toContain('secret merger');
    // Only owner_only content on a shared target: no section at all.
    expect(await digest([vault], 'shared')).not.toContain('World changes');
  });

  it('no worlds → no section, digest byte-identical', async () => {
    const plain = await digest(undefined);
    expect(plain).not.toContain('World changes');
    expect(await digest([], 'private')).toBe(plain);
    expect(await digest([], undefined)).toBe(plain);
    const quiet: WorldDigestEntry = {
      ...watch,
      linksOpened: 0,
      linksClosed: 0,
      newEvents: [],
      pendingProposals: 0,
      ripples: [],
    };
    expect(await digest([quiet], 'private')).toBe(plain);
  });

  it('a failing source leaves the digest intact and reports through onError', async () => {
    const errors: unknown[] = [];
    const md = await buildWeeklyDigest({
      personalities,
      storage: new InMemoryStorage(),
      dataDir: '/tmp/ethos-digest-world',
      now,
      worldChanges: async () => {
        throw new Error('backend down');
      },
      onError: (e) => errors.push(e),
    });
    expect(md).not.toContain('World changes');
    expect(errors).toHaveLength(1);
  });
});

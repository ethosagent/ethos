import { describe, expect, it } from 'vitest';
import { contract } from '../router';
import {
  WorldIdSchema,
  WorldsDecideInputSchema,
  WorldsDecideOutputSchema,
  WorldsGraphInputSchema,
  WorldsGraphOutputSchema,
  WorldsListInputSchema,
  WorldsListOutputSchema,
  WorldsMountsSaveInputSchema,
  WorldsMountsSaveOutputSchema,
  WorldsSchemaSaveInputSchema,
  WorldsShareCreateInputSchema,
  WorldsShareCreateOutputSchema,
} from '../schemas';

// plan world-model Task 7.1: the request/response examples parse, objects are strict,
// the world id regex and the hops/limit caps hold.

describe('worlds contract', () => {
  it('mounts all 21 routes', () => {
    expect(Object.keys(contract.worlds).sort()).toEqual(
      [
        'list',
        'graph',
        'tree',
        'entity',
        'changes',
        'proposals',
        'decide',
        'factWrite',
        'factClose',
        'promote',
        'schema',
        'schemaSave',
        'config',
        'configSave',
        'mounts',
        'mountsSave',
        'export',
        'import',
        'buildPreview',
        'shareCreate',
        'linkify',
      ].sort(),
    );
  });

  it('world id regex', () => {
    for (const ok of ['world:acme', 'personality:engineer', 'world:a-1']) {
      expect(WorldIdSchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of [
      'acme',
      'world:',
      'world:Acme',
      'team:acme',
      'world:a_b',
      'world:a b',
      ' world:a',
    ]) {
      expect(WorldIdSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('strictness: unknown keys are rejected on input and output', () => {
    expect(WorldsListInputSchema.safeParse({ extra: 1 }).success).toBe(false);
    expect(
      WorldsDecideInputSchema.safeParse({ proposalId: 'p', verdict: 'accept', x: 1 }).success,
    ).toBe(false);
    expect(
      WorldsDecideOutputSchema.safeParse({ ok: true, applied: [], closed: [], x: 1 }).success,
    ).toBe(false);
    expect(WorldsGraphInputSchema.safeParse({ world: 'world:acme', bogus: true }).success).toBe(
      false,
    );
  });

  it('hops and limit caps', () => {
    const base = { world: 'world:acme' };
    expect(WorldsGraphInputSchema.safeParse({ ...base, hops: 3, limit: 2000 }).success).toBe(true);
    expect(WorldsGraphInputSchema.safeParse({ ...base, hops: 4 }).success).toBe(false);
    expect(WorldsGraphInputSchema.safeParse({ ...base, limit: 2001 }).success).toBe(false);
    expect(WorldsGraphInputSchema.safeParse({ ...base, limit: 0 }).success).toBe(false);
    expect(WorldsGraphInputSchema.safeParse({ ...base, hops: -1 }).success).toBe(false);
  });

  it('list example', () => {
    expect(WorldsListInputSchema.safeParse({}).success).toBe(true);
    const out = {
      worlds: [
        {
          id: 'world:acme',
          title: 'Acme company',
          audience: 'owner_only',
          backend: 'sqlite',
          counts: { entities: 68, liveEdges: 130, pendingProposals: 4 },
          mountedBy: [
            { personalityId: 'engineer', mode: 'read', effective: 'read' },
            {
              personalityId: 'curator',
              mode: 'propose',
              effective: 'read',
              note: 'not in proposers',
            },
          ],
        },
      ],
    };
    expect(WorldsListOutputSchema.safeParse(out).success).toBe(true);
  });

  it('graph example', () => {
    expect(
      WorldsGraphInputSchema.safeParse({
        world: 'world:acme',
        asOf: '2026-11-21',
        focus: 'e-9f2c01ab33de4410',
        hops: 2,
        types: ['Person', 'Team'],
        limit: 300,
      }).success,
    ).toBe(true);
    expect(
      WorldsGraphOutputSchema.safeParse({
        nodes: [{ id: 'e-1', type: 'Person', name: 'Ravi', isNew: false }],
        edges: [
          {
            id: 'r-1',
            type: 'owns',
            from: 'e-1',
            to: 'e-2',
            validFrom: '2026-11-20',
            validTo: null,
            author: 'user',
          },
        ],
        truncated: false,
      }).success,
    ).toBe(true);
  });

  it('decide example', () => {
    expect(
      WorldsDecideInputSchema.safeParse({ proposalId: 'p-51aa', verdict: 'accept' }).success,
    ).toBe(true);
    expect(
      WorldsDecideInputSchema.safeParse({ proposalId: 'p-51aa', verdict: 'maybe' }).success,
    ).toBe(false);
    expect(
      WorldsDecideOutputSchema.safeParse({ ok: true, applied: ['r-1'], closed: ['r-2'] }).success,
    ).toBe(true);
  });

  it('schemaSave example', () => {
    const ok = { world: 'world:acme', yaml: 'version: 5\nentities: {}', expectedVersion: 4 };
    expect(WorldsSchemaSaveInputSchema.safeParse(ok).success).toBe(true);
    expect(
      WorldsSchemaSaveInputSchema.safeParse({ ...ok, expectedVersion: undefined }).success,
    ).toBe(false);
  });

  it('mountsSave example', () => {
    expect(
      WorldsMountsSaveInputSchema.safeParse({
        personalityId: 'engineer',
        mounts: [
          { world: 'acme', mode: 'read' },
          { world: 'watchlist', mode: 'propose', as: 'stocks' },
        ],
      }).success,
    ).toBe(true);
    expect(
      WorldsMountsSaveOutputSchema.safeParse({
        ok: true,
        effective: [
          { world: 'acme', effective: 'read' },
          { world: 'watchlist', effective: 'read', note: 'not in proposers' },
        ],
      }).success,
    ).toBe(true);
    expect(
      WorldsMountsSaveInputSchema.safeParse({
        personalityId: 'e',
        mounts: [{ world: 'acme', mode: 'write' }],
      }).success,
    ).toBe(false);
  });

  it('shareCreate example and the too_large union', () => {
    expect(
      WorldsShareCreateInputSchema.safeParse({
        world: 'world:acme',
        view: 'tree',
        asOf: '2026-11-27',
        expiresInDays: 7,
      }).success,
    ).toBe(true);
    expect(
      WorldsShareCreateOutputSchema.safeParse({
        ok: true,
        url: 'https://example.test/s/AbC',
        id: 'sh-1',
        expiresAt: '2026-12-04T00:00:00Z',
        redacted: ['email', 'location'],
      }).success,
    ).toBe(true);
    expect(
      WorldsShareCreateOutputSchema.safeParse({
        ok: false,
        reason: 'too_large',
        limitBytes: 2097152,
      }).success,
    ).toBe(true);
    expect(
      WorldsShareCreateOutputSchema.safeParse({ ok: false, reason: 'other', limitBytes: 1 })
        .success,
    ).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { displayTag, parseWorldId, resolveAccess, type WorldFile } from '../index';

const acme: WorldFile = {
  id: 'acme',
  title: 'Acme',
  audience: 'owner_only',
  backend: 'sqlite',
  readers: ['engineer'],
  proposers: ['curator'],
};
const watchlist: WorldFile = {
  id: 'watchlist',
  title: 'Watchlist',
  audience: 'shareable',
  backend: 'sqlite',
  readers: ['engineer'],
  proposers: ['engineer'],
};
const worlds = new Map([
  ['acme', acme],
  ['watchlist', watchlist],
]);

describe('world access', () => {
  it('R7 mount refused when the world does not list the personality', () => {
    const r = resolveAccess({
      personalityId: 'intruder',
      audience: 'private',
      mounts: { mounts: [{ world: 'acme', mode: 'read' }] },
      worlds,
    });
    expect(r.inert).toEqual([{ world: 'acme', reason: 'not_granted' }]);
    expect(r.visible.map((w) => w.id)).toEqual(['personality:intruder']);
  });

  it('propose mount with a reader grant resolves to read', () => {
    const r = resolveAccess({
      personalityId: 'engineer',
      audience: 'private',
      mounts: { mounts: [{ world: 'acme', mode: 'propose' }] },
      worlds,
    });
    expect(r.visible.find((w) => w.id === 'world:acme')?.mode).toBe('read');
  });

  it('propose mount with a proposer grant stays propose', () => {
    const r = resolveAccess({
      personalityId: 'curator',
      audience: 'private',
      mounts: { mounts: [{ world: 'acme', mode: 'propose' }] },
      worlds,
    });
    expect(r.visible.find((w) => w.id === 'world:acme')?.mode).toBe('propose');
  });

  it('unknown world is inert', () => {
    const r = resolveAccess({
      personalityId: 'engineer',
      audience: 'private',
      mounts: { mounts: [{ world: 'ghost', mode: 'read' }] },
      worlds,
    });
    expect(r.inert).toEqual([{ world: 'ghost', reason: 'unknown_world' }]);
  });

  it('R6 per-world audience in a shared turn', () => {
    const mounts = {
      mounts: [
        { world: 'acme', mode: 'read' as const },
        { world: 'watchlist', mode: 'propose' as const, as: 'stocks' },
      ],
    };
    const shared = resolveAccess({ personalityId: 'engineer', audience: 'shared', mounts, worlds });
    expect(shared.visible.map((w) => w.id)).toEqual(['world:watchlist']);
    expect(shared.inert).toEqual([{ world: 'acme', reason: 'audience' }]);

    const priv = resolveAccess({ personalityId: 'engineer', audience: 'private', mounts, worlds });
    expect(priv.visible.map((w) => w.id)).toEqual([
      'personality:engineer',
      'world:acme',
      'world:watchlist',
    ]);
    expect(priv.visible[0]).toMatchObject({ mode: 'write', shared: false, tag: 'private' });
    expect(priv.visible[2]).toMatchObject({ mode: 'propose', alias: 'stocks', shared: true });
  });

  it('undefined audience is treated as shared', () => {
    const r = resolveAccess({
      personalityId: 'engineer',
      audience: undefined,
      mounts: { mounts: [{ world: 'acme', mode: 'read' }] },
      worlds,
    });
    expect(r.visible).toEqual([]);
  });

  it('private world is never visible to another personality', () => {
    const r = resolveAccess({
      personalityId: 'engineer',
      audience: 'private',
      mounts: { mounts: [{ world: 'personality:other', mode: 'read' }] },
      worlds,
    });
    expect(r.visible.map((w) => w.id)).toEqual(['personality:engineer']);
    expect(r.inert).toEqual([{ world: 'personality:other', reason: 'unknown_world' }]);
  });

  it('displayTag prefixes the tag, or the alias when set', () => {
    const r = resolveAccess({
      personalityId: 'engineer',
      audience: 'private',
      mounts: { mounts: [{ world: 'watchlist', mode: 'read', as: 'stocks' }] },
      worlds,
    });
    const [priv, wl] = r.visible;
    expect(priv && displayTag(priv, 'billing-svc')).toBe('private:billing-svc');
    expect(wl && displayTag(wl, 'NVDA')).toBe('stocks:NVDA');
  });

  it('parseWorldId accepts both forms and rejects unsafe ids', () => {
    expect(parseWorldId('world:acme')).toBe('world:acme');
    expect(parseWorldId('personality:eng')).toBe('personality:eng');
    expect(() => parseWorldId('acme')).toThrow();
    expect(() => parseWorldId('world:../etc')).toThrow();
    expect(() => parseWorldId('world:')).toThrow();
  });
});

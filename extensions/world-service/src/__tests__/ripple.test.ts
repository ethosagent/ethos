import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatRipple, RIPPLE_DISCLAIMER, rippleWalk } from '../ripple';
import { caller, PRIVATE, type ServiceHarness, serviceHarness } from './service-harness';
import { SCHEMA_FOR_WATCHLIST } from './watchlist-schema';

// The FakeWorldGraphProvider serves 'edges' and 'entities' queries (live edges
// only unless includeClosed) but returns no rows for 'paths', so rippleWalk
// is exercised through edge queries against the real WorldService.

describe('ripple walk', () => {
  let h: ServiceHarness;
  const w = PRIVATE;
  let ids: Record<string, string>;
  beforeEach(async () => {
    h = await serviceHarness({ schemaText: SCHEMA_FOR_WATCHLIST });
    const p = h.provider;
    const e = (type: string, name: string) => p.seedEntity(w, type, name).id;
    ids = {
      FABR: e('Stock', 'FABR'),
      NVX: e('Stock', 'NVX'),
      SKYC: e('Stock', 'SKYC'),
      VOLT: e('Stock', 'VOLT'),
      OTHER: e('Stock', 'OTHER'),
      outage: e('Event', 'fab outage'),
      list: e('List', 'Core'),
    };
    const edge = (type: string, a: string, b: string, attrs?: Record<string, unknown>) =>
      p.seedEdge(w, type, ids[a] as string, ids[b] as string, attrs ? { attrs } : {});
    edge('affected_by', 'FABR', 'outage');
    edge('supplies', 'FABR', 'NVX', { share: 0.5 });
    edge('supplies', 'NVX', 'SKYC', { share: 0.4 });
    edge('supplies', 'NVX', 'VOLT');
    edge('supplies', 'NVX', 'OTHER');
    for (const s of ['NVX', 'SKYC', 'VOLT']) edge('watched_in', s, 'list');
  });
  afterEach(() => h.dispose());

  const walk = (extra: object = {}) =>
    rippleWalk(h.service, caller(), {
      world: 'private',
      eventId: ids.outage as string,
      listName: 'Core',
      ...extra,
    });

  it('FABR → NVX → SKYC and VOLT reached; a stock not on the list is not reported', async () => {
    const out = await walk();
    expect(out.map((r) => r.stock)).toEqual(['NVX', 'VOLT', 'SKYC']); // 2 hops: VOLT (share 0.5) before SKYC (0.2)
    expect(out.find((r) => r.stock === 'SKYC')?.path).toEqual(['FABR', 'NVX', 'SKYC']);
    expect(out.map((r) => r.stock)).not.toContain('OTHER');
  });

  it('closed supplies edges are not walked', async () => {
    const closed = h.provider
      .all(w)
      .edges.find((e) => e.type === 'supplies' && e.toId === ids.VOLT) as { id: string };
    await h.provider.close(w, closed.id, '2026-11-01');
    const out = await walk();
    expect(out.map((r) => r.stock)).toEqual(['NVX', 'SKYC']);
  });

  it('every result line carries its sources', async () => {
    const out = await walk();
    for (const r of out) expect(r.sources.length).toBeGreaterThan(0);
    const lines = formatRipple(out);
    expect(lines).toContain('FABR → NVX → SKYC');
    expect(lines).toContain('seed');
    expect(lines).toContain(RIPPLE_DISCLAIMER);
  });
});

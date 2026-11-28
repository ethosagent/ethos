import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSchemaYaml } from '../schema-model';
import { seedWatchlist } from '../seed-watchlist';
import { PRIVATE, type ServiceHarness, serviceHarness } from './service-harness';

const TEMPLATE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../templates/watchlist.schema.yaml'),
  'utf8',
);

describe('watchlist template', () => {
  let h: ServiceHarness;
  beforeEach(async () => {
    h = await serviceHarness({ schemaText: TEMPLATE });
  });
  afterEach(() => h.dispose());

  it('template parses', () => {
    const r = parseSchemaYaml(TEMPLATE);
    expect(r.ok).toBe(true);
  });

  it('seed of three tickers yields 3 stocks, 3 sectors, 3 watched_in', async () => {
    const out = await seedWatchlist(
      h.service,
      PRIVATE,
      'NVX semis, SKYC cloud, VOLT autos',
      'Core',
      'owner',
    );
    expect(out.refused).toEqual([]);
    const all = h.provider.all(PRIVATE);
    expect(all.entities.filter((e) => e.type === 'Stock')).toHaveLength(3);
    expect(all.entities.filter((e) => e.type === 'Sector')).toHaveLength(3);
    expect(all.edges.filter((e) => e.type === 'watched_in')).toHaveLength(3);
    expect(all.edges.every((e) => e.author === 'user')).toBe(true);
  });
});

// Seeds a stocks watchlist from chat-style text ("NVX semis, SKYC cloud,
// VOLT autos") through the owner write path. Read-only research: nothing here
// places orders. `parseWatchlist` is pure; `seedWatchlist` writes in two
// batches (entities, then the links that need their ids).

import type { FactInput, WorldId } from '@ethosagent/types';
import type { WorldService } from './service';

export interface WatchlistEntry {
  ticker: string;
  sector: string;
}

/** "NVX semis, SKYC cloud" -> entries. A token without a sector is skipped. */
export function parseWatchlist(text: string): WatchlistEntry[] {
  const seen = new Set<string>();
  const out: WatchlistEntry[] = [];
  for (const part of text.split(/[,;\n]/)) {
    const [ticker, ...rest] = part.trim().split(/\s+/);
    const sector = rest.join(' ');
    if (!ticker || !sector || seen.has(ticker.toUpperCase())) continue;
    seen.add(ticker.toUpperCase());
    out.push({ ticker: ticker.toUpperCase(), sector });
  }
  return out;
}

export interface SeedResult {
  stocks: number;
  sectors: number;
  watchedIn: number;
  refused: string[];
}

/**
 * Writes the List, one Stock per ticker, one Sector per distinct sector,
 * `in_sector` and `watched_in` edges, all authored `user`. Refusals are
 * returned, not thrown (pinned by watchlist-template.test.ts).
 */
export async function seedWatchlist(
  service: Pick<WorldService, 'ownerWrite'>,
  world: WorldId,
  text: string,
  listName: string,
  by: string,
): Promise<SeedResult> {
  const entries = parseWatchlist(text);
  const sectors = [...new Set(entries.map((e) => e.sector))];
  const ent = (type: string, name: string): FactInput => ({
    kind: 'entity',
    type,
    name,
    sourceRef: 'watchlist-seed',
    author: 'user',
  });
  const first = await service.ownerWrite(
    world,
    [
      ent('List', listName),
      ...sectors.map((s) => ent('Sector', s)),
      ...entries.map((e) => ent('Stock', e.ticker)),
    ],
    by,
  );
  const refused = first.refused.map((r) => r.reason);
  if (first.refused.length > 0) return { stocks: 0, sectors: 0, watchedIn: 0, refused };
  const [listId, ...rest] = first.applied;
  const sectorId = new Map(sectors.map((s, i) => [s, rest[i]]));
  const stockIds = rest.slice(sectors.length);
  const edge = (type: string, fromId: string, toId: string): FactInput => ({
    kind: 'edge',
    type,
    fromId,
    toId,
    sourceRef: 'watchlist-seed',
    author: 'user',
    confidence: 1,
  });
  const links: FactInput[] = [];
  entries.forEach((e, i) => {
    const stock = stockIds[i];
    const sector = sectorId.get(e.sector);
    if (!stock || !sector || !listId) return;
    links.push(edge('in_sector', stock, sector), edge('watched_in', stock, listId));
  });
  const second = await service.ownerWrite(world, links, by);
  refused.push(...second.refused.map((r) => r.reason));
  return {
    stocks: entries.length,
    sectors: sectors.length,
    watchedIn: entries.length - second.refused.length,
    refused,
  };
}

// Share-links store for the web API (plan share-links §3, §8): opened by `ethos serve` and
// `ethos boot` beside the api-key store, handed to `createWebApi({ shareLinks })`, closed
// in the same cleanup step as sessions.db. `bind` starts as the REQUESTED address; the
// caller overwrites it with the bound one (listenWithFallback may move the port, and a
// boot rebind may change both) so share URLs name where the server really listens.
// Reached through wiring (ARCHITECTURE.md Law 5, archcheck l5-apps-through-wiring).

import { SqliteShareLinkStore, shareLinksDbPath } from '@ethosagent/wiring';

export interface ServeShareLinks {
  host: { store: SqliteShareLinkStore; bind: { host: string; port: number } };
  close(): void;
}

export function openShareLinks(dir: string, webHost: string, webPort: number): ServeShareLinks {
  const store = new SqliteShareLinkStore(shareLinksDbPath(dir));
  return { host: { store, bind: { host: webHost, port: webPort } }, close: () => store.close() };
}

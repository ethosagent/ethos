import { ConsoleLogger } from '@ethosagent/logger';
import type { Logger, SessionStore } from '@ethosagent/types';
import type { RouteModule } from '../../routes/route-module';
import { shareRouteModule } from '../../routes/share';
import { createWebActor } from './actor';
import { startSharePurge } from './purge';
import { type ShareLinksHost, ShareService } from './service';
import { createShareSettings } from './settings';

// Assembles the share-link feature for `assembleWebApi` (split out of index.ts): the
// operator service, the public route module and the hourly purge, all reading one live
// settings reader. With no `host` (onboarding: no config yet) the service answers
// `disabled` and the public route is not mounted.

export function buildShareFeature(deps: {
  host: ShareLinksHost | undefined;
  configSource: { readSource(): Promise<string | null> };
  admin: { username(): Promise<string | null> };
  sessions: SessionStore;
  webBaseUrl: string | undefined;
  trustProxy: boolean | undefined;
  /** Purge failures go here; default a console logger tagged `share-purge`. */
  logger?: Logger;
}): {
  service: ShareService;
  actor: ReturnType<typeof createWebActor>;
  store: ShareLinksHost['store'] | undefined;
  routeModules: RouteModule[];
  stop: () => void;
} {
  const settings = createShareSettings(deps.configSource);
  const actor = createWebActor(deps.admin);
  const service = new ShareService({
    host: deps.host ?? null,
    sessions: deps.sessions,
    settings,
    actor,
    ...(deps.webBaseUrl ? { webBaseUrl: deps.webBaseUrl } : {}),
  });
  const store = deps.host?.store;
  const logger = deps.logger ?? new ConsoleLogger({ component: 'share-purge' });
  return {
    service,
    actor,
    store,
    routeModules: store
      ? [shareRouteModule({ store, settings, ...(deps.trustProxy ? { trustProxy: true } : {}) })]
      : [],
    stop: store
      ? startSharePurge({
          store,
          sessions: deps.sessions,
          onError: (err) =>
            logger.error(
              `share link purge failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
        })
      : () => {},
  };
}

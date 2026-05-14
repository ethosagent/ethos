import { Hono } from 'hono';
import { type ApiKeyAuthStore, bearerAuth } from '../../middleware/bearer-auth';
import type { CompletionsService } from '../../services/completions.service';
import type { PersonalitiesService } from '../../services/personalities.service';
import { openAiChatRoutes } from './chat';
import { openAiModelsRoutes } from './models';

// `/v1/*` mount — bearer-token auth gate over the OpenAI-compat surface.
// F1 ships auth + `/v1/models`; F3+F4 add `/v1/chat/completions` (non-
// streaming + streaming). C1 and W1 layer client-tools and team routing on
// top.

export interface OpenAiRoutesOptions {
  apiKeys: ApiKeyAuthStore;
  personalities: PersonalitiesService;
  /** Completions service for `/chat/completions`. Optional so route-level
   *  unit tests that only exercise `/models` don't need to wire it. */
  completions?: CompletionsService;
  /** Returns currently registered team names (no prefix). */
  listTeams?: () => Promise<string[]>;
}

export function openAiRoutes(opts: OpenAiRoutesOptions): Hono {
  const app = new Hono();

  app.use('*', bearerAuth({ store: opts.apiKeys, scope: 'chat' }));

  app.route(
    '/models',
    openAiModelsRoutes({
      personalities: opts.personalities,
      ...(opts.listTeams ? { listTeams: opts.listTeams } : {}),
    }),
  );

  if (opts.completions) {
    app.route(
      '/chat',
      openAiChatRoutes({
        completions: opts.completions,
        personalities: opts.personalities,
      }),
    );
  }

  return app;
}

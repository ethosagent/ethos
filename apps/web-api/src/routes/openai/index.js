import { Hono } from 'hono';
import { bearerAuth } from '../../middleware/bearer-auth';
import { idempotencyMiddleware } from '../../middleware/idempotency';
import { openAiCors } from '../../middleware/openai-cors';
import { openAiChatRoutes } from './chat';
import { openAiModelsRoutes } from './models';
export function openAiRoutes(opts) {
    const app = new Hono();
    app.use('*', openAiCors({ origins: opts.corsOrigins }));
    app.use('*', bearerAuth({ store: opts.apiKeys, scope: 'chat' }));
    if (opts.idempotencyStore) {
        app.use('/chat/*', idempotencyMiddleware({ store: opts.idempotencyStore }));
    }
    app.route('/models', openAiModelsRoutes({
        personalities: opts.personalities,
        ...(opts.listTeams ? { listTeams: opts.listTeams } : {}),
    }));
    if (opts.completions) {
        app.route('/chat', openAiChatRoutes({
            completions: opts.completions,
            personalities: opts.personalities,
        }));
    }
    return app;
}

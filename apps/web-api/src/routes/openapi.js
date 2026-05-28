import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { OpenAPIReferencePlugin } from '@orpc/openapi/plugins';
import { Hono } from 'hono';
import { apiRouter } from '../rpc/router';
export function openapiRoutes(opts) {
    const handler = new OpenAPIHandler(apiRouter, {
        plugins: [
            new OpenAPIReferencePlugin({
                docsPath: '/',
                specPath: '/spec.json',
                docsProvider: 'scalar',
                docsTitle: opts.docsTitle ?? 'Ethos Web API',
                // Generator metadata — surfaces in the docs UI header + spec.json.
                // Lives under `specGenerateOptions` because it's passed through to
                // the OpenAPIGenerator's `generate(...)` call (extends OpenAPI.Document).
                specGenerateOptions: {
                    info: {
                        title: opts.docsTitle ?? 'Ethos Web API',
                        version: '0.1.0',
                        description: 'Auto-generated from the Zod-based oRPC contract in `@ethosagent/web-contracts`. ' +
                            'Every procedure validates input through the same Zod schema the typed client uses.',
                    },
                },
            }),
        ],
    });
    const app = new Hono();
    app.all('/*', async (c) => {
        const { matched, response } = await handler.handle(c.req.raw, {
            prefix: '/openapi',
            context: opts.services,
        });
        if (matched && response)
            return response;
        return c.text('Not Found', 404);
    });
    return app;
}

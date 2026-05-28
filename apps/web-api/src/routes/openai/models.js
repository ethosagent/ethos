import { Hono } from 'hono';
export function openAiModelsRoutes(opts) {
    const app = new Hono();
    app.get('/', async (c) => {
        const personalities = opts.personalities.list().items;
        const teams = opts.listTeams ? await opts.listTeams() : [];
        const data = [
            ...personalities.map((p) => modelEntry(p.id)),
            ...teams.map((name) => modelEntry(`team:${name}`)),
            modelEntry('ethos-default'),
        ];
        const body = { object: 'list', data };
        return c.json(body);
    });
    return app;
}
function modelEntry(id) {
    return { id, object: 'model', created: 0, owned_by: 'ethos' };
}

// Bolt wiring for the App Home tab. Mirrors `events/messages.ts`:
// `registerHomeEvents(app, deps)` registers the `app_home_opened` event and the
// `home:refresh` action, both of which gather data from the injected readers
// and publish a freshly-built view via `client.views.publish`.
//
// The data-gathering is the only impure part; `buildHomeView` stays pure.
// Reader failures and `views.publish` failures are swallowed — Slack is the
// thing we don't control, and a bad event must never crash Bolt's event loop.
import { extractRecentEntries } from '../commands/memory';
import { buildHomeView, HOME_REFRESH_ACTION_ID } from './view';
/** Number of MEMORY.md entries surfaced in the home tab. */
const MEMORY_SNIPPET_COUNT = 5;
export function registerHomeEvents(app, deps) {
    const publishHome = async (client, userId) => {
        const [sessions, kanbanTickets, memorySnippets, pendingClarifies] = await Promise.all([
            gatherSessions(deps),
            gatherKanban(deps),
            gatherMemory(deps),
            gatherPendingClarifies(deps, userId),
        ]);
        // `buildHomeView` is pure first-party code — a bug here should surface via
        // Bolt's error handling, not be swallowed below into a blank Home tab.
        const view = buildHomeView({
            bot: { displayName: deps.displayName, binding: deps.binding },
            sessions,
            kanbanTickets,
            memorySnippets,
            channelModes: deps.channelOverrides?.entries() ?? [],
            pendingClarifies,
            webUiBaseUrl: deps.webUiBaseUrl,
        });
        try {
            await client.views.publish({ user_id: userId, view });
        }
        catch {
            // Slack is the one thing we don't control — a `views.publish` failure or
            // Bolt API drift must not throw inside the event loop.
        }
    };
    app.event('app_home_opened', async ({ event, client }) => {
        const evt = event;
        // `app_home_opened` also fires for the Messages tab — only the Home tab
        // has a view to publish. A missing `tab` falls through and publishes: the
        // real Slack event always carries `tab`, so absence means a malformed
        // payload, and a Home publish is the safe default.
        if (evt.tab && evt.tab !== 'home')
            return;
        if (!evt.user)
            return;
        await publishHome(client, evt.user);
    });
    app.action(HOME_REFRESH_ACTION_ID, async ({ ack, body, client }) => {
        await ack();
        const userId = body.user?.id;
        if (!userId)
            return;
        await publishHome(client, userId);
    });
}
/** Gather recent sessions, tolerating a missing or throwing reader. */
async function gatherSessions(deps) {
    if (!deps.session)
        return [];
    try {
        return await deps.session.recentSessions();
    }
    catch {
        return [];
    }
}
/** Gather kanban tickets — only for team bots, tolerating reader failure. */
async function gatherKanban(deps) {
    if (deps.binding.type !== 'team' || !deps.kanban)
        return [];
    try {
        return await deps.kanban.listOpenTickets();
    }
    catch {
        return [];
    }
}
/** Gather the last N MEMORY.md entries, tolerating reader failure. */
async function gatherMemory(deps) {
    if (!deps.memory)
        return [];
    try {
        const body = await deps.memory.read();
        return extractRecentEntries(body, MEMORY_SNIPPET_COUNT);
    }
    catch {
        return [];
    }
}
/** Gather pending clarifies the given user can answer — anyone-clarify or
 *  this user is the originator. Tolerant of reader failure (returns []). */
async function gatherPendingClarifies(deps, userId) {
    if (!deps.clarify)
        return [];
    try {
        const all = await deps.clarify.listPendingForBot();
        return all.filter((r) => r.answerableBy === 'anyone' || r.surfaceContext.originatorUserId === userId);
    }
    catch {
        return [];
    }
}

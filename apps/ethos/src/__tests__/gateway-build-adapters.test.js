import { describe, expect, it } from 'vitest';
import { buildAdapters } from '../commands/gateway';
function makeStubAdapter(name, cfg) {
    const botKey = cfg.botKey;
    return {
        id: botKey ? `${name}:${botKey}` : name,
        displayName: name,
        canSendTyping: false,
        canEditMessage: false,
        canReact: false,
        canSendFiles: false,
        maxMessageLength: 4096,
        capturedConfig: cfg,
        async start() { },
        async stop() { },
        async send() {
            return { ok: true };
        },
        onMessage(_h) { },
        async health() {
            return { ok: true };
        },
    };
}
/**
 * Stub loader: returns the matching adapter module for every requested
 * platform, with a constructor that records the config it was called
 * with (so the test can assert the per-bot botKey threading).
 */
function makeLoader() {
    const STUB_MODULES = {
        '@ethosagent/platform-telegram': {
            TelegramAdapter: class {
                constructor(cfg) {
                    Object.assign(this, makeStubAdapter('telegram', cfg));
                }
            },
        },
        '@ethosagent/platform-slack': {
            SlackAdapter: class {
                constructor(cfg) {
                    Object.assign(this, makeStubAdapter('slack', cfg));
                }
            },
        },
        '@ethosagent/platform-discord': {
            DiscordAdapter: class {
                constructor(cfg) {
                    Object.assign(this, makeStubAdapter('discord', cfg));
                }
            },
        },
        '@ethosagent/platform-email': {
            EmailAdapter: class {
                constructor(cfg) {
                    Object.assign(this, makeStubAdapter('email', cfg));
                }
            },
        },
    };
    // The loader is generic over the module shape it returns; the stub
    // narrows from `unknown` at call sites via the consumer's casts. The
    // shape returned matches what `buildAdapters` reads from each module.
    return async (modulePath) => {
        return (STUB_MODULES[modulePath] ?? null);
    };
}
const baseConfig = {
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    apiKey: 'sk',
    personality: 'researcher',
};
describe('buildAdapters — multi-bot adapter loop (Phase 2)', () => {
    it('creates one telegram adapter per telegram.bots entry, threading the right botKey', async () => {
        const adapters = await buildAdapters({
            ...baseConfig,
            telegram: {
                bots: [
                    {
                        id: 'researcher-bot',
                        token: '1:t1',
                        bind: { type: 'personality', name: 'researcher' },
                    },
                    {
                        id: 'coder-bot',
                        token: '2:t2',
                        bind: { type: 'personality', name: 'coder' },
                    },
                ],
            },
        }, makeLoader());
        expect(adapters).toHaveLength(2);
        const captured = adapters.map((a) => a.capturedConfig);
        expect(captured[0]).toMatchObject({ token: '1:t1', botKey: 'researcher-bot' });
        expect(captured[1]).toMatchObject({ token: '2:t2', botKey: 'coder-bot' });
        expect(adapters[0].id).toBe('telegram:researcher-bot');
        expect(adapters[1].id).toBe('telegram:coder-bot');
    });
    it('creates one slack adapter per slack.apps entry, threading the right botKey', async () => {
        const adapters = await buildAdapters({
            ...baseConfig,
            slack: {
                apps: [
                    {
                        id: 'prod-slack',
                        botToken: 'xoxb-1',
                        appToken: 'xapp-1',
                        signingSecret: 's1',
                        bind: { type: 'personality', name: 'researcher' },
                    },
                ],
            },
        }, makeLoader());
        expect(adapters).toHaveLength(1);
        expect(adapters[0].capturedConfig).toMatchObject({
            botToken: 'xoxb-1',
            appToken: 'xapp-1',
            signingSecret: 's1',
            botKey: 'prod-slack',
        });
        expect(adapters[0].id).toBe('slack:prod-slack');
    });
    it('boots cleanly with two telegram bots + one slack app (Phase 2 acceptance scenario)', async () => {
        const adapters = await buildAdapters({
            ...baseConfig,
            telegram: {
                bots: [
                    { id: 'tg-a', token: '1:a', bind: { type: 'personality', name: 'researcher' } },
                    { id: 'tg-b', token: '2:b', bind: { type: 'team', name: 'eng' } },
                ],
            },
            slack: {
                apps: [
                    {
                        id: 'sl-c',
                        botToken: 'xoxb',
                        appToken: 'xapp',
                        signingSecret: 's',
                        bind: { type: 'personality', name: 'coder' },
                    },
                ],
            },
        }, makeLoader());
        expect(adapters).toHaveLength(3);
        const ids = adapters.map((a) => a.id).sort();
        expect(ids).toEqual(['slack:sl-c', 'telegram:tg-a', 'telegram:tg-b']);
    });
    it('falls back to a derived hash when telegram.bots[i].id is omitted', async () => {
        const adapters = await buildAdapters({
            ...baseConfig,
            telegram: {
                bots: [
                    {
                        token: '123:ABC',
                        bind: { type: 'personality', name: 'researcher' },
                        // no explicit id — deriveBotKey produces sha256(token).slice(0, 24)
                    },
                ],
            },
        }, makeLoader());
        const captured = adapters[0].capturedConfig;
        expect(captured.botKey).toMatch(/^[0-9a-f]{24}$/);
        expect(captured.botKey).not.toBe('123:ABC'); // not the raw token
    });
    it('returns an empty list when no platform is configured', async () => {
        const adapters = await buildAdapters(baseConfig, makeLoader());
        expect(adapters).toEqual([]);
    });
    it('handles a legacy single-bot Telegram config (telegramToken scalar) via the shim', async () => {
        // Operators upgrading from pre-multi-bot ethos have `telegramToken`
        // set without an explicit `telegram.bots[]` list. The boot path
        // already normalizes via `loadConfigStrict`, but `buildAdapters`
        // applies the shim defensively so calling it directly with a
        // legacy config still produces an adapter.
        const adapters = await buildAdapters({ ...baseConfig, telegramToken: '123:legacy-token' }, makeLoader());
        expect(adapters).toHaveLength(1);
        expect(adapters[0].id.startsWith('telegram:')).toBe(true);
        const cfg = adapters[0].capturedConfig;
        expect(cfg.token).toBe('123:legacy-token');
        // Derived botKey from sha256(token) — 24 hex chars.
        expect(cfg.botKey).toMatch(/^[0-9a-f]{24}$/);
    });
    it('handles a legacy single-app Slack config (botToken/appToken/signingSecret scalars) via the shim', async () => {
        const adapters = await buildAdapters({
            ...baseConfig,
            slackBotToken: 'xoxb-legacy',
            slackAppToken: 'xapp-legacy',
            slackSigningSecret: 'sig-legacy',
        }, makeLoader());
        expect(adapters).toHaveLength(1);
        expect(adapters[0].id.startsWith('slack:')).toBe(true);
        const cfg = adapters[0].capturedConfig;
        expect(cfg.botToken).toBe('xoxb-legacy');
        expect(cfg.appToken).toBe('xapp-legacy');
        expect(cfg.signingSecret).toBe('sig-legacy');
        expect(cfg.botKey).toMatch(/^[0-9a-f]{24}$/);
    });
    it('still constructs legacy discord + email adapters alongside multi-bot telegram', async () => {
        const adapters = await buildAdapters({
            ...baseConfig,
            telegram: {
                bots: [{ id: 'tg-a', token: '1:a', bind: { type: 'personality', name: 'researcher' } }],
            },
            discordToken: 'discord-tok',
            emailImapHost: 'imap.example.com',
            emailUser: 'me@example.com',
            emailPassword: 'pw',
            emailSmtpHost: 'smtp.example.com',
        }, makeLoader());
        const platformIds = adapters.map((a) => a.id).sort();
        expect(platformIds).toEqual(['discord', 'email', 'telegram:tg-a']);
    });
    it('skips a platform whose adapter module fails to load (graceful degradation)', async () => {
        const failingLoader = async (modulePath) => {
            if (modulePath === '@ethosagent/platform-telegram')
                return null; // SDK missing
            return null;
        };
        const adapters = await buildAdapters({
            ...baseConfig,
            telegram: {
                bots: [{ id: 'tg-a', token: '1:a', bind: { type: 'personality', name: 'researcher' } }],
            },
        }, failingLoader);
        expect(adapters).toEqual([]);
    });
});

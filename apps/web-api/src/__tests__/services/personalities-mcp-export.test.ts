import { SkillsLibrary } from '@ethosagent/skills';
import { FsStorage } from '@ethosagent/storage-fs';
import type { ObsEvent, PersonalityConfig, Session, SessionStore } from '@ethosagent/types';
import { McpExportViewSchema } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import type { ApiKeyRecord } from '../../middleware/bearer-auth';
import { PersonalitiesService } from '../../services/personalities.service';
import { makeStubPersonalityRegistry } from '../test-helpers';

// M-T9 — `personalities.mcpExport`. The RPC is bearer-reachable
// (`personalities:read`), so the two promises pinned here are the ones that
// matter: the clients are exactly the keys scoped `mcp:<id>`, and nothing that
// crosses the wire is a secret.

const DATA = '/data';
const SECRET = 'sk-ethos-aaaa1111SECRETSECRETSECRETSECRET00';
const HASH = 'f'.repeat(64);

const exported: PersonalityConfig = {
  id: 'specialist',
  name: 'Specialist',
  mcp_export: { enabled: true, expose_tools: ['read_file', 'terminal'], auth: 'bearer' },
};
const plain: PersonalityConfig = { id: 'generalist', name: 'Generalist' };

function key(over: Partial<ApiKeyRecord> & Pick<ApiKeyRecord, 'id' | 'prefix' | 'scopes'>) {
  return {
    name: over.id,
    allowedOrigins: ['http://localhost:3000'],
    createdAt: new Date('2026-09-01T10:00:00Z'),
    lastUsed: null,
    revokedAt: null,
    ...over,
    // What a leaky store could hand back. The service must copy fields out,
    // never spread the record.
    secret: SECRET,
    hash: HASH,
  };
}

function session(id: string, sessionKey: string, over: Partial<Session> = {}): Session {
  return {
    id,
    key: sessionKey,
    platform: 'mcp',
    model: 'm',
    provider: 'p',
    personalityId: 'specialist',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd: 0.031,
      apiCallCount: 1,
      compactionCount: 0,
    },
    createdAt: new Date('2026-09-12T09:00:00Z'),
    updatedAt: new Date('2026-09-12T09:12:00Z'),
    ...over,
  } as Session;
}

function event(
  category: string,
  ts: number,
  details: Record<string, unknown>,
  code = 'ask',
  cause?: string,
): ObsEvent {
  return {
    eventId: `e${ts}`,
    ts,
    category: category as ObsEvent['category'],
    severity: 'warn',
    code,
    ...(cause ? { cause } : {}),
    details,
  };
}

function makeService() {
  const registry = makeStubPersonalityRegistry([exported, plain], DATA);
  const library = new SkillsLibrary({ dataDir: DATA, storage: new FsStorage() });
  const listed: unknown[] = [];
  const entryCalls: Array<{ id: string; bearer: boolean }> = [];
  const keys = [
    key({ id: 'k-mine', prefix: 'sk-ethos-aaaa1111', scopes: ['mcp:specialist'], name: 'Desktop' }),
    key({ id: 'k-other-export', prefix: 'sk-ethos-bbbb2222', scopes: ['mcp:other'] }),
    key({ id: 'k-chat', prefix: 'sk-ethos-cccc3333', scopes: ['chat', 'personalities:read'] }),
    key({ id: 'k-lookalike', prefix: 'sk-ethos-dddd4444', scopes: ['mcp:specialist-two'] }),
    key({
      id: 'k-revoked',
      prefix: 'sk-ethos-eeee5555',
      scopes: ['mcp:specialist'],
      name: 'Old laptop',
      revokedAt: new Date('2026-09-10T00:00:00Z'),
    }),
  ];
  const sessions = {
    listSessions: async (filter: unknown) => {
      listed.push(filter);
      return [
        session('s1', 'mcp:specialist:key-sk-ethos-aaaa1111:c1', {
          title: 'Does the retry match?',
        }),
        session('s2', 'mcp:specialist:stdio-cursor:c2'),
      ];
    },
  } as unknown as SessionStore;
  const service = new PersonalitiesService({
    personalities: registry,
    library,
    sessions,
    apiKeys: { list: async () => keys },
    mcpExport: async (id) =>
      id === 'specialist'
        ? {
            enabled: true,
            allowed: ['read_file'],
            dropped: ['terminal'],
            memory: 'none',
            sessions: false,
            auth: 'bearer',
          }
        : {
            enabled: false,
            allowed: [],
            dropped: [],
            memory: 'none',
            sessions: false,
            auth: 'localhost',
          },
    mcpExportDesktopEntry: async (id, opts) => {
      entryCalls.push({ id, ...opts });
      return {
        name: `ethos-${id}`,
        json: JSON.stringify({
          mcpServers: { [`ethos-${id}`]: { env: { ETHOS_MCP_KEY: '<client key>' } } },
        }),
        secretPlaceholder: '<client key>',
      };
    },
    readObservabilityEvents: ({ category }) => {
      if (category === 'mcp.export.auth') {
        return [
          event(
            category,
            3_000,
            { decision: 'denied', personalityId: 'specialist', clientId: '-' },
            'http-request',
            'invalid_key',
          ),
          event(
            category,
            2_500,
            {
              decision: 'accepted',
              personalityId: 'specialist',
              clientId: 'key-sk-ethos-aaaa1111',
            },
            'initialize',
          ),
          event(
            category,
            2_400,
            { decision: 'denied', personalityId: 'other', clientId: '-' },
            'initialize',
            'wrong_scope',
          ),
        ];
      }
      if (category === 'mcp.export.call') {
        return [
          event(
            category,
            4_000,
            { decision: 'denied', personalityId: 'specialist', clientId: 'key-sk-ethos-eeee5555' },
            'ask',
            'busy',
          ),
        ];
      }
      return [];
    },
  });
  return { service, listed, entryCalls };
}

describe('PersonalitiesService.mcpExport', () => {
  it('lists only keys whose scopes include mcp:<id> exactly, and not revoked ones', async () => {
    const { service } = makeService();
    const view = await service.mcpExport('specialist');
    expect(view.clients.map((c) => c.id)).toEqual(['k-mine']);
    expect(view.clients[0]).toEqual({
      id: 'k-mine',
      name: 'Desktop',
      prefix: 'sk-ethos-aaaa1111',
      createdAt: '2026-09-01T10:00:00.000Z',
      lastUsed: null,
    });
  });

  it('serialises no secret value — prefixes only, and the wire schema accepts it', async () => {
    const { service } = makeService();
    const view = await service.mcpExport('specialist');
    const wire = JSON.stringify(McpExportViewSchema.parse(view));
    const raw = JSON.stringify(view);
    for (const out of [wire, raw]) {
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain(HASH);
      expect(out).not.toContain('"secret"');
      expect(out).not.toContain('"hash"');
    }
  });

  it('returns the resolved slice with dropped tools, the five keys, and a bearer Desktop entry', async () => {
    const { service, entryCalls } = makeService();
    const view = await service.mcpExport('specialist');
    expect(view.exported).toBe(true);
    expect(view.scope).toEqual({
      allowed: ['read_file'],
      dropped: ['terminal'],
      memory: 'none',
      sessions: false,
      auth: 'bearer',
    });
    expect(view.declarationKeys).toEqual([
      'enabled',
      'expose_tools',
      'expose_memory',
      'expose_sessions',
      'auth',
    ]);
    expect(view.command).toBe('ethos mcp serve --personality specialist');
    expect(view.configPath.endsWith('/personalities/specialist/config.yaml')).toBe(true);
    expect(entryCalls).toEqual([{ id: 'specialist', bearer: true }]);
    expect(view.desktopEntry?.secretPlaceholder).toBe('<client key>');
  });

  it('reads the last 20 platform=mcp sessions under mcp:<id>: and names known clients', async () => {
    const { service, listed } = makeService();
    const view = await service.mcpExport('specialist');
    expect(listed).toEqual([{ platform: 'mcp', keyPrefix: 'mcp:specialist:', limit: 20 }]);
    expect(view.calls).toEqual([
      {
        sessionId: 's1',
        updatedAt: '2026-09-12T09:12:00.000Z',
        clientId: 'key-sk-ethos-aaaa1111',
        clientName: 'Desktop',
        title: 'Does the retry match?',
        costUsd: 0.031,
      },
      {
        sessionId: 's2',
        updatedAt: '2026-09-12T09:12:00.000Z',
        clientId: 'stdio-cursor',
        clientName: null,
        title: null,
        costUsd: 0.031,
      },
    ]);
  });

  it('reports denials for this personality only, newest first, with reason codes', async () => {
    const { service } = makeService();
    const view = await service.mcpExport('specialist');
    expect(view.denials).toEqual([
      {
        ts: new Date(4_000).toISOString(),
        kind: 'call',
        event: 'ask',
        clientId: 'key-sk-ethos-eeee5555',
        clientName: 'Old laptop',
        reason: 'busy',
      },
      {
        ts: new Date(3_000).toISOString(),
        kind: 'auth',
        event: 'http-request',
        clientId: '-',
        clientName: null,
        reason: 'invalid_key',
      },
    ]);
  });

  it('a personality that does not export has no slice and no Desktop entry', async () => {
    const { service, entryCalls } = makeService();
    const view = await service.mcpExport('generalist');
    expect(view.exported).toBe(false);
    expect(view.scope).toBeNull();
    expect(view.desktopEntry).toBeNull();
    expect(entryCalls).toEqual([]);
  });

  it('degrades to empty tables when every seam is absent', async () => {
    const registry = makeStubPersonalityRegistry([exported], DATA);
    const library = new SkillsLibrary({ dataDir: DATA, storage: new FsStorage() });
    const view = await new PersonalitiesService({ personalities: registry, library }).mcpExport(
      'specialist',
    );
    // No resolver seam: `exported` is still the literal-true check; the slice is unresolved.
    expect(view.exported).toBe(true);
    expect(view.scope).toBeNull();
    expect(view.clients).toEqual([]);
    expect(view.calls).toEqual([]);
    expect(view.denials).toEqual([]);
  });

  it('throws NOT_FOUND for an unknown personality', async () => {
    const { service } = makeService();
    await expect(service.mcpExport('nobody')).rejects.toMatchObject({
      code: 'PERSONALITY_NOT_FOUND',
    });
  });
});

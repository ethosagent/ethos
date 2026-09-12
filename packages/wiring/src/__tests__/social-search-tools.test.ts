import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DefaultToolRegistry } from '@ethosagent/core';
import {
  createLinkedInSearchTool,
  createQuoraSearchTool,
  createRedditWebSearchTool,
  createYouTubeCommentsTool,
  createYouTubeSearchTool,
} from '@ethosagent/tools-social-search';
import type { ToolContext, ToolResult } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// M1 of plan/phases/social-search-tools.md: youtube_search and
// youtube_comments are registered in compose-tools.ts's Group A, beside
// createEngineAskTool, resolving the personality's `tools.yaml` `youtube`
// binding. M3 adds quora_search and linkedin_search beside them, resolving
// the personality's EXISTING `tools.yaml` `web_search` binding (plan D3a —
// no tools.yaml key of their own). `buildAgentLoop`/`composeTools` is a full
// composition root (impractical to construct in a unit test — see
// call-capture-tools.test.ts's own note on this), so — mirroring that file's
// approach — this reads the compose-tools.ts source for the wiring shape,
// and exercises the four factories directly for their own contract.
// ---------------------------------------------------------------------------

describe('compose-tools.ts wires youtube_search / youtube_comments', () => {
  it('imports both factories from @ethosagent/tools-social-search', async () => {
    const root = join(import.meta.dirname, '..', '..', '..', '..');
    const src = await readFile(join(root, 'packages/wiring/src/compose-tools.ts'), 'utf8');
    expect(src).toMatch(
      /createYouTubeCommentsTool,\s*\n\s*createYouTubeSearchTool,\s*\n\}\s*from\s*'@ethosagent\/tools-social-search'/,
    );
  });

  it('registers both tools, resolving the personality youtube tools.yaml binding', async () => {
    const root = join(import.meta.dirname, '..', '..', '..', '..');
    const src = await readFile(join(root, 'packages/wiring/src/compose-tools.ts'), 'utf8');
    expect(src).toMatch(/personalities\.getToolsConfig\(personalityId\)\?\.youtube/);
    expect(src).toMatch(/tools\.register\(createYouTubeSearchTool\(youtubeToolOptions\)\)/);
    expect(src).toMatch(/tools\.register\(createYouTubeCommentsTool\(youtubeToolOptions\)\)/);
  });
});

describe('compose-tools.ts wires quora_search / linkedin_search (M3)', () => {
  it('imports both factories from @ethosagent/tools-social-search', async () => {
    const root = join(import.meta.dirname, '..', '..', '..', '..');
    const src = await readFile(join(root, 'packages/wiring/src/compose-tools.ts'), 'utf8');
    expect(src).toMatch(/createLinkedInSearchTool/);
    expect(src).toMatch(/createQuoraSearchTool/);
  });

  it("registers both tools, resolving the personality's EXISTING web_search tools.yaml binding (D3a)", async () => {
    const root = join(import.meta.dirname, '..', '..', '..', '..');
    const src = await readFile(join(root, 'packages/wiring/src/compose-tools.ts'), 'utf8');
    // D3a: no `.quora_search` / `.linkedin_search` tools.yaml key — the same
    // `?.web_search` accessor web_search itself resolves.
    expect(src).toMatch(/personalities\.getToolsConfig\(personalityId\)\?\.web_search/);
    expect(src).toMatch(/tools\.register\(createQuoraSearchTool\(siteSearchToolOptions\)\)/);
    expect(src).toMatch(/tools\.register\(createLinkedInSearchTool\(siteSearchToolOptions\)\)/);
  });
});

describe('youtube_search / youtube_comments — shape', () => {
  it('both declare toolset web, untrusted output, a 15,000-char budget, and the google secret prefix grant', () => {
    for (const tool of [createYouTubeSearchTool(), createYouTubeCommentsTool()]) {
      expect(tool.toolset).toBe('web');
      expect(tool.outputIsUntrusted).toBe(true);
      expect(tool.maxResultChars).toBe(15_000);
      expect(tool.capabilities.network?.allowedHosts).toEqual(['www.googleapis.com']);
      expect(tool.capabilities.secrets).toEqual(['providers/google/*']);
      expect(tool.settingsSchema?.fields).toEqual([
        expect.objectContaining({
          kind: 'secret-binding',
          key: 'secret',
          label: 'Google API key (YouTube)',
          secretKind: 'youtube-api-key',
          providerLabel: 'Google (YouTube Data API)',
          getKeyUrl: 'https://console.cloud.google.com/apis/credentials',
        }),
      ]);
      expect(tool.isAvailable?.()).toBe(true);
    }
  });

  it('names youtube_search and youtube_comments', () => {
    expect(createYouTubeSearchTool().name).toBe('youtube_search');
    expect(createYouTubeCommentsTool().name).toBe('youtube_comments');
  });
});

describe('quora_search / linkedin_search — shape (M3)', () => {
  it('both declare toolset web, untrusted output, a 15,000-char budget, and the web_search-shaped host/secret grants', () => {
    for (const tool of [createQuoraSearchTool(), createLinkedInSearchTool()]) {
      expect(tool.toolset).toBe('web');
      expect(tool.outputIsUntrusted).toBe(true);
      expect(tool.maxResultChars).toBe(15_000);
      expect(tool.capabilities.network?.allowedHosts).toEqual([
        'api.exa.ai',
        'api.tavily.com',
        'api.search.brave.com',
      ]);
      expect(tool.capabilities.secrets).toEqual([
        'providers/exa/*',
        'providers/tavily/*',
        'providers/brave/*',
      ]);
      expect(tool.isAvailable?.()).toBe(true);
    }
  });

  it('names quora_search and linkedin_search', () => {
    expect(createQuoraSearchTool().name).toBe('quora_search');
    expect(createLinkedInSearchTool().name).toBe('linkedin_search');
  });

  it('declares exactly one read-only info field and NO secret-binding (D3a)', () => {
    // The D3a guard. A `secret-binding` field here would let an operator point
    // quora_search at a different key from web_search — and the picker would
    // look functional while the tool ignored it, because `resolveSetting` reads
    // web_search's binding and never its own. The `info` field is the
    // disclosure that replaces it; `text` is asserted below, not here.
    for (const tool of [createQuoraSearchTool(), createLinkedInSearchTool()]) {
      const fields = tool.settingsSchema?.fields ?? [];
      expect(fields.map((f) => f.kind)).toEqual(['info']);
      expect(fields.some((f) => f.kind === 'secret-binding')).toBe(false);
    }
  });

  it('the info field names web_search, the env fallbacks, and the tool itself', () => {
    for (const [tool, name] of [
      [createQuoraSearchTool(), 'quora_search'],
      [createLinkedInSearchTool(), 'linkedin_search'],
    ] as const) {
      const field = tool.settingsSchema?.fields[0];
      if (field?.kind !== 'info') throw new Error('expected an info field');
      expect(field.label).toBe('Web search credential');
      expect(field.text).toContain('web_search');
      expect(field.text).toContain(name);
      for (const env of ['EXA_API_KEY', 'TAVILY_API_KEY', 'BRAVE_API_KEY']) {
        expect(field.text).toContain(env);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// reddit_web_search — the credential-free rung under reddit_search, same
// site-constrained shape and the same D3a binding as the two above. It
// reaches the SEARCH BACKEND's API, never reddit.com itself, so its
// host/secret grants are identical to quora_search's and linkedin_search's.
// ---------------------------------------------------------------------------

describe('compose-tools.ts wires reddit_web_search', () => {
  it('imports the factory and registers it with the shared site-search options (D3a)', async () => {
    const root = join(import.meta.dirname, '..', '..', '..', '..');
    const src = await readFile(join(root, 'packages/wiring/src/compose-tools.ts'), 'utf8');
    expect(src).toMatch(/createRedditWebSearchTool/);
    expect(src).toMatch(/tools\.register\(createRedditWebSearchTool\(siteSearchToolOptions\)\)/);
  });
});

describe('reddit_web_search — shape', () => {
  it('matches the other two site tools: toolset web, untrusted output, a 15,000-char budget, the same host/secret grants, and the same disclosure-only settingsSchema', () => {
    const tool = createRedditWebSearchTool();
    expect(tool.name).toBe('reddit_web_search');
    expect(tool.toolset).toBe('web');
    expect(tool.outputIsUntrusted).toBe(true);
    expect(tool.maxResultChars).toBe(15_000);
    expect(tool.capabilities.network?.allowedHosts).toEqual(
      createQuoraSearchTool().capabilities.network?.allowedHosts,
    );
    expect(tool.capabilities.secrets).toEqual(createLinkedInSearchTool().capabilities.secrets);
    expect(tool.isAvailable?.()).toBe(true);
  });

  it('declares exactly one read-only info field and NO secret-binding (D3a)', () => {
    const fields = createRedditWebSearchTool().settingsSchema?.fields ?? [];
    expect(fields.map((f) => f.kind)).toEqual(['info']);
    expect(fields.some((f) => f.kind === 'secret-binding')).toBe(false);
    const field = fields[0];
    if (field?.kind !== 'info') throw new Error('expected an info field');
    expect(field.label).toBe('Web search credential');
    expect(field.text).toContain('web_search');
    expect(field.text).toContain('reddit_web_search');
    for (const env of ['EXA_API_KEY', 'TAVILY_API_KEY', 'BRAVE_API_KEY']) {
      expect(field.text).toContain(env);
    }
  });

  it('never grants reddit.com itself — it reaches the search backend, not Reddit', () => {
    const hosts = createRedditWebSearchTool().capabilities.network?.allowedHosts ?? [];
    expect(hosts).toEqual(['api.exa.ai', 'api.tavily.com', 'api.search.brave.com']);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion, plan §11 M3: "a custom personality whose toolset.yaml
// lists quora_search and not web_search searches Quora from `ethos chat` and
// is refused when it tries web_search, with the 'is not permitted for this
// personality' message." The toolset gate is exact tool-name match against
// `allowedTools`, enforced in DefaultToolRegistry.executeParallel
// (packages/core/src/tool-registry.ts) independent of any specific
// personality-loading machinery, so it is exercised directly here rather
// than through a full `ethos chat` session.
// ---------------------------------------------------------------------------

const makeCtx = (): ToolContext => ({
  sessionId: 's1',
  sessionKey: 'cli:default',
  platform: 'cli',
  workingDir: '/tmp',
  currentTurn: 1,
  messageCount: 1,
  abortSignal: new AbortController().signal,
  emit: () => {},
  resultBudgetChars: 10_000,
});

describe('toolset gate: quora_search-only personality cannot reach web_search', () => {
  it('runs quora_search but refuses web_search with "is not permitted for this personality"', async () => {
    const registry = new DefaultToolRegistry();
    registry.register(createQuoraSearchTool());
    registry.register({
      name: 'web_search',
      description: 'stand-in for the real web_search tool',
      schema: { type: 'object' },
      capabilities: {},
      async execute(): Promise<ToolResult> {
        return { ok: true, value: 'should never run' };
      },
    });

    const results = await registry.executeParallel(
      [
        { toolCallId: 'c1', name: 'quora_search', args: { query: 'test' } },
        { toolCallId: 'c2', name: 'web_search', args: { query: 'test' } },
      ],
      makeCtx(),
      ['quora_search'], // toolset.yaml lists only quora_search
    );

    // quora_search ran (its own execute() reports not_available here only
    // because no search backend is configured in this bare ctx — the point
    // is that it was NOT rejected by the toolset gate).
    const quoraResult = results.find((r) => r.toolCallId === 'c1');
    expect(quoraResult?.result.ok).toBe(false);
    if (quoraResult && !quoraResult.result.ok) {
      expect(quoraResult.result.code).toBe('not_available');
      expect(quoraResult.result.error).not.toMatch(/not permitted/);
    }

    const webSearchResult = results.find((r) => r.toolCallId === 'c2');
    expect(webSearchResult?.result.ok).toBe(false);
    if (webSearchResult && !webSearchResult.result.ok) {
      expect(webSearchResult.result.code).toBe('not_available');
      expect(webSearchResult.result.error).toBe(
        'Tool web_search is not permitted for this personality',
      );
    }
  });
});

import { join } from 'node:path';
import type { DecisionsConfig } from '@ethosagent/config';
import { DefaultToolRegistry } from '@ethosagent/core';
import {
  type CharacterSheetModelFit,
  FilePersonalityRegistry,
  renderCharacterSheet,
} from '@ethosagent/personalities';
import { SkillsInjector, SkillsLibrary, UniversalScanner } from '@ethosagent/skills';
import { FsStorage, InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  CompletionChunk,
  LLMProvider,
  Message,
  PersonalityConfig,
  Tool,
} from '@ethosagent/types';
import { createLearningInbox, resolveMcpExportScope } from '@ethosagent/wiring';
import { call, ORPCError } from '@orpc/server';
import { describe, expect, it } from 'vitest';
// Relative on purpose: web-api reaches the inbox through `@ethosagent/wiring`
// and has no workspace link to the package; the test reads the real store.
import {
  listCandidates,
  submitCandidate,
  updateCandidate,
} from '../../../../../extensions/learning-inbox/src/store';
import type { RpcContext } from '../../rpc/context';
import { personalitiesRouter } from '../../rpc/personalities';
import { personalitiesLearningRouter } from '../../rpc/personalities-learning';
import { LearningService } from '../../services/learning.service';
import { PersonalitiesService } from '../../services/personalities.service';
import { makeStubPersonalityRegistry } from '../test-helpers';

function stubLLM(response: string): LLMProvider {
  return {
    name: 'mock',
    model: 'mock',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    complete(_messages: Message[], _tools: unknown[]): AsyncIterable<CompletionChunk> {
      return (async function* () {
        yield { type: 'text_delta', text: response };
        yield { type: 'done', finishReason: 'end_turn' };
      })();
    },
    async countTokens() {
      return 0;
    },
  };
}

// Service tests cover both the repository (via real SOUL.md reads from
// InMemoryStorage) and the wire-shape mapping.

const DATA = '/data';

describe('PersonalitiesService', () => {
  function makeService(opts: { personalities: import('@ethosagent/types').PersonalityConfig[] }) {
    const registry = makeStubPersonalityRegistry(opts.personalities, DATA);
    const library = new SkillsLibrary({ dataDir: DATA, storage: new FsStorage() });
    return new PersonalitiesService({ personalities: registry, library });
  }

  it('list maps PersonalityConfig → wire shape and includes defaultId', async () => {
    const service = makeService({
      personalities: [
        {
          id: 'researcher',
          name: 'Researcher',
          description: 'curious + careful',
          model: 'claude-opus-4-7',
          // soulFile lives outside the user dir → built-in
          soulFile: '/usr/share/ethos/personalities/researcher/SOUL.md',
        },
      ],
    });
    const result = await service.list();
    expect(result.defaultId).toBe('researcher');
    expect(result.items).toHaveLength(1);
    const p = result.items[0];
    if (!p) throw new Error('expected one personality');
    expect(p.id).toBe('researcher');
    expect(p.builtin).toBe(true);
    // Server-internal fields are stripped
    expect('soulFile' in p).toBe(false);
    expect('skillsDirs' in p).toBe(false);
  });

  it('marks user personalities as builtin: false based on soulFile path', async () => {
    const userSoulFile = join(DATA, 'personalities', 'custom', 'SOUL.md');
    const service = makeService({
      personalities: [
        { id: 'custom', name: 'Custom', soulFile: userSoulFile },
        // No soulFile → treated as built-in (config-only personalities are built-ins by default)
        { id: 'builtin', name: 'Built-in' },
      ],
    });
    const result = await service.list();
    const byId = Object.fromEntries(result.items.map((p) => [p.id, p]));
    expect(byId.custom?.builtin).toBe(false);
    expect(byId.builtin?.builtin).toBe(true);
  });

  it('get returns personality + reads SOUL.md body from disk', async () => {
    const storage = new InMemoryStorage();
    const soulPath = join(DATA, 'personalities', 'researcher', 'SOUL.md');
    await storage.mkdir(join(DATA, 'personalities', 'researcher'));
    await storage.write(soulPath, '# Researcher\n\nI am a careful researcher.\n');

    const registry = new FilePersonalityRegistry(storage, DATA);
    registry.define({ id: 'researcher', name: 'Researcher', soulFile: soulPath });
    registry.setDefault('researcher');
    const library = new SkillsLibrary({ dataDir: DATA, storage });
    const service = new PersonalitiesService({ personalities: registry, library });

    const result = await service.get('researcher');
    expect(result.personality.id).toBe('researcher');
    expect(result.soulMd).toContain('I am a careful researcher.');
    // soulFile under DATA/personalities/ → user-owned → builtin: false
    expect(result.personality.builtin).toBe(false);
  });

  it('get throws PERSONALITY_NOT_FOUND for unknown ids', async () => {
    const service = makeService({ personalities: [] });
    await expect(service.get('nope')).rejects.toMatchObject({ code: 'PERSONALITY_NOT_FOUND' });
  });

  it('get returns empty soulMd when file is missing', async () => {
    const service = makeService({
      personalities: [
        {
          id: 'researcher',
          name: 'Researcher',
          soulFile: join(DATA, 'personalities', 'researcher', 'SOUL.md'),
        },
      ],
    });
    const result = await service.get('researcher');
    expect(result.soulMd).toBe('');
  });

  it('characterSheet renders the Markdown artifact from config + SOUL.md', async () => {
    const storage = new InMemoryStorage();
    const soulPath = join(DATA, 'personalities', 'researcher', 'SOUL.md');
    await storage.mkdir(join(DATA, 'personalities', 'researcher'));
    await storage.write(soulPath, '# Researcher\n\nI am a careful researcher.\n');

    const registry = new FilePersonalityRegistry(storage, DATA);
    registry.define({
      id: 'researcher',
      name: 'Researcher',
      model: 'claude-opus-4-7',
      soulFile: soulPath,
    });
    registry.setDefault('researcher');
    const library = new SkillsLibrary({ dataDir: DATA, storage });
    const service = new PersonalitiesService({ personalities: registry, library });

    const { markdown } = await service.characterSheet('researcher');
    expect(markdown).toMatch(/^# researcher — Researcher$/m);
    expect(markdown).toContain('I am a careful researcher.');
    expect(markdown).toContain('claude-opus-4-7');
  });

  it('characterSheet throws PERSONALITY_NOT_FOUND for unknown ids', async () => {
    const service = makeService({ personalities: [] });
    await expect(service.characterSheet('nope')).rejects.toMatchObject({
      code: 'PERSONALITY_NOT_FOUND',
    });
  });

  it('characterSheet threads the computed model fit through the SAME generator the CLI uses (Lane 6, D5)', async () => {
    const storage = new InMemoryStorage();
    const soulPath = join(DATA, 'personalities', 'researcher', 'SOUL.md');
    await storage.mkdir(join(DATA, 'personalities', 'researcher'));
    await storage.write(soulPath, '# Researcher\n\nI am a careful researcher.\n');

    const registry = new FilePersonalityRegistry(storage, DATA);
    const config = {
      id: 'researcher',
      name: 'Researcher',
      model: 'qwen3:8b',
      soulFile: soulPath,
    };
    registry.define(config);
    registry.setDefault('researcher');
    const library = new SkillsLibrary({ dataDir: DATA, storage });

    const fit: CharacterSheetModelFit = {
      verdict: 'refuses',
      model: 'qwen3:8b',
      windowTokens: 8_192,
      windowSource: 'probe',
      floor: {
        tokens: 7_200,
        toolCount: 12,
        components: [
          { name: 'SOUL.md', tokens: 2_060 },
          { name: 'tool schemas', tokens: 4_800 },
          { name: 'injection-defense prelude', tokens: 340 },
        ],
      },
      outputReserveTokens: 4_096,
      compactibleTokens: -3_104,
      staticShare: 0.879,
      degradations: [],
      refusalReason:
        'personality `researcher` cannot run on `qwen3:8b` (8,192 tokens): static prefix 7,200 + output reserve 4,096 exceeds the window. Largest contributor: tool schemas (4,800 tokens, 12 tools).',
      exclusions: ['tier models not evaluated'],
    };
    const service = new PersonalitiesService({
      personalities: registry,
      library,
      modelFit: async () => fit,
    });

    const { markdown } = await service.characterSheet('researcher');
    // One generator, both surfaces: the RPC markdown IS renderCharacterSheet's
    // output for the same inputs — byte-identical, no second renderer.
    const soulMd = await registry.readSoulMd('researcher');
    expect(markdown).toBe(renderCharacterSheet(config, soulMd, undefined, fit));
    expect(markdown).toContain('- Verdict: refuses');
    expect(markdown).toContain('Largest contributor: tool schemas (4,800 tokens, 12 tools).');
  });

  it('characterSheet renders without the verdict when the modelFit seam is absent or fails', async () => {
    const storage = new InMemoryStorage();
    const soulPath = join(DATA, 'personalities', 'researcher', 'SOUL.md');
    await storage.mkdir(join(DATA, 'personalities', 'researcher'));
    await storage.write(soulPath, '# Researcher\n\nI am a careful researcher.\n');
    const registry = new FilePersonalityRegistry(storage, DATA);
    registry.define({ id: 'researcher', name: 'Researcher', soulFile: soulPath });
    registry.setDefault('researcher');
    const library = new SkillsLibrary({ dataDir: DATA, storage });

    const absent = new PersonalitiesService({ personalities: registry, library });
    const failing = new PersonalitiesService({
      personalities: registry,
      library,
      modelFit: async () => {
        throw new Error('probe blew up');
      },
    });
    const a = await absent.characterSheet('researcher');
    const b = await failing.characterSheet('researcher');
    expect(a.markdown).not.toContain('## Model fit');
    // Fail-soft: a throwing seam degrades to the same verdict-less sheet.
    expect(b.markdown).toBe(a.markdown);
  });

  // -------------------------------------------------------------------------
  // MCP per-server tool subsets — mcp.yaml persistence + read-back. Mirrors
  // what the personalities.update RPC handler does when `mcp_servers` and
  // `mcp_tools` are both present.
  // -------------------------------------------------------------------------
  describe('MCP tool subsets', () => {
    async function makeMcpService() {
      const storage = new InMemoryStorage();
      const registry = new FilePersonalityRegistry(storage, DATA);
      const library = new SkillsLibrary({ dataDir: DATA, storage });
      const service = new PersonalitiesService({ personalities: registry, library });
      // A real user personality, so writes land on InMemoryStorage.
      await service.create({
        id: 'agent',
        name: 'Agent',
        toolset: [],
        soulMd: '# Agent',
        mcp_servers: ['linear', 'slack'],
      });
      return { service, storage };
    }

    // Replicates the RPC handler's `mcp_servers` + `mcp_tools` → subsets map.
    function buildSubsets(
      mcpServers: string[],
      mcpTools: Record<string, string[]>,
    ): Record<string, string[] | null> {
      const subsets: Record<string, string[] | null> = {};
      for (const server of mcpServers) subsets[server] = mcpTools[server] ?? null;
      return subsets;
    }

    it('persists a strict subset and clears all-selected servers', async () => {
      const { service, storage } = await makeMcpService();

      // linear → strict subset; slack → all tools (omitted from mcp_tools).
      await service.writeMcpToolSubsets(
        'agent',
        buildSubsets(['linear', 'slack'], { linear: ['list_issues'] }),
      );

      const yaml = await storage.read(join(DATA, 'personalities', 'agent', 'mcp.yaml'));
      expect(yaml).toContain('linear:');
      expect(yaml).toContain('- list_issues');
      // slack got `null` → no tools key → not present (default-allow).
      expect(yaml).not.toContain('slack:');

      const { mcpPolicy } = await service.get('agent');
      expect(mcpPolicy?.servers?.linear?.tools).toEqual(['list_issues']);
      expect(mcpPolicy?.servers?.slack).toBeUndefined();
    });

    it('get returns mcpPolicy: null when the personality has no mcp.yaml', async () => {
      const { service } = await makeMcpService();
      const { mcpPolicy } = await service.get('agent');
      expect(mcpPolicy).toBeNull();
    });

    it('preserves reject_args across a subsequent subset edit', async () => {
      // Seed a personality dir that already has an mcp.yaml carrying
      // reject_args, then load it so the registry's policy cache is warm.
      const storage = new InMemoryStorage();
      const dir = join(DATA, 'personalities', 'agent');
      await storage.mkdir(dir);
      await storage.write(join(dir, 'config.yaml'), 'name: Agent\nmcp_servers: linear\n');
      await storage.write(join(dir, 'SOUL.md'), '# Agent');
      await storage.write(
        join(dir, 'mcp.yaml'),
        [
          'servers:',
          '  linear:',
          '    tools:',
          '      - list_issues',
          '      - save_issue',
          '    reject_args:',
          '      save_issue:',
          '        status:',
          '          - Done',
        ].join('\n'),
      );
      const registry = new FilePersonalityRegistry(storage, DATA);
      await registry.loadFromDirectory(join(DATA, 'personalities'));
      const library = new SkillsLibrary({ dataDir: DATA, storage });
      const service = new PersonalitiesService({ personalities: registry, library });

      await service.writeMcpToolSubsets(
        'agent',
        buildSubsets(['linear'], { linear: ['list_issues'] }),
      );

      const { mcpPolicy } = await service.get('agent');
      expect(mcpPolicy?.servers?.linear?.tools).toEqual(['list_issues']);
      expect(mcpPolicy?.servers?.linear?.reject_args?.save_issue?.status).toEqual(['Done']);
    });
  });

  // -------------------------------------------------------------------------
  // Governed learning — Living Soul Expression evolution (Phase 3a)
  // -------------------------------------------------------------------------
  describe('governed learning', () => {
    async function makeSoulService(opts: {
      llm?: LLMProvider;
      soulMd?: string;
    }): Promise<{ service: PersonalitiesService; storage: InMemoryStorage }> {
      const storage = new InMemoryStorage();
      const dir = join(DATA, 'personalities', 'agent');
      await storage.mkdir(dir);
      await storage.write(join(dir, 'config.yaml'), 'name: Agent\n');
      await storage.write(
        join(dir, 'SOUL.md'),
        opts.soulMd ?? '# Core\nI am the agent.\n\n# Expression\nI speak plainly.\n',
      );
      const registry = new FilePersonalityRegistry(storage, DATA);
      await registry.loadFromDirectory(join(DATA, 'personalities'));
      const library = new SkillsLibrary({ dataDir: DATA, storage });
      const service = new PersonalitiesService({
        personalities: registry,
        library,
        storage,
        dataDir: DATA,
        learning: new LearningService({
          inbox: createLearningInbox({
            storage,
            dataDir: DATA,
            personalities: registry,
            expressions: registry,
            defaultPersonalityId: 'agent',
          }),
        }),
        ...(opts.llm ? { llm: async () => opts.llm as LLMProvider } : {}),
      });
      return { service, storage };
    }

    it('proposeSoulSplit parses a canned CORE/EXPRESSION/RATIONALE split', async () => {
      const llm = stubLLM(
        'CORE:\nI am the agent.\n\nEXPRESSION:\nI speak plainly.\n\nRATIONALE: clean split.',
      );
      const { service } = await makeSoulService({ llm });
      const result = await service.proposeSoulSplit('I am the agent. I speak plainly.');
      expect(result.core).toContain('I am the agent.');
      expect(result.expression).toContain('I speak plainly.');
      expect(result.rationale).toBe('clean split.');
    });

    it('proposeSoulSplit throws NOT_CONFIGURED when no llm is configured', async () => {
      const { service } = await makeSoulService({});
      await expect(service.proposeSoulSplit('whatever')).rejects.toMatchObject({
        code: 'NOT_CONFIGURED',
      });
    });

    it('proposeExpression throws NOT_CONFIGURED when no llm is configured', async () => {
      const { service } = await makeSoulService({});
      await expect(service.proposeExpression('agent')).rejects.toMatchObject({
        code: 'NOT_CONFIGURED',
      });
    });

    it('proposeExpression submits a web-origin learning candidate and applies nothing (L-T6, path 5: web)', async () => {
      const llm = stubLLM('I speak even more plainly.\nRATIONALE: tighter');
      const { service, storage } = await makeSoulService({ llm });
      const draft = await service.proposeExpression('agent');

      const candidates = await listCandidates(storage, DATA);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        kind: 'expression',
        op: 'update',
        origin: 'web',
        personalityId: 'agent',
        status: 'pending_replay',
        destination: join(DATA, 'personalities', 'agent', 'SOUL.md'),
        content: draft.newExpression,
      });
      expect((await service.livingSoul('agent')).learningLog).toHaveLength(0);
    });

    it('applyExpression promotes the candidate proposeExpression submitted, not a second one', async () => {
      const llm = stubLLM('I speak even more plainly.\nRATIONALE: tighter');
      const { service, storage } = await makeSoulService({ llm });
      const draft = await service.proposeExpression('agent');
      await service.applyExpression(
        'agent',
        draft.newExpression,
        'tighter',
        'web:test',
        'reviewed the draft',
      );

      const candidates = await listCandidates(storage, DATA);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.status).toBe('promoted');
    });

    it('applyExpression writes a revision and returns its id', async () => {
      const { service } = await makeSoulService({});
      const result = await service.applyExpression(
        'agent',
        'I speak even more plainly.\n',
        'tighten voice',
        'sessions:test',
        'reviewed by hand',
      );
      expect(result).toEqual({ ok: true, value: { revisionId: 'expr-rev-1' } });
      const soul = await service.livingSoul('agent');
      expect(soul.expression).toContain('I speak even more plainly.');
      expect(soul.learningLog).toHaveLength(1);
    });

    // L-T8 — Apply approves a candidate that was never replayed, so like every
    // other non-pass approval it needs a human reason (enforced once, in
    // `LearningInbox.approve`). The drafter's `summary` does not count.
    it('applyExpression without an override reason is refused and changes nothing', async () => {
      const { service, storage } = await makeSoulService({});
      expect(
        await service.applyExpression(
          'agent',
          'I speak even more plainly.\n',
          'tighten voice',
          'x',
        ),
      ).toMatchObject({ ok: false, code: 'override_required' });

      const soul = await service.livingSoul('agent');
      expect(soul.expression).toContain('I speak plainly.');
      expect(soul.learningLog).toHaveLength(0);
      const [candidate] = await listCandidates(storage, DATA);
      expect(candidate?.status).toBe('pending_replay');
    });

    // F8 — the RPC keeps the inbox's refusal code, mapped by the same table as
    // `learning.approve` (`learningRpcError`, `rpc/learning.ts`), so the Living
    // Soul UI can tell a stale draft from a missing reason.
    async function applyViaRpc(
      service: PersonalitiesService,
      input: { newExpression: string; overrideReason?: string },
    ): Promise<unknown> {
      try {
        await call(
          personalitiesLearningRouter.applyExpression,
          { id: 'agent', summary: 'tighten voice', evidenceRef: 'web:test', ...input },
          { context: { personalities: service } as unknown as RpcContext },
        );
      } catch (err) {
        return err;
      }
      throw new Error('expected applyExpression to be refused');
    }

    it('the applyExpression RPC refuses a missing reason as OVERRIDE_REQUIRED', async () => {
      const { service } = await makeSoulService({});
      const err = await applyViaRpc(service, { newExpression: 'I speak even more plainly.\n' });
      expect(err).toBeInstanceOf(ORPCError);
      expect(err).toMatchObject({ code: 'OVERRIDE_REQUIRED', status: 400 });
      expect((await service.livingSoul('agent')).learningLog).toHaveLength(0);
    });

    it('the applyExpression RPC refuses a stale candidate as STALE', async () => {
      const { service, storage } = await makeSoulService({});
      const newExpression = 'I speak even more plainly.\n';
      // Submits the candidate against today's SOUL.md; refused for want of a reason.
      await applyViaRpc(service, { newExpression });
      // The live file moves on before the human approves.
      await storage.write(
        join(DATA, 'personalities', 'agent', 'SOUL.md'),
        '# Core\nI am the agent.\n\n# Expression\nI speak in riddles now.\n',
      );

      const err = await applyViaRpc(service, { newExpression, overrideReason: 'reviewed' });
      expect(err).toBeInstanceOf(ORPCError);
      expect(err).toMatchObject({ code: 'STALE', status: 409 });
      expect((err as Error).message).toMatch(/^Expression not applied: /);
      const soul = await service.livingSoul('agent');
      expect(soul.expression).toContain('I speak in riddles now.');
      expect(soul.learningLog).toHaveLength(0);
    });

    it('revertExpression on an empty learning log throws INVALID_INPUT', async () => {
      const { service } = await makeSoulService({});
      await expect(service.revertExpression('agent')).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    });

    it('revertExpression restores the prior snapshot after an apply', async () => {
      const { service } = await makeSoulService({});
      await service.applyExpression(
        'agent',
        'changed voice.\n',
        'summary',
        'sessions:test',
        'reviewed by hand',
      );
      const result = await service.revertExpression('agent');
      expect(result.ok).toBe(true);
      const soul = await service.livingSoul('agent');
      expect(soul.expression).toContain('I speak plainly.');
    });
  });

  // -------------------------------------------------------------------------
  // Living Soul judge alignment — reads `.judge-history/state.json` (Phase 3).
  // -------------------------------------------------------------------------
  describe('living soul judge alignment', () => {
    const STATE_PATH = join(DATA, 'personalities', 'agent', '.judge-history', 'state.json');

    async function makeJudgeService(stateRaw?: string): Promise<PersonalitiesService> {
      const storage = new InMemoryStorage();
      const dir = join(DATA, 'personalities', 'agent');
      await storage.mkdir(dir);
      await storage.write(join(dir, 'config.yaml'), 'name: Agent\n');
      await storage.write(join(dir, 'SOUL.md'), '# Core\nI am the agent.\n\n# Expression\nHi.\n');
      if (stateRaw !== undefined) {
        await storage.mkdir(join(dir, '.judge-history'));
        await storage.write(STATE_PATH, stateRaw);
      }
      const registry = new FilePersonalityRegistry(storage, DATA);
      await registry.loadFromDirectory(join(DATA, 'personalities'));
      const library = new SkillsLibrary({ dataDir: DATA, storage });
      return new PersonalitiesService({ personalities: registry, library, storage, dataDir: DATA });
    }

    it('includes judge with parsed values when state is present', async () => {
      const service = await makeJudgeService(
        JSON.stringify({
          lowStreak: 2,
          lastResult: {
            alignmentScore: 0.82,
            signal: 'drift',
            sampleCount: 5,
            perDimension: [{ id: 'core_expression_alignment', score: 0.82, evidence: 'ok' }],
          },
          at: '2026-06-17T00:00:00.000Z',
        }),
      );
      const soul = await service.livingSoul('agent');
      expect(soul.judge).toEqual({
        alignmentScore: 0.82,
        signal: 'drift',
        lowStreak: 2,
        at: '2026-06-17T00:00:00.000Z',
        perDimension: [{ dimension: 'core_expression_alignment', score: 0.82 }],
      });
    });

    it('omits judge when no state file exists', async () => {
      const service = await makeJudgeService();
      const soul = await service.livingSoul('agent');
      expect(soul.judge).toBeUndefined();
    });

    it('omits judge when the state JSON is malformed (no throw)', async () => {
      const service = await makeJudgeService('{not json');
      const soul = await service.livingSoul('agent');
      expect(soul.judge).toBeUndefined();
      expect(soul.expression).toContain('Hi.');
    });

    it('omits judge when storage / dataDir are not wired', async () => {
      const storage = new InMemoryStorage();
      const dir = join(DATA, 'personalities', 'agent');
      await storage.mkdir(dir);
      await storage.write(join(dir, 'config.yaml'), 'name: Agent\n');
      await storage.write(join(dir, 'SOUL.md'), '# Core\nx\n');
      const registry = new FilePersonalityRegistry(storage, DATA);
      await registry.loadFromDirectory(join(DATA, 'personalities'));
      const library = new SkillsLibrary({ dataDir: DATA, storage });
      const service = new PersonalitiesService({ personalities: registry, library });
      const soul = await service.livingSoul('agent');
      expect(soul.judge).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Living Soul nightly status — reads `.nightly-state.json` (Phase 3).
  // -------------------------------------------------------------------------
  describe('living soul nightly status', () => {
    const STATE_PATH = join(DATA, 'personalities', 'agent', '.nightly-state.json');

    async function makeNightlyService(stateRaw?: string): Promise<PersonalitiesService> {
      const storage = new InMemoryStorage();
      const dir = join(DATA, 'personalities', 'agent');
      await storage.mkdir(dir);
      await storage.write(join(dir, 'config.yaml'), 'name: Agent\n');
      await storage.write(join(dir, 'SOUL.md'), '# Core\nI am the agent.\n\n# Expression\nHi.\n');
      if (stateRaw !== undefined) {
        await storage.write(STATE_PATH, stateRaw);
      }
      const registry = new FilePersonalityRegistry(storage, DATA);
      await registry.loadFromDirectory(join(DATA, 'personalities'));
      const library = new SkillsLibrary({ dataDir: DATA, storage });
      return new PersonalitiesService({ personalities: registry, library, storage, dataDir: DATA });
    }

    it('includes nightly with parsed values when state is present', async () => {
      const service = await makeNightlyService(
        JSON.stringify({
          windowEnd: '2026-06-17T00:00:00.000Z',
          completed: ['judge', 'dream'],
        }),
      );
      const soul = await service.livingSoul('agent');
      expect(soul.nightly).toEqual({
        windowEnd: '2026-06-17T00:00:00.000Z',
        completed: ['judge', 'dream'],
      });
    });

    it('omits nightly when no state file exists', async () => {
      const service = await makeNightlyService();
      const soul = await service.livingSoul('agent');
      expect(soul.nightly).toBeUndefined();
    });

    it('omits nightly when the state JSON is malformed (no throw)', async () => {
      const service = await makeNightlyService('{not json');
      const soul = await service.livingSoul('agent');
      expect(soul.nightly).toBeUndefined();
      expect(soul.expression).toContain('Hi.');
    });

    it('omits nightly when the shape is wrong (no throw)', async () => {
      const service = await makeNightlyService(
        JSON.stringify({ windowEnd: 123, completed: ['ok'] }),
      );
      const soul = await service.livingSoul('agent');
      expect(soul.nightly).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Governed-learning settings — evolution_approval_mode + skill_evolution
  // round-trip through create/update → config.yaml → toWire.
  // -------------------------------------------------------------------------
  describe('governed-learning settings round-trip', () => {
    async function makeRealService() {
      const storage = new InMemoryStorage();
      const registry = new FilePersonalityRegistry(storage, DATA);
      const library = new SkillsLibrary({ dataDir: DATA, storage });
      const service = new PersonalitiesService({ personalities: registry, library });
      return { service, storage };
    }

    it('persists evolution_approval_mode + skill_evolution on create and reads them back', async () => {
      const { service } = await makeRealService();
      const { personality } = await service.create({
        id: 'agent',
        name: 'Agent',
        toolset: [],
        soulMd: '# Agent',
        evolution_approval_mode: 'auto',
        skill_evolution: { enabled: true, min_tool_calls: 5, cooldown_minutes: 30 },
      });
      expect(personality.evolution_approval_mode).toBe('auto');
      expect(personality.skill_evolution).toEqual({
        enabled: true,
        min_tool_calls: 5,
        cooldown_minutes: 30,
      });
      const reloaded = await service.get('agent');
      expect(reloaded.personality.evolution_approval_mode).toBe('auto');
      expect(reloaded.personality.skill_evolution).toEqual({
        enabled: true,
        min_tool_calls: 5,
        cooldown_minutes: 30,
      });
    });

    it('update mutates evolution_approval_mode + skill_evolution and toWire reflects it', async () => {
      const { service } = await makeRealService();
      await service.create({
        id: 'agent',
        name: 'Agent',
        toolset: [],
        soulMd: '# Agent',
        evolution_approval_mode: 'user',
        skill_evolution: { enabled: false, min_tool_calls: 3, cooldown_minutes: 10 },
      });
      const { personality } = await service.update('agent', {
        evolution_approval_mode: 'auto',
        skill_evolution: { enabled: true, min_tool_calls: 7, cooldown_minutes: 45 },
      });
      expect(personality.evolution_approval_mode).toBe('auto');
      expect(personality.skill_evolution).toEqual({
        enabled: true,
        min_tool_calls: 7,
        cooldown_minutes: 45,
      });
    });

    it('update persists dreaming limits + skill_evolution.model and toWire reflects them', async () => {
      const { service } = await makeRealService();
      await service.create({ id: 'agent', name: 'Agent', toolset: [], soulMd: '# Agent' });

      const { personality } = await service.update('agent', {
        dreaming: { enable: true, idleMinutes: 30, maxPerDay: 3 },
        skill_evolution: { model: 'gpt-4o-mini' },
      });
      expect(personality.dreaming).toEqual({ enable: true, idleMinutes: 30, maxPerDay: 3 });
      expect(personality.skill_evolution?.model).toBe('gpt-4o-mini');

      const reloaded = await service.get('agent');
      expect(reloaded.personality.dreaming).toEqual({
        enable: true,
        idleMinutes: 30,
        maxPerDay: 3,
      });
      expect(reloaded.personality.skill_evolution?.model).toBe('gpt-4o-mini');
    });

    // The personality editor's voice fields — create, edit, and clear, all the
    // way through config.yaml and back out on the wire.
    it('persists the voice a create carries and reads it back on the wire', async () => {
      const { service } = await makeRealService();
      const { personality } = await service.create({
        id: 'agent',
        name: 'Agent',
        toolset: [],
        soulMd: '# Agent',
        voice: { tts_provider: 'studio', tts_voice: 'nova' },
      });
      expect(personality.voice).toEqual({ tts_provider: 'studio', tts_voice: 'nova' });
      const reloaded = await service.get('agent');
      expect(reloaded.personality.voice).toEqual({ tts_provider: 'studio', tts_voice: 'nova' });
    });

    it('an update back to the default entry clears the provider on the wire too', async () => {
      const { service } = await makeRealService();
      await service.create({
        id: 'agent',
        name: 'Agent',
        toolset: [],
        soulMd: '# Agent',
        voice: { tts_provider: 'studio', tts_voice: 'nova' },
      });

      // What the edit form sends after switching the select back to Default.
      const { personality } = await service.update('agent', {
        voice: { tts_provider: '', tts_voice: 'nova' },
      });
      expect(personality.voice).toEqual({ tts_voice: 'nova' });

      const cleared = await service.update('agent', { voice: { tts_provider: '', tts_voice: '' } });
      expect(cleared.personality.voice).toBeUndefined();
    });

    it('omits voice entirely for a personality that declares none', async () => {
      const { service } = await makeRealService();
      const { personality } = await service.create({
        id: 'agent',
        name: 'Agent',
        toolset: [],
        soulMd: '# Agent',
      });
      expect(personality.voice).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Pending skill-candidate review queue — list / approve (promote) / reject.
  // Pending dir mirrors the nightly skill-evolver: <DATA>/skills/.pending/<id>.
  // -------------------------------------------------------------------------
  describe('skill-candidate review queue (L-T8: an adapter over the learning inbox)', () => {
    const LIVE = join(DATA, 'skills');
    const SKILL = '---\nname: nightly-a\ndescription: "body a"\n---\n\nbody a\n';

    async function makeCandidateService(configExtra = ''): Promise<{
      service: PersonalitiesService;
      storage: InMemoryStorage;
    }> {
      const storage = new InMemoryStorage();
      const dir = join(DATA, 'personalities', 'agent');
      await storage.mkdir(dir);
      await storage.write(join(dir, 'config.yaml'), `name: Agent\n${configExtra}`);
      await storage.write(join(dir, 'SOUL.md'), '# Core\nx\n');
      const registry = new FilePersonalityRegistry(storage, DATA);
      await registry.loadFromDirectory(join(DATA, 'personalities'));
      const library = new SkillsLibrary({ dataDir: DATA, storage });
      const learning = new LearningService({
        inbox: createLearningInbox({
          storage,
          dataDir: DATA,
          personalities: registry,
          expressions: registry,
          defaultPersonalityId: 'agent',
        }),
      });
      const service = new PersonalitiesService({
        personalities: registry,
        library,
        storage,
        dataDir: DATA,
        learning,
      });
      return { service, storage };
    }

    async function nightly(
      storage: InMemoryStorage,
      fileName: string,
      opts: { dir?: string; verdict?: 'pass' } = {},
    ) {
      const candidate = await submitCandidate(storage, DATA, {
        kind: 'skill',
        op: 'create',
        personalityId: 'agent',
        origin: 'nightly',
        destination: join(opts.dir ?? LIVE, fileName),
        content: SKILL,
      });
      if (opts.verdict) {
        await updateCandidate(storage, DATA, candidate.id, {
          status: 'pending_review',
          verdict: opts.verdict,
        });
      }
      return candidate;
    }

    it('lists waiting skill candidates by the file they land as', async () => {
      const { service, storage } = await makeCandidateService();
      await nightly(storage, 'nightly-a.md');
      await nightly(storage, 'nightly-b.md');

      const { candidates } = await service.skillCandidatesList('agent');
      expect(candidates.map((c) => c.fileName).sort()).toEqual(['nightly-a.md', 'nightly-b.md']);
      expect(candidates[0]?.content).toContain('body a');
    });

    it('drains a legacy skills/.pending/<id>/ file into the list on first use', async () => {
      const { service, storage } = await makeCandidateService();
      const legacy = join(DATA, 'skills', '.pending', 'agent');
      await storage.mkdir(legacy);
      await storage.write(join(legacy, 'nightly-old.md'), SKILL);

      const { candidates } = await service.skillCandidatesList('agent');
      expect(candidates.map((c) => c.fileName)).toEqual(['nightly-old.md']);
      expect(await storage.exists(join(legacy, 'nightly-old.md'))).toBe(false);
    });

    it('returns [] when nothing is waiting', async () => {
      const { service } = await makeCandidateService();
      const { candidates } = await service.skillCandidatesList('agent');
      expect(candidates).toEqual([]);
    });

    it('approve promotes a passing candidate and returns where it landed', async () => {
      const { service, storage } = await makeCandidateService();
      await nightly(storage, 'nightly-a.md', { verdict: 'pass' });

      const result = await service.skillCandidateApprove('agent', 'nightly-a.md');
      expect(result).toEqual({ ok: true, promotedTo: join(LIVE, 'nightly-a.md') });
      expect(await storage.read(join(LIVE, 'nightly-a.md'))).toContain('body a');
      expect((await service.skillCandidatesList('agent')).candidates).toEqual([]);
    });

    // B-T7 — `skill_evolution.scope: personality` means the per-personality
    // skills dir; `promote()` re-resolves it with `liveSkillDir`.
    it("approve honours skill_evolution.scope='personality'", async () => {
      const { service, storage } = await makeCandidateService(
        'skill_evolution.scope: personality\n',
      );
      const scopedDir = join(DATA, 'personalities', 'agent', 'skills');
      await nightly(storage, 'nightly-a.md', { dir: scopedDir, verdict: 'pass' });

      const result = await service.skillCandidateApprove('agent', 'nightly-a.md');

      expect(result).toEqual({ ok: true, promotedTo: join(scopedDir, 'nightly-a.md') });
      expect(await storage.exists(join(LIVE, 'nightly-a.md'))).toBe(false);
    });

    it('approve refuses a never-replayed candidate — it needs an override reason this procedure cannot carry', async () => {
      const { service, storage } = await makeCandidateService();
      await nightly(storage, 'nightly-a.md');

      await expect(service.skillCandidateApprove('agent', 'nightly-a.md')).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      expect(await storage.exists(join(LIVE, 'nightly-a.md'))).toBe(false);
    });

    it('approve on a missing candidate throws SKILL_NOT_FOUND', async () => {
      const { service } = await makeCandidateService();
      await expect(service.skillCandidateApprove('agent', 'nope.md')).rejects.toMatchObject({
        code: 'SKILL_NOT_FOUND',
      });
    });

    it('reject rejects the waiting candidate', async () => {
      const { service, storage } = await makeCandidateService();
      const candidate = await nightly(storage, 'nightly-a.md');

      await service.skillCandidateReject('agent', 'nightly-a.md');

      const [stored] = await listCandidates(storage, DATA);
      expect(stored).toMatchObject({ id: candidate.id, status: 'rejected' });
    });

    it('reject on a missing candidate succeeds idempotently', async () => {
      const { service } = await makeCandidateService();
      await expect(service.skillCandidateReject('agent', 'nightly-a.md')).resolves.toBeUndefined();
    });

    it('rejects a traversal file name and writes nothing', async () => {
      const { service, storage } = await makeCandidateService();
      await expect(service.skillCandidateApprove('agent', '../evil.md')).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      await expect(service.skillCandidateReject('agent', 'a/b.md')).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      expect(await storage.exists(join(LIVE, 'evil.md'))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('safety + memory overrides round-trip', () => {
    async function makeRealService() {
      const storage = new InMemoryStorage();
      const registry = new FilePersonalityRegistry(storage, DATA);
      const library = new SkillsLibrary({ dataDir: DATA, storage });
      const service = new PersonalitiesService({ personalities: registry, library });
      return { service, storage };
    }

    it('update persists safety.approvalMode + memory.provider and toWire reflects them', async () => {
      const { service } = await makeRealService();
      await service.create({ id: 'agent', name: 'Agent', toolset: [], soulMd: '# Agent' });

      const { personality } = await service.update('agent', {
        safety: { approvalMode: 'smart' },
        memory: { provider: 'vector' },
      });
      expect(personality.safety?.approvalMode).toBe('smart');
      expect(personality.memory?.provider).toBe('vector');

      const reloaded = await service.get('agent');
      expect(reloaded.personality.safety?.approvalMode).toBe('smart');
      expect(reloaded.personality.memory?.provider).toBe('vector');
    });
  });

  // -------------------------------------------------------------------------
  // mcp_export — the web export section's write path, through the real RPC
  // handler (contract input parse → service → registry → config.yaml).
  // -------------------------------------------------------------------------
  describe('mcp_export update', () => {
    async function makeExportService() {
      const storage = new InMemoryStorage();
      const registry = new FilePersonalityRegistry(storage, DATA);
      const library = new SkillsLibrary({ dataDir: DATA, storage });
      const service = new PersonalitiesService({ personalities: registry, library });
      await service.create({ id: 'agent', name: 'Agent', toolset: ['read_file'], soulMd: '# A' });
      const context = { personalities: service } as unknown as RpcContext;
      return { service, context };
    }

    it('passes mcp_export through to the registry, and mcpExport reports the declaration', async () => {
      const { service, context } = await makeExportService();

      await call(
        personalitiesRouter.update,
        {
          id: 'agent',
          mcp_export: {
            enabled: true,
            expose_tools: ['read_file'],
            expose_memory: 'scoped',
            expose_sessions: false,
            auth: 'bearer',
          },
        },
        { context },
      );

      const view = await service.mcpExport('agent');
      expect(view.exported).toBe(true);
      expect(view.declaration).toEqual({
        enabled: true,
        expose_tools: ['read_file'],
        expose_memory: 'scoped',
        expose_sessions: false,
        auth: 'bearer',
      });

      await call(
        personalitiesRouter.update,
        { id: 'agent', mcp_export: { enabled: false } },
        {
          context,
        },
      );
      const off = await service.mcpExport('agent');
      expect(off.exported).toBe(false);
      expect(off.declaration).toEqual({
        enabled: false,
        expose_tools: ['read_file'],
        expose_memory: 'scoped',
        expose_sessions: false,
        auth: 'bearer',
      });
    });

    it('mcpExport reports a null declaration when the personality declares none', async () => {
      const { service } = await makeExportService();
      expect((await service.mcpExport('agent')).declaration).toBeNull();
    });

    it('the handler refuses an empty tools list before anything is written', async () => {
      const { service, context } = await makeExportService();
      await expect(
        call(
          personalitiesRouter.update,
          { id: 'agent', mcp_export: { enabled: true, expose_tools: [] } },
          { context },
        ),
      ).rejects.toThrow();
      expect((await service.mcpExport('agent')).declaration).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // decisions — Edit → Config › Decision model (plan
  // decision-provider-personality §9), through the real RPC handler: contract
  // input parse → service → registry → config.yaml → wire, with every site
  // resolved server-side against the operator's `decisions.*`.
  // -------------------------------------------------------------------------
  describe('decisions update', () => {
    async function makeDecisionsService(global: DecisionsConfig | undefined) {
      const storage = new InMemoryStorage();
      const registry = new FilePersonalityRegistry(storage, DATA);
      const library = new SkillsLibrary({ dataDir: DATA, storage });
      const service = new PersonalitiesService({
        personalities: registry,
        library,
        readDecisions: async () => global,
      });
      await service.create({ id: 'agent', name: 'Agent', toolset: [], soulMd: '# A' });
      const context = { personalities: service } as unknown as RpcContext;
      const file = async () =>
        (await storage.read(join(DATA, 'personalities/agent/config.yaml'))) ?? '';
      return { service, context, file };
    }

    const OPERATOR: DecisionsConfig = { provider: 'typesafe', thresholds: { injection: 0.9 } };

    it('writes decisions lines, reads them back, and resolves each site', async () => {
      const { service, context, file } = await makeDecisionsService(OPERATOR);
      const out = await call(
        personalitiesRouter.update,
        {
          id: 'agent',
          decisions: { provider: 'typesafe', sites: { injection: 'on', approver: 'on' } },
        },
        { context },
      );
      const text = await file();
      expect(text).toContain('decisions.provider: typesafe');
      expect(text).toContain('decisions.sites.injection: on');
      expect(text).toContain('decisions.sites.approver: on');
      expect(text).not.toContain('decisions.sites.router');

      const expected = {
        provider: 'typesafe',
        sites: { injection: 'on', approver: 'on' },
        resolved: {
          configured: true,
          // No vault wired in this harness: the key reads as absent.
          apiKeyPresent: false,
          sites: [
            { site: 'injection', requested: 'on', effective: 'on', missingThresholds: [] },
            {
              site: 'approver',
              requested: 'on',
              effective: 'shadow',
              reason: 'threshold-missing',
              missingThresholds: [
                'decisions.thresholds.approver.approve',
                'decisions.thresholds.approver.deny',
              ],
              // Undeclared approvalMode is `manual`: the approver is never consulted.
              inertApprovalMode: 'manual',
            },
            {
              site: 'router',
              requested: 'off',
              effective: 'off',
              reason: 'undeclared',
              missingThresholds: [],
            },
          ],
        },
      };
      expect(out.personality.decisions).toEqual(expected);
      expect((await service.get('agent')).personality.decisions).toEqual(expected);
    });

    it('merges sites one by one, and provider "" clears the reference', async () => {
      const { context, service } = await makeDecisionsService(OPERATOR);
      await call(
        personalitiesRouter.update,
        { id: 'agent', decisions: { provider: 'typesafe', sites: { injection: 'shadow' } } },
        { context },
      );
      await call(
        personalitiesRouter.update,
        { id: 'agent', decisions: { sites: { router: 'shadow' } } },
        { context },
      );
      expect((await service.get('agent')).personality.decisions?.sites).toEqual({
        injection: 'shadow',
        router: 'shadow',
      });
      const cleared = await call(
        personalitiesRouter.update,
        { id: 'agent', decisions: { provider: '' } },
        { context },
      );
      expect(cleared.personality.decisions?.provider).toBeUndefined();
      // The sites stay, inert: without a provider they resolve `off` (PD10).
      expect(cleared.personality.decisions?.resolved?.sites[0]).toEqual({
        site: 'injection',
        requested: 'shadow',
        effective: 'off',
        reason: 'no-provider',
        missingThresholds: [],
      });
    });

    it('resolves not-configured when the operator configured no provider', async () => {
      const { context } = await makeDecisionsService(undefined);
      const out = await call(
        personalitiesRouter.update,
        { id: 'agent', decisions: { provider: 'typesafe', sites: { injection: 'shadow' } } },
        { context },
      );
      expect(out.personality.decisions?.resolved?.configured).toBe(false);
      expect(out.personality.decisions?.resolved?.sites[0]?.reason).toBe('not-configured');
      expect(out.personality.decisions?.resolved?.sites[0]?.effective).toBe('off');
    });

    it.each([
      ['an unknown provider', { provider: 'openai' }],
      ['an unknown mode', { sites: { injection: 'always' } }],
      ['an unknown site', { sites: { summarizer: 'on' } }],
      ['an unknown key', { provider: 'typesafe', thresholds: { injection: 0.1 } }],
    ])('the handler refuses %s before anything is written', async (_label, decisions) => {
      const { context, file } = await makeDecisionsService(OPERATOR);
      const before = await file();
      await expect(
        call(
          personalitiesRouter.update,
          // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid input
          { id: 'agent', decisions: decisions as any },
          { context },
        ),
      ).rejects.toThrow();
      expect(await file()).toBe(before);
    });

    it('characterSheet renders the same ## Decisions section as ethos personality show', async () => {
      const { service, context } = await makeDecisionsService(OPERATOR);
      await call(
        personalitiesRouter.update,
        { id: 'agent', decisions: { provider: 'typesafe', sites: { injection: 'shadow' } } },
        { context },
      );
      const { markdown } = await service.characterSheet('agent');
      expect(markdown).toContain('## Decisions');
      expect(markdown).toContain('- injection: shadow');
      // The resolved context, not just the declared values: host and key state.
      expect(markdown).toContain('api.typesafe.ai');
      expect(markdown).toContain('no key at vault ref providers/typesafe/apiKey');
    });

    it('omits decisions for a personality that declares none, and resolved without the seam', async () => {
      const { service } = await makeDecisionsService(OPERATOR);
      expect((await service.get('agent')).personality.decisions).toBeUndefined();

      const storage = new InMemoryStorage();
      const registry = new FilePersonalityRegistry(storage, DATA);
      const bare = new PersonalitiesService({
        personalities: registry,
        library: new SkillsLibrary({ dataDir: DATA, storage }),
      });
      await bare.create({ id: 'agent', name: 'Agent', toolset: [], soulMd: '# A' });
      const { personality } = await bare.update('agent', {
        decisions: { provider: 'typesafe', sites: { router: 'on' } },
      });
      expect(personality.decisions).toEqual({ provider: 'typesafe', sites: { router: 'on' } });
    });
  });

  // -------------------------------------------------------------------------
  // renderers — skill-declared renderer capabilities, fail-closed
  // -------------------------------------------------------------------------

  describe('renderers', () => {
    const CHARTS_MD = `---
name: charts
description: Interactive charts.
required_tools: []

ethos:
  renders: ['echarts@1']
---
Emit an echarts fence.`;

    /** Registry + injector over one InMemoryStorage, with the charts skill
     *  installed into `researcher`'s per-personality skills/ dir. */
    async function makeRenderersService(withInjector: boolean) {
      const storage = new InMemoryStorage();
      const pdir = join(DATA, 'personalities', 'researcher');
      await storage.mkdir(join(pdir, 'skills'));
      await storage.write(join(pdir, 'config.yaml'), 'name: Researcher\n');
      await storage.write(join(pdir, 'SOUL.md'), '# Researcher\n');
      await storage.write(join(pdir, 'skills', 'charts.md'), CHARTS_MD);

      const registry = new FilePersonalityRegistry(storage, DATA);
      await registry.loadFromDirectory(join(DATA, 'personalities'));
      registry.setDefault('researcher');

      const injector = new SkillsInjector(registry, {
        storage,
        globalSkillsDir: join(DATA, 'skills'),
        // Hermetic pool — no real ~/.ethos or ~/.claude skills.
        scanner: new UniversalScanner({ storage, sources: [] }),
      });

      const service = new PersonalitiesService({
        personalities: registry,
        library: new SkillsLibrary({ dataDir: DATA, storage }),
        ...(withInjector ? { skillsInjector: injector } : {}),
      });
      return { service, injector };
    }

    it('returns the union of ethos.renders across the resolved skill set', async () => {
      const { service } = await makeRenderersService(true);
      expect(await service.renderers('researcher')).toEqual({ renderers: ['echarts@1'] });
    });

    it('returns [] when no injector is wired', async () => {
      const { service } = await makeRenderersService(false);
      expect(await service.renderers('researcher')).toEqual({ renderers: [] });
    });

    it('returns [] for an unknown personality instead of the default personality set', async () => {
      const { service } = await makeRenderersService(true);
      expect(await service.renderers('ghost')).toEqual({ renderers: [] });
    });

    it('returns [] when the derivation throws (fail-closed, never breaks the page)', async () => {
      const { service, injector } = await makeRenderersService(true);
      injector.resolveRenderers = async () => {
        throw new Error('scanner exploded');
      };
      expect(await service.renderers('researcher')).toEqual({ renderers: [] });
    });

    // Lane E — the character sheet reads the SAME derivation, so the sheet's
    // claim and the RPC the web renderer gates on cannot drift.
    it('characterSheet names the declared renderer under Capabilities', async () => {
      const { service } = await makeRenderersService(true);
      const { markdown } = await service.characterSheet('researcher');
      expect(markdown).toContain('- Renders: echarts@1 (interactive charts — via charts skill)');
    });

    it('characterSheet omits the Renders line when no injector is wired', async () => {
      const { service } = await makeRenderersService(false);
      const { markdown } = await service.characterSheet('researcher');
      expect(markdown).not.toContain('Renders:');
    });
  });
});

// M-T8 — the `## MCP export` block on the Web Personalities tab. The block
// existed before this; what was missing was a caller that RESOLVED the slice,
// so every sheet the RPC rendered fell back to "not available in this
// rendering". The seam is driven here with the REAL resolver over a REAL
// `DefaultToolRegistry` — `resolveMcpExportScope` is the one owner of that
// resolution and the same function `ethos mcp serve` runs the exported turn
// under, so a stub scope would pin the plumbing and not the answer.
describe('PersonalitiesService — resolved ## MCP export block (M-T8)', () => {
  function tool(name: string): Tool {
    return {
      name,
      description: '',
      schema: {},
      capabilities: {},
      execute: async () => ({ ok: true, value: '' }),
    };
  }

  async function makeExportService(mcpExportDeclared: boolean) {
    const storage = new InMemoryStorage();
    const soulPath = join(DATA, 'personalities', 'exporter', 'SOUL.md');
    await storage.mkdir(join(DATA, 'personalities', 'exporter'));
    await storage.write(soulPath, '# Exporter\n\nI answer questions from other apps.\n');
    const registry = new FilePersonalityRegistry(storage, DATA);
    const config: PersonalityConfig = {
      id: 'exporter',
      name: 'Exporter',
      soulFile: soulPath,
      toolset: ['read_file', 'memory_read'],
      ...(mcpExportDeclared
        ? {
            mcp_export: {
              enabled: true,
              // `terminal` is NOT in the toolset — `expose_tools` can only ever
              // remove reach, so the sheet must name it as dropped.
              expose_tools: ['read_file', 'memory_read', 'terminal'],
              expose_memory: 'scoped' as const,
            },
          }
        : {}),
    };
    registry.define(config);
    registry.setDefault('exporter');
    const library = new SkillsLibrary({ dataDir: DATA, storage });

    const tools = new DefaultToolRegistry();
    tools.register(tool('read_file'));
    tools.register(tool('memory_read'));
    tools.register(tool('terminal'));

    const service = new PersonalitiesService({
      personalities: registry,
      library,
      // Exactly what `serve.ts` wires: the live registry, the one resolver.
      mcpExport: async (id) => {
        const described = registry.describe(id);
        return described ? resolveMcpExportScope(described.config, tools) : null;
      },
    });
    return { service, config, registry, tools };
  }

  it('names the tools a caller may use and the ones the declaration did not get', async () => {
    const { service } = await makeExportService(true);
    const { markdown } = await service.characterSheet('exporter');
    expect(markdown).toContain('- Status: exported — `ethos mcp serve --personality exporter`');
    expect(markdown).toContain("- Caller's turn may use: memory_read, read_file");
    expect(markdown).toContain("    - terminal — dropped, not in this personality's reach");
    expect(markdown).toContain('- Memory: scoped — personality:exporter, read-only');
    expect(markdown).not.toContain('not available in this rendering');
  });

  // One generator, both surfaces: the RPC markdown IS `renderCharacterSheet`'s
  // output for the resolved scope — and an `McpExportScope` satisfies the
  // sheet's 9th parameter structurally, with no cast on either call site.
  it('renders through the same generator the CLI does, with the resolver output passed straight in', async () => {
    const { service, config, registry, tools } = await makeExportService(true);
    const { markdown } = await service.characterSheet('exporter');
    const soulMd = await registry.readSoulMd('exporter');
    expect(markdown).toBe(
      renderCharacterSheet(
        config,
        soulMd,
        undefined,
        undefined,
        undefined,
        [],
        undefined,
        undefined,
        resolveMcpExportScope(config, tools),
      ),
    );
  });

  it('still says not exported for a personality that declares no mcp_export', async () => {
    const { service } = await makeExportService(false);
    const { markdown } = await service.characterSheet('exporter');
    expect(markdown).toContain(
      '- Status: not exported — no other app can ask this personality anything.',
    );
    expect(markdown).not.toContain("Caller's turn may use");
  });

  // Fail-soft, the same posture as the modelFit / boundary seams above it: a
  // host that wires no registry renders the block without the resolved slice
  // rather than inventing one.
  it('falls back to the unresolved block when no seam is wired', async () => {
    const storage = new InMemoryStorage();
    const soulPath = join(DATA, 'personalities', 'exporter', 'SOUL.md');
    await storage.mkdir(join(DATA, 'personalities', 'exporter'));
    await storage.write(soulPath, '# Exporter\n\nI answer questions from other apps.\n');
    const registry = new FilePersonalityRegistry(storage, DATA);
    registry.define({
      id: 'exporter',
      name: 'Exporter',
      soulFile: soulPath,
      toolset: ['read_file'],
      mcp_export: { enabled: true, expose_tools: ['read_file'] },
    });
    registry.setDefault('exporter');
    const service = new PersonalitiesService({
      personalities: registry,
      library: new SkillsLibrary({ dataDir: DATA, storage }),
    });
    const { markdown } = await service.characterSheet('exporter');
    expect(markdown).toContain('- Status: exported');
    expect(markdown).toContain('- Resolved slice: not available in this rendering.');
  });
});

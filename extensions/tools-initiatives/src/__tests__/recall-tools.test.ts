import type {
  BriefRow,
  ExplorationRow,
  FindingRow,
  InitiativeRecallPort,
  InitiativeRow,
  Tool,
  ToolContext,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { createChatInitiativeRecallTools, createInitiativeRecallTools } from '../recall-tools';

const row = (over: Partial<InitiativeRow> = {}): InitiativeRow => ({
  id: 'ini-1',
  personalityId: 'eng',
  origin: 'human',
  parentId: null,
  state: 'active',
  configPath: '/x',
  configHash: 'h',
  version: 1,
  ...over,
});
const exploration: ExplorationRow = {
  id: 'exp-1',
  initiativeId: 'ini-1',
  ideaId: null,
  question: 'Who competes on price?',
  state: 'briefed',
  budgetUsd: 1,
  spentUsd: 0.4,
  deadline: '2026-12-01',
  estimateUsd: 1,
};
const finding: FindingRow = {
  id: 'F-31',
  explorationId: 'exp-1',
  claim: 'Acme cut prices 20%',
  sourceRef: 'https://acme.example/pricing',
  confidence: 0.8,
  createdAt: 'now',
};
const brief: BriefRow = {
  id: 'b-1',
  explorationId: 'exp-1',
  version: 2,
  bodyMd: 'Acme is undercutting us.',
  recommendedOption: 'match',
  partial: false,
};

function setup() {
  const port: InitiativeRecallPort = {
    list: vi.fn(() => [row()]),
    search: vi.fn(() => [{ kind: 'finding' as const, id: 'F-31', snippet: 'Acme cut prices 20%' }]),
    get: vi.fn((id: string) =>
      id === 'ini-1'
        ? { initiative: row(), explorations: [exploration], briefs: [brief], findings: [finding] }
        : id === 'other'
          ? {
              initiative: row({ id: 'other', personalityId: 'someone-else' }),
              explorations: [],
              briefs: [],
              findings: [],
            }
          : null,
    ),
  };
  const tools = createInitiativeRecallTools(port, 'eng');
  const runTools = createInitiativeRecallTools(port, 'eng', { surface: 'run' });
  const t = (n: string): Tool => {
    const found = tools.find((x) => x.name === n);
    if (!found) throw new Error(n);
    return found;
  };
  return {
    port,
    tools,
    runTools,
    list: t('initiative_list'),
    search: t('initiative_search'),
    get: t('initiative_get'),
  };
}

const ctx = (audience?: 'private' | 'shared'): ToolContext =>
  ({
    sessionId: 's',
    sessionKey: 'k',
    ...(audience ? { roomAudience: audience } : {}),
  }) as ToolContext;

describe('recall tools', () => {
  it('search returns finding ids', async () => {
    const { search, port } = setup();
    const r = await search.execute({ query: 'prices' }, ctx('private'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toContain('F-31');
    expect(r.value).toContain('Acme cut prices 20%');
    expect(port.search).toHaveBeenCalledWith('eng', 'prices', expect.any(Number));
  });

  it('get renders a brief with sources', async () => {
    const { get } = setup();
    const r = await get.execute({ id: 'ini-1' }, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toContain('Acme is undercutting us.');
    expect(r.value).toContain('recommendation: match');
    expect(r.value).toContain('[F-31] Acme cut prices 20%');
    expect(r.value).toContain('https://acme.example/pricing');
  });

  it('get refuses an initiative of another personality and an unknown id', async () => {
    const { get } = setup();
    expect((await get.execute({ id: 'other' }, ctx())).ok).toBe(false);
    expect((await get.execute({ id: 'nope' }, ctx())).ok).toBe(false);
  });

  it('list renders initiatives for the bound personality', async () => {
    const { list, port } = setup();
    const r = await list.execute({}, ctx());
    expect(r.ok && r.value).toContain('ini-1');
    expect(port.list).toHaveBeenCalledWith({ personalityId: 'eng' });
  });

  it('shared audience gets nothing', async () => {
    const { tools, port } = setup();
    for (const tool of tools) {
      const r = await tool.execute({ query: 'x', id: 'ini-1' }, ctx('shared'));
      expect(r.ok).toBe(false);
    }
    expect(port.list).not.toHaveBeenCalled();
    expect(port.search).not.toHaveBeenCalled();
    expect(port.get).not.toHaveBeenCalled();
  });

  it('the run surface works under the incognito shared audience, still scoped to the personality', async () => {
    const { runTools, port } = setup();
    for (const tool of runTools) {
      const r = await tool.execute({ query: 'prices', id: 'ini-1' }, ctx('shared'));
      expect(r.ok).toBe(true);
    }
    expect(port.search).toHaveBeenCalledWith('eng', 'prices', expect.any(Number));
    const get = runTools.find((x) => x.name === 'initiative_get');
    expect((await get?.execute({ id: 'other' }, ctx('shared')))?.ok).toBe(false);
  });
});

describe('chat recall tools', () => {
  const pctx = (personalityId?: string, audience?: 'private' | 'shared'): ToolContext =>
    ({
      sessionId: 's',
      sessionKey: 'k',
      ...(personalityId ? { personalityId } : {}),
      ...(audience ? { roomAudience: audience } : {}),
    }) as ToolContext;

  it('scopes every call to ctx.personalityId, so A cannot see B', async () => {
    const { port } = setup();
    const chat = createChatInitiativeRecallTools(port);
    const get = chat.find((x) => x.name === 'initiative_get') as Tool;
    const list = chat.find((x) => x.name === 'initiative_list') as Tool;
    const search = chat.find((x) => x.name === 'initiative_search') as Tool;
    expect(chat.every((t) => t.alwaysInclude === true)).toBe(true);

    await list.execute({}, pctx('alice', 'private'));
    expect(port.list).toHaveBeenCalledWith({ personalityId: 'alice' });
    await search.execute({ query: 'x' }, pctx('bob', 'private'));
    expect(port.search).toHaveBeenCalledWith('bob', 'x', expect.any(Number));
    // ini-1 belongs to 'eng': any other personality gets not-found
    expect((await get.execute({ id: 'ini-1' }, pctx('alice', 'private'))).ok).toBe(false);
    expect((await get.execute({ id: 'ini-1' }, pctx('eng', 'private'))).ok).toBe(true);
  });

  it('refuses without a personality and in a shared room', async () => {
    const { port } = setup();
    for (const tool of createChatInitiativeRecallTools(port)) {
      const args = tool.name === 'initiative_list' ? {} : { query: 'x', id: 'ini-1' };
      expect((await tool.execute(args, pctx(undefined, 'private'))).ok).toBe(false);
      expect((await tool.execute(args, pctx('eng', 'shared'))).ok).toBe(false);
    }
    expect(port.list).not.toHaveBeenCalled();
    expect(port.search).not.toHaveBeenCalled();
    expect(port.get).not.toHaveBeenCalled();
  });
});

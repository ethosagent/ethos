// L10 / R9: initiative_define and initiative_add_ideas are chat-only and private-only. The
// "absent from buildReadOnlyRegistry" half lives in packages/wiring (a tools package cannot
// import wiring): packages/wiring/src/__tests__/initiative-chat-tools-absent.test.ts.

import type {
  GuidanceMapping,
  IdeaRow,
  InitiativeConfigPort,
  InitiativeLedgerPort,
  InitiativeRow,
  Tool,
  ToolContext,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { createInitiativeChatTools } from '../chat-tools';

type SaveResult = Awaited<ReturnType<InitiativeConfigPort['save']>>;

function setup(result?: SaveResult) {
  const save = vi.fn(
    async (_input: Parameters<InitiativeConfigPort['save']>[0]): Promise<SaveResult> =>
      result ?? { ok: true, id: 'ini-1', version: 1, clamps: [], guidance: [] },
  );
  const addIdea = vi.fn(
    (i: Omit<IdeaRow, 'id' | 'createdAt'>): IdeaRow => ({ ...i, id: 'idea-1', createdAt: 'now' }),
  );
  const ledger = { addIdea } as unknown as InitiativeLedgerPort;
  const tools = createInitiativeChatTools({
    config: { save },
    ideas: () => ledger,
    recall: {
      list: ({ personalityId }) =>
        personalityId === 'eng' ? [{ id: 'ini-1' } as InitiativeRow] : [],
    },
  });
  const byName = (n: string): Tool => {
    const t = tools.find((x) => x.name === n);
    if (!t) throw new Error(`no tool ${n}`);
    return t;
  };
  return {
    save,
    addIdea,
    define: byName('initiative_define'),
    addIdeas: byName('initiative_add_ideas'),
    tools,
  };
}

const ctx = (over: Partial<ToolContext> = {}): ToolContext =>
  ({
    sessionId: 's-1',
    sessionKey: 'k',
    personalityId: 'eng',
    roomAudience: 'private',
    ...over,
  }) as ToolContext;

const draft = {
  id: 'ini-1',
  title: 'Competitor watch',
  budget: { usd_per_day: 1, usd_per_exploration: 0.5, max_open_explorations: 1 },
};

describe('initiative chat tools', () => {
  it('R9 chat only, private only', async () => {
    const { define, addIdeas, save, addIdea, tools } = setup();
    for (const t of tools) {
      expect(t.capabilities).toEqual({});
      expect(t.alwaysInclude).toBe(true);
    }
    const shared = ctx({ roomAudience: 'shared' });
    const a = await define.execute({ op: 'create', draft, confirmed: true }, shared);
    const b = await addIdeas.execute({ initiative_id: 'ini-1', ideas: ['x'] }, shared);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(addIdea).not.toHaveBeenCalled();
  });

  it('unconfirmed create is refused with the summary to show', async () => {
    const { define, save } = setup();
    const r = await define.execute({ op: 'create', draft, confirmed: false }, ctx());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('Competitor watch');
    expect(r.error).toContain('confirm');
    expect(save).not.toHaveBeenCalled();
  });

  it('unconfirmed budget change is refused, a wording change saves directly', async () => {
    const { define, save } = setup();
    const budget = await define.execute(
      { op: 'update', draft: { id: 'ini-1', budget: { usd_per_day: 9 } }, confirmed: false },
      ctx(),
    );
    expect(budget.ok).toBe(false);
    expect(save).not.toHaveBeenCalled();
    const wording = await define.execute(
      { op: 'update', draft: { id: 'ini-1', outcome: 'sharper' }, confirmed: false },
      ctx(),
    );
    expect(wording.ok).toBe(true);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        op: 'update',
        confirmedBy: 'owner_chat',
        sessionId: 's-1',
        personalityId: 'eng',
      }),
    );
  });

  it('saved card lists guidance mapping', async () => {
    const guidance: GuidanceMapping[] = [
      {
        text: 'LinkedIn',
        status: 'mapped',
        mapsTo: ['linkedin_search'],
        reason: 'public posts only',
      },
      { text: 'Mixpanel', status: 'unreachable', mapsTo: [] },
    ];
    const { define } = setup({
      ok: true,
      id: 'ini-1',
      version: 3,
      clamps: ['usd_per_day: 9 lowered to 5'],
      guidance,
      nextSurveyAt: '2026-11-29T09:00:00Z',
    });
    const r = await define.execute({ op: 'create', draft, confirmed: true }, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toContain('version 3');
    expect(r.value).toContain('usd_per_day: 9 lowered to 5');
    expect(r.value).toContain('LinkedIn → linkedin_search (public posts only)');
    expect(r.value).toContain('Mixpanel → unreachable');
    expect(r.value).toContain('2026-11-29T09:00:00Z');
  });

  it('validation error is returned verbatim', async () => {
    const { define } = setup({ ok: false, error: 'budget.usd_per_day: must be >= 0' });
    const r = await define.execute({ op: 'create', draft, confirmed: true }, ctx());
    expect(r).toMatchObject({ ok: false, error: 'budget.usd_per_day: must be >= 0' });
  });

  it('initiative_add_ideas records one idea per entry for the ctx personality', async () => {
    const { addIdeas, addIdea } = setup();
    const r = await addIdeas.execute({ initiative_id: 'ini-1', ideas: ['a', 'b'] }, ctx());
    expect(r.ok).toBe(true);
    expect(addIdea).toHaveBeenCalledTimes(2);
    expect(addIdea).toHaveBeenCalledWith(
      expect.objectContaining({ initiativeId: 'ini-1', origin: 'human', text: 'a' }),
    );
  });

  it('initiative_add_ideas refuses an initiative this personality does not own', async () => {
    const { addIdeas, addIdea } = setup();
    const foreign = await addIdeas.execute({ initiative_id: 'ini-9', ideas: ['a'] }, ctx());
    expect(foreign.ok).toBe(false);
    const otherOwner = await addIdeas.execute(
      { initiative_id: 'ini-1', ideas: ['a'] },
      ctx({ personalityId: 'ops' }),
    );
    expect(otherOwner.ok).toBe(false);
    expect(addIdea).not.toHaveBeenCalled();
  });
});

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { InitiativeLedgerPort, Tool, ToolContext } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { createInitiativeLedgerTools, createRunClarifyTool } from '../ledger-tools';

function setup() {
  const port = {
    addIdea: vi.fn(),
    propose: vi.fn(() => ({ id: 'exp-1', state: 'idea' })),
    proposeInitiativeDraft: vi.fn(() => ({ draftId: 'd-1' })),
    addFinding: vi.fn((f: Record<string, unknown>) => ({ ...f, id: 'F-1', createdAt: 'now' })),
    submitBrief: vi.fn((b: Record<string, unknown>) => ({ ...b, id: 'b-1', version: 1 })),
    addQuestion: vi.fn(() => 'q-1'),
    ideas: vi.fn(() => [
      {
        id: 'i-1',
        initiativeId: 'ini-1',
        origin: 'human',
        text: 'try X',
        sourceRef: null,
        createdAt: 'now',
      },
    ]),
    budget: vi.fn(() => ({ spentUsd: 0.2, capUsd: 1, explorationsOpen: 1 })),
    // exp-1 / i-1 belong to ini-1; exp-foreign / i-foreign to another initiative.
    ownerOf: vi.fn((_kind: string, id: string) =>
      id === 'exp-1' || id === 'i-1' ? 'ini-1' : id.endsWith('-foreign') ? 'ini-2' : null,
    ),
  };
  const tools = [
    ...createInitiativeLedgerTools(port as unknown as InitiativeLedgerPort, 'ini-1'),
    createRunClarifyTool(port as unknown as InitiativeLedgerPort, 'ini-1'),
  ];
  const t = (n: string): Tool => {
    const found = tools.find((x) => x.name === n);
    if (!found) throw new Error(n);
    return found;
  };
  return { port, tools, t };
}

const ctx = { sessionId: 's', sessionKey: 'k', roomAudience: 'private' } as ToolContext;

describe('ledger tools', () => {
  it("note and brief are bound to the window's exploration", async () => {
    const { port } = setup();
    const bound = createInitiativeLedgerTools(
      port as unknown as InitiativeLedgerPort,
      'ini-1',
      'exp-1',
    );
    const find = (n: string): Tool => {
      const t = bound.find((x) => x.name === n);
      if (!t) throw new Error(n);
      return t;
    };
    port.ownerOf.mockImplementation(() => 'ini-1');
    const note = { claim: 'c', source_ref: 's', confidence: 0.5 };
    const other = await find('initiative_note').execute({ exploration_id: 'exp-2', ...note }, ctx);
    expect(other).toMatchObject({ ok: false, code: 'not_available' });
    const brief = await find('initiative_brief').execute(
      {
        exploration_id: 'exp-2',
        options: ['a'],
        evidence: [],
        cost: 'c',
        risk: 'r',
        recommendation: 'x',
      },
      ctx,
    );
    expect(brief).toMatchObject({ ok: false, code: 'not_available' });
    expect(port.addFinding).not.toHaveBeenCalled();
    expect(port.submitBrief).not.toHaveBeenCalled();
    const own = await find('initiative_note').execute({ exploration_id: 'exp-1', ...note }, ctx);
    expect(own.ok).toBe(true);
  });

  it('propose refuses a zero, negative or non-finite estimate', async () => {
    const { t, port } = setup();
    for (const estimate_usd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = await t('initiative_propose').execute(
        { question: 'q', estimate_usd, days: 2 },
        ctx,
      );
      expect(r).toMatchObject({ ok: false, code: 'input_invalid', field: 'estimate_usd' });
    }
    expect(port.propose).not.toHaveBeenCalled();
  });

  it('note without source_ref is refused', async () => {
    const { t, port } = setup();
    const r = await t('initiative_note').execute(
      { exploration_id: 'exp-1', claim: 'c', confidence: 0.5 },
      ctx,
    );
    expect(r).toMatchObject({ ok: false, code: 'input_invalid', field: 'source_ref' });
    expect(port.addFinding).not.toHaveBeenCalled();
    const ok = await t('initiative_note').execute(
      { exploration_id: 'exp-1', claim: 'c', source_ref: 'https://x.example', confidence: 0.5 },
      ctx,
    );
    expect(ok.ok && ok.value).toContain('F-1');
  });

  it('a foreign or unknown exploration is refused and nothing is written', async () => {
    const { t, port } = setup();
    for (const id of ['exp-foreign', 'exp-missing']) {
      const note = await t('initiative_note').execute(
        { exploration_id: id, claim: 'c', source_ref: 's', confidence: 0.5 },
        ctx,
      );
      expect(note).toMatchObject({ ok: false, code: 'not_available' });
      const brief = await t('initiative_brief').execute(
        {
          exploration_id: id,
          options: ['a'],
          evidence: ['F-1'],
          cost: 'c',
          risk: 'r',
          recommendation: 'a',
        },
        ctx,
      );
      expect(brief.ok).toBe(false);
      const ask = await t('clarify').execute({ question: 'q', exploration_id: id }, ctx);
      expect(ask.ok).toBe(false);
    }
    expect(port.addFinding).not.toHaveBeenCalled();
    expect(port.submitBrief).not.toHaveBeenCalled();
    expect(port.addQuestion).not.toHaveBeenCalled();
  });

  it('propose refuses an idea owned by another initiative', async () => {
    const { t, port } = setup();
    const args = { question: 'q', estimate_usd: 1, days: 1 };
    const bad = await t('initiative_propose').execute({ ...args, idea_id: 'i-foreign' }, ctx);
    expect(bad.ok).toBe(false);
    expect(port.propose).not.toHaveBeenCalled();
    const ok = await t('initiative_propose').execute({ ...args, idea_id: 'i-1' }, ctx);
    expect(ok.ok).toBe(true);
  });

  it('propose new_initiative writes a draft row, never a file', async () => {
    const { t, port } = setup();
    const storage = new InMemoryStorage();
    const r = await t('initiative_propose').execute(
      { kind: 'new_initiative', draft_yaml: 'id: child\n', why: 'adjacent topic' },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(port.proposeInitiativeDraft).toHaveBeenCalledWith({
      parentId: 'ini-1',
      draftYaml: 'id: child\n',
      why: 'adjacent topic',
    });
    expect(await storage.list('/')).toEqual([]);
  });

  it('tools are bound to one initiative', async () => {
    const { tools, port } = setup();
    for (const tool of tools) {
      const r = await tool.execute(
        { initiative_id: 'other', question: 'q', exploration_id: 'e', claim: 'c', source_ref: 's' },
        ctx,
      );
      expect(r.ok, tool.name).toBe(false);
    }
    expect(port.propose).not.toHaveBeenCalled();
    expect(port.addFinding).not.toHaveBeenCalled();
    expect(port.addQuestion).not.toHaveBeenCalled();
    expect(port.ideas).not.toHaveBeenCalled();
    expect(port.budget).not.toHaveBeenCalled();
  });

  it('propose exploration, brief, ideas, budget and clarify call the bound port', async () => {
    const { t, port } = setup();
    expect(
      (await t('initiative_propose').execute({ question: 'q?', estimate_usd: 0.5, days: 2 }, ctx))
        .ok,
    ).toBe(true);
    expect(port.propose).toHaveBeenCalledWith({
      initiativeId: 'ini-1',
      ideaId: null,
      question: 'q?',
      estimateUsd: 0.5,
      days: 2,
    });
    const brief = await t('initiative_brief').execute(
      {
        exploration_id: 'exp-1',
        options: ['a', 'b'],
        evidence: ['F-1'],
        cost: '$1',
        risk: 'low',
        recommendation: 'a',
        partial: true,
      },
      ctx,
    );
    expect(brief.ok).toBe(true);
    expect(port.submitBrief).toHaveBeenCalledWith(
      expect.objectContaining({ explorationId: 'exp-1', recommendedOption: 'a', partial: true }),
    );
    expect((await t('initiative_ideas').execute({}, ctx)).ok).toBe(true);
    expect((await t('initiative_budget').execute({}, ctx)).ok).toBe(true);
    expect((await t('clarify').execute({ question: 'which market?' }, ctx)).ok).toBe(true);
    expect(port.addQuestion).toHaveBeenCalledWith({
      initiativeId: 'ini-1',
      explorationId: null,
      text: 'which market?',
    });
  });
});

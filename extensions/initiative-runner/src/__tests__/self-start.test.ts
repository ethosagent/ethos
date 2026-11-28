import { describe, expect, it } from 'vitest';
import { parseInitiativeFile } from '../config-schema';
import { makeFile, NOW, scriptedLLM } from './helpers/fake-ledger';
import { DATA, draft, PERSONALITY, selfStartHarness } from './helpers/self-start-harness';

const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const dir = `${DATA}/personalities/${PERSONALITY}/initiatives`;

async function files(h: ReturnType<typeof selfStartHarness>): Promise<string[]> {
  return h.storage.list(dir);
}

describe('agent-started initiatives', () => {
  it('self-start off → suggestion only, no file', async () => {
    const h = selfStartHarness({ settings: { selfStart: false } });
    await h.seed(h.parentFile());
    const report = await h.scan('growth', [draft('Trial onboarding')]);

    expect(report.drafts).toEqual([
      expect.objectContaining({ status: 'suggested', reason: expect.stringContaining('off') }),
    ]);
    // Still pending: the digest shows it. Nothing is written and nothing joins the ledger.
    expect(h.ledger.draftRows.map((d) => d.status)).toEqual(['pending']);
    expect(await files(h)).toEqual([]);
    expect([...h.ledger.initiatives.keys()]).toEqual(['growth']);
  });

  it('self-start on → one agent-origin file saved by the runner', async () => {
    const h = selfStartHarness();
    await h.seed(h.parentFile());
    const report = await h.scan('growth', [draft('Trial onboarding')]);

    expect(report.drafts[0]).toMatchObject({
      status: 'materialised',
      initiativeId: 'trial-onboarding',
    });
    expect(h.ledger.draftRows[0]?.status).toBe('materialised');
    expect(await files(h)).toEqual(['trial-onboarding.yaml']);
    const saved = parseInitiativeFile((await h.storage.read(`${dir}/trial-onboarding.yaml`)) ?? '');
    expect(saved.ok && saved.file).toMatchObject({
      origin: 'agent',
      state: 'self_started',
      parent_id: 'growth',
    });
    expect(h.ledger.configVersions).toEqual([expect.objectContaining({ confirmedBy: 'runner' })]);
  });

  it('third self-start is refused (max 2)', async () => {
    const h = selfStartHarness({
      constitution: { selfStartPoolUsdPerDay: 3, maxSelfStarted: 2 },
    });
    await h.seed(h.parentFile());
    const outcomes = [];
    for (const title of ['Alpha topic', 'Beta topic', 'Gamma topic']) {
      outcomes.push(
        ...(await h.scan('growth', [draft(title, 'budget: { usd_per_day: 0.2 }\n')])).drafts,
      );
    }
    expect(outcomes.map((o) => o.status)).toEqual(['materialised', 'materialised', 'refused']);
    expect(outcomes[2]?.reason).toContain('(2 of 2)');
    expect(h.ledger.draftRows.map((d) => d.status)).toEqual([
      'materialised',
      'materialised',
      'refused',
    ]);
    expect(await files(h)).toHaveLength(2);
  });

  it('pool is separate from human budgets', async () => {
    const h = selfStartHarness({
      constitution: { selfStartPoolUsdPerDay: 0.5, maxSelfStarted: 2 },
    });
    // The human parent has spent its whole day; the agent initiative still runs on the pool.
    await h.seed(h.parentFile());
    h.ledger.windows.push({
      id: 'W-0',
      initiativeId: 'growth',
      explorationId: null,
      kind: 'survey',
      day: '2026-11-28',
      spentUsd: 3,
      endReason: 'done',
    });
    const mine = await h.seed(
      makeFile({
        id: 'mine',
        origin: 'agent',
        state: 'self_started',
        parent_id: 'growth',
        sources: ['sessions'],
        budget: { usd_per_day: 0.3, usd_per_exploration: 0.3, max_open_explorations: 1 },
      }),
    );
    const humanBefore = h.ledger.budget('growth', '2026-11-28').spentUsd;
    const report = await h
      .runner(
        scriptedLLM(
          [
            [{ name: 'initiative_propose', input: { question: 'q', estimate_usd: 0.1, days: 1 } }],
            [],
          ],
          0.1,
        ).llm,
      )
      .runSurvey(mine.id);
    expect(report.endReason).toBe('done');
    expect(report.spentUsd).toBeGreaterThan(0);
    expect(h.ledger.budget('growth', '2026-11-28').spentUsd).toBe(humanBefore);

    // The pool total binds at run time: another agent initiative already spent 0.45 today.
    h.ledger.windows.push({
      id: 'W-9',
      initiativeId: 'other',
      explorationId: null,
      kind: 'survey',
      day: '2026-11-28',
      spentUsd: 0.45 - report.spentUsd,
      endReason: 'done',
    });
    await h.seed(
      makeFile({
        id: 'other',
        origin: 'agent',
        state: 'self_started',
        parent_id: 'growth',
        sources: ['sessions'],
      }),
    );
    const second = await h.runner(scriptedLLM([[]], 0.1).llm).runSurvey(mine.id);
    expect(second.endReason).toBe('day');
    expect(second.spentUsd).toBe(0);
  });

  it('a new self-start is clamped to what the pool has left, and refused with none', async () => {
    const h = selfStartHarness({
      constitution: { selfStartPoolUsdPerDay: 0.5, maxSelfStarted: 3 },
    });
    await h.seed(h.parentFile());
    const first = await h.scan('growth', [draft('First topic', 'budget: { usd_per_day: 0.4 }\n')]);
    const second = await h.scan('growth', [
      draft('Second topic', 'budget: { usd_per_day: 0.4 }\n'),
    ]);
    const third = await h.scan('growth', [draft('Third topic')]);
    expect(first.drafts[0]?.status).toBe('materialised');
    expect(second.drafts[0]?.status).toBe('materialised');
    const daily = async (id: string) => {
      const p = parseInitiativeFile((await h.storage.read(`${dir}/${id}.yaml`)) ?? '');
      return p.ok ? p.file.budget.usd_per_day : -1;
    };
    expect(await daily('first-topic')).toBeCloseTo(0.4, 5);
    expect(await daily('second-topic')).toBeCloseTo(0.1, 5);
    expect(third.drafts[0]).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('pool'),
    });
  });

  it('auto-pause after 14 days', async () => {
    const h = selfStartHarness();
    await h.seed(h.parentFile());
    const agent = (id: string) =>
      makeFile({
        id,
        origin: 'agent',
        state: 'self_started',
        parent_id: 'growth',
        sources: ['sessions'],
      });
    await h.seed(agent('stale'), { createdAt: ago(15) });
    await h.seed(agent('fresh'), { createdAt: ago(13) });
    await h.seed(agent('reacted'), { createdAt: ago(40), lastReactionAt: ago(3) });
    await h.seed(agent('kept'), { createdAt: ago(40), state: 'active' });

    const runner = h.runner(scriptedLLM([[]]).llm);
    expect(runner.pauseIdle()).toEqual(['stale']);
    expect(h.ledger.initiatives.get('stale')?.state).toBe('paused');
    expect(h.ledger.initiatives.get('fresh')?.state).toBe('self_started');
    expect(h.ledger.initiatives.get('reacted')?.state).toBe('self_started');
    expect(h.ledger.initiatives.get('kept')?.state).toBe('active');
    expect(h.ledger.transitions.find((t) => t.id === 'stale')?.why).toContain('14 days');
  });

  it('a run on an idle self-started initiative pauses it instead', async () => {
    const h = selfStartHarness();
    await h.seed(h.parentFile());
    await h.seed(
      makeFile({
        id: 'stale',
        origin: 'agent',
        state: 'self_started',
        parent_id: 'growth',
        sources: ['sessions'],
      }),
      {
        createdAt: ago(20),
      },
    );
    const { llm, calls } = scriptedLLM([[]]);
    await expect(h.runner(llm).runSurvey('stale')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(calls()).toBe(0);
    expect(h.ledger.initiatives.get('stale')?.state).toBe('paused');
  });

  it('stopped topic is not restarted', async () => {
    const h = selfStartHarness();
    await h.seed(h.parentFile());
    await h.seed(
      makeFile({
        id: 'churn-deep-dive',
        title: 'Churn deep dive',
        origin: 'agent',
        state: 'stopped',
        parent_id: 'growth',
        sources: ['sessions'],
      }),
      { stopReason: 'not useful to me' },
    );
    const byTitle = await h.scan('growth', [draft('churn  Deep-Dive')]);
    const byId = await h.scan('growth', [`id: churn-deep-dive\n${draft('Something else')}`]);
    for (const r of [byTitle, byId]) {
      expect(r.drafts[0]).toMatchObject({
        status: 'refused',
        reason: expect.stringContaining('not useful to me'),
      });
    }
    expect(await files(h)).toEqual([]);
  });

  it('R6 draft cannot widen parent sources', async () => {
    const h = selfStartHarness();
    await h.seed(h.parentFile({ sources: ['sessions'] }));
    const report = await h.scan('growth', [
      'title: Wider topic\noutcome: o\nsources: [sessions, web]\n',
    ]);
    expect(report.drafts[0]).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('"web"'),
    });
    expect(await files(h)).toEqual([]);
    expect(h.ledger.draftRows[0]?.refusal).toContain('"web"');
  });

  it('an agent initiative cannot start another', async () => {
    const h = selfStartHarness();
    await h.seed(h.parentFile());
    await h.seed(
      makeFile({
        id: 'kid',
        origin: 'agent',
        state: 'self_started',
        parent_id: 'growth',
        sources: ['sessions'],
      }),
    );
    const report = await h.scan('kid', [draft('Grandchild')]);
    expect(report.drafts[0]).toMatchObject({ status: 'refused' });
    expect(await files(h)).toEqual([]);
  });

  it('agent guidance is saved as notes labelled as its own', async () => {
    const h = selfStartHarness();
    await h.seed(h.parentFile());
    await h.scan('growth', [
      draft('Guided topic', 'guidance:\n  - text: prefer funnel data\n  - check the invite flow\n'),
    ]);
    const saved = parseInitiativeFile((await h.storage.read(`${dir}/guided-topic.yaml`)) ?? '');
    expect(saved.ok && saved.file.guidance).toEqual([]);
    expect(saved.ok && saved.file.notes).toEqual([
      'agent: prefer funnel data',
      'agent: check the invite flow',
      'agent: why: a gap the sources show',
    ]);
  });
});

describe('the pool cap a run reserves against', () => {
  it('passes the whole pool total as `poolUsd`, not what is left of it', async () => {
    const h = selfStartHarness({
      constitution: { selfStartPoolUsdPerDay: 0.5, maxSelfStarted: 3 },
    });
    await h.seed(h.parentFile());
    const agent = (id: string) =>
      makeFile({
        id,
        origin: 'agent',
        state: 'self_started',
        parent_id: 'growth',
        sources: ['sessions'],
        budget: { usd_per_day: 0.3, usd_per_exploration: 0.3, max_open_explorations: 1 },
      });
    const mine = await h.seed(agent('mine'));
    await h.seed(agent('other'));
    // Another agent initiative already spent $0.20 of the $0.50 pool today.
    h.ledger.windows.push({
      id: 'W-9',
      initiativeId: 'other',
      explorationId: null,
      kind: 'survey',
      day: '2026-11-28',
      spentUsd: 0.2,
      endReason: 'done',
    });
    await h.runner(scriptedLLM([[]], 0.01).llm).runSurvey(mine.id);
    // poolLeft (0.30) + the agent spend so far (0.20): the reservation's own pool scope subtracts
    // spend again, so it must be handed the total, or the $0.20 would be counted twice.
    expect(h.ledger.reservations).toHaveLength(1);
    expect(h.ledger.reservations[0]?.caps.poolUsd).toBeCloseTo(0.5, 10);
  });

  it('a human-origin run carries no pool cap', async () => {
    const h = selfStartHarness();
    const mine = await h.seed(makeFile({ id: 'human-1', sources: ['sessions'] }));
    await h.runner(scriptedLLM([[]], 0.01).llm).runSurvey(mine.id);
    expect(h.ledger.reservations[0]?.caps).not.toHaveProperty('poolUsd');
  });
});

// @vitest-environment jsdom
//
// The Learning inbox (plan `trust-before-reach.md` Part 4, L-T9), driven in
// jsdom the way `outbox-pane.test.ts` drives the Outbox.
//
// What is pinned here is what a reviewer's trust rests on: Δ carries its sign
// and direction on every case; the dry-run caveat sits with every scorecard;
// overriding a measurement cannot be done without a reason the human typed;
// a Rollback that would discard a later edit is disabled and says why; and the
// page is built from raw primitives with tokenised colour.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  LearningCandidateView,
  LearningReplayReportView,
  LearningTimelineEntryView,
} from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const listFn = vi.fn();
const getFn = vi.fn();
const approveFn = vi.fn();
const rejectFn = vi.fn();
const rollbackFn = vi.fn();
const replayFn = vi.fn();

vi.mock('../../rpc', () => ({
  rpc: {
    learning: {
      list: (...args: unknown[]) => listFn(...args),
      get: (...args: unknown[]) => getFn(...args),
      approve: (...args: unknown[]) => approveFn(...args),
      reject: (...args: unknown[]) => rejectFn(...args),
      rollback: (...args: unknown[]) => rollbackFn(...args),
      replay: (...args: unknown[]) => replayFn(...args),
    },
  },
}));

const { Learning } = await import('../Learning');

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const DRY_RUN =
  'dry-run: tools stubbed — replay measures tool choice, arguments, voice and approach, not answers that depend on real tool output';

function candidate(over: Partial<LearningCandidateView> = {}): LearningCandidateView {
  return {
    id: 'c1',
    kind: 'skill',
    op: 'rewrite',
    personalityId: 'researcher',
    origin: 'nightly',
    destination: '/home/u/.ethos/skills/cite-sources.md',
    content: '---\nname: cite-sources\n---\n## Citing\nName the file and line before quoting it.\n',
    baseHash: 'abc',
    evidence: {
      sessionIds: ['sess-1'],
      taskIds: ['ETH-412'],
      digest: 'Asked for the source twice.',
      ref: 'nightly:0.62',
    },
    targetCaseIds: ['k-up'],
    status: 'pending_review',
    verdict: 'pass',
    submittedAt: iso(7_200_000),
    updatedAt: iso(3_600_000),
    ...over,
  };
}

type Arm = NonNullable<LearningReplayReportView['cases'][number]['baseline']>;

function arm(name: 'baseline' | 'candidate', score: number, over: Partial<Arm> = {}): Arm {
  return {
    arm: name,
    text: `${name} response`,
    plan: [],
    errors: [],
    halts: [],
    costUsd: 0.02,
    completed: true,
    assertions: [],
    score,
    ...over,
  };
}

function report(over: Partial<LearningReplayReportView> = {}): LearningReplayReportView {
  return {
    runId: 'r1',
    candidateId: 'c1',
    testedOn: 'researcher',
    startedAt: iso(600_000),
    finishedAt: iso(300_000),
    verdict: 'pass',
    rules: { a: true, b: true, c: true, d: true },
    targetMeanDelta: 0.42,
    regressionMeanDelta: 0,
    regressionsWorse: 1,
    regressionCount: 2,
    costUsd: 0.31,
    maxCostUsd: 0.5,
    stopReason: null,
    error: null,
    cases: [
      {
        caseId: 'k-up',
        role: 'target',
        source: 'session',
        sourceRef: 'sess-1',
        prompt: 'where does the retry live',
        baseline: arm('baseline', 0.5, {
          text: 'It is somewhere in core.',
          plan: [{ toolCallId: 't1', toolName: 'web_search', args: {} }],
          assertions: [{ kind: 'criteria', value: 'names the file', passed: false }],
        }),
        candidate: arm('candidate', 1, {
          text: 'packages/core/src/retry.ts:42 holds it.',
          plan: [{ toolCallId: 't2', toolName: 'read_file', args: {} }],
          assertions: [{ kind: 'criteria', value: 'names the file', passed: true }],
        }),
        delta: 0.5,
      },
      {
        caseId: 'k-down',
        role: 'regression',
        source: 'kanban',
        sourceRef: 'ETH-419',
        prompt: 'explain the lane key',
        baseline: arm('baseline', 1),
        candidate: arm('candidate', 0.75),
        delta: -0.25,
      },
      {
        caseId: 'k-flat',
        role: 'regression',
        source: 'eval',
        sourceRef: 'eval:7',
        prompt: 'find the dedup TTL',
        baseline: arm('baseline', 1),
        candidate: arm('candidate', 1),
        delta: 0,
      },
    ],
    skipped: [],
    limitations: [DRY_RUN],
    ...over,
  };
}

const TIMELINE: LearningTimelineEntryView[] = [
  {
    at: iso(7_200_000),
    action: 'submitted',
    from: null,
    to: null,
    verdict: null,
    actor: 'nightly',
    reason: null,
  },
];

function detail(
  over: {
    candidate?: Partial<LearningCandidateView>;
    replay?: LearningReplayReportView | null;
    current?: { content: string | null; core: string | null };
    rollback?: { allowed: boolean; code: string | null; reason: string | null };
  } = {},
) {
  return {
    candidate: candidate(over.candidate),
    current: over.current ?? {
      content: '---\nname: cite-sources\n---\n## Citing\nQuote the source when it helps.\n',
      core: null,
    },
    replay: over.replay === undefined ? report() : over.replay,
    replayRunIds: ['r1'],
    timeline: TIMELINE,
    rollback: over.rollback ?? { allowed: false, code: 'not_promoted', reason: 'not promoted' },
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(path = '/learning?candidate=c1'): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MemoryRouter, { initialEntries: [path] }, createElement(Learning, null)),
      ),
    );
  });
  await flush();
}

function q<T extends Element>(selector: string): T | null {
  return container.querySelector<T>(selector);
}

function all(selector: string): Element[] {
  return [...container.querySelectorAll(selector)];
}

async function click(selector: string): Promise<void> {
  const el = q<HTMLElement>(selector);
  if (!el) throw new Error(`no element for ${selector}. Saw: ${container.textContent}`);
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

async function type(selector: string, value: string): Promise<void> {
  const el = q<HTMLTextAreaElement>(selector);
  if (!el) throw new Error(`no element for ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  setter?.call(el, value);
  await act(async () => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  listFn.mockResolvedValue({ candidates: [candidate()] });
  getFn.mockResolvedValue(detail());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('Learning inbox — the list', () => {
  it('groups candidates into the four sections, each row with kind, origin, verdict and age', async () => {
    listFn.mockResolvedValue({
      candidates: [
        candidate({
          id: 'a',
          status: 'pending_review',
          verdict: 'regress',
          kind: 'expression',
          op: 'update',
        }),
        candidate({
          id: 'b',
          status: 'pending_replay',
          verdict: null,
          op: 'create',
          origin: 'fork',
        }),
        candidate({ id: 'c', status: 'promoted', verdict: 'pass', origin: 'eval' }),
        candidate({ id: 'd', status: 'rejected', verdict: 'regress', origin: 'legacy' }),
        candidate({ id: 'e', status: 'rolled_back', verdict: 'pass', origin: 'chat' }),
      ],
    });
    await mount('/learning');

    const labels = all('.learning-group-label').map((el) => el.textContent);
    expect(labels).toEqual([
      'Needs review 1',
      'Waiting for replay 1',
      'Promoted 1',
      'Rejected & rolled back 2',
    ]);

    const rowText = (group: string) =>
      [
        ...(q(`[data-testid="learning-group-${group}"]`)?.querySelectorAll(
          '[data-testid="learning-row"]',
        ) ?? []),
      ].map((el) => el.textContent ?? '');
    expect(rowText('needs_review')[0]).toContain('Expression');
    expect(rowText('needs_review')[0]).toContain('Regress');
    expect(rowText('waiting_replay')[0]).toContain('New skill');
    expect(rowText('waiting_replay')[0]).toContain('Live');
    expect(rowText('waiting_replay')[0]).toContain('Not run');
    expect(rowText('promoted')[0]).toContain('Skill rewrite');
    expect(rowText('promoted')[0]).toContain('Eval');
    expect(rowText('closed').join('|')).toContain('Rejected');
    expect(rowText('closed').join('|')).toContain('Rolled back');
    expect(rowText('closed')[0]).toContain('2h ago');
    // Each row carries its own personality mark — the page chrome stays neutral.
    expect(
      q('[data-testid="learning-row"] svg[aria-label="researcher personality"]'),
    ).not.toBeNull();
  });

  it('filters to one personality when the link from Living Soul says so', async () => {
    listFn.mockResolvedValue({ candidates: [] });
    await mount('/learning?personality=researcher');
    expect(listFn).toHaveBeenCalledWith(expect.objectContaining({ personalityId: 'researcher' }));
    expect(q('[data-testid="learning-filter"]')?.textContent).toContain('researcher');
  });

  it('filters to skills when the link from the Skills page says so', async () => {
    listFn.mockResolvedValue({ candidates: [] });
    await mount('/learning?kind=skill');
    expect(listFn).toHaveBeenCalledWith(expect.objectContaining({ kind: 'skill' }));
  });
});

describe('Learning inbox — the replay scorecard', () => {
  it('renders Δ for each case with its sign and direction styling', async () => {
    await mount();
    const deltas = all('[data-testid="learning-case-delta"]').map((el) => ({
      text: el.textContent,
      direction: el.getAttribute('data-direction'),
      cls: el.className,
    }));
    expect(deltas).toEqual([
      { text: '+0.50', direction: 'up', cls: expect.stringContaining('learning-delta-up') },
      { text: '−0.25', direction: 'down', cls: expect.stringContaining('learning-delta-down') },
      { text: '0.00', direction: 'flat', cls: expect.stringContaining('learning-delta-flat') },
    ]);
    const header = q('[data-testid="learning-scorecard"]')?.textContent ?? '';
    expect(header).toContain('target +0.42');
    expect(header).toContain('regressions 1/2');
    expect(header).toContain('$0.31 of $0.50');
    expect(header).toContain('tested on researcher');
    expect(q('[data-testid="learning-scorecard-verdict"]')?.textContent).toBe('✓Pass 2/3');
  });

  it('renders the dry-run caveat whenever a scorecard is rendered', async () => {
    await mount();
    expect(
      q('[data-testid="learning-scorecard"] [data-testid="learning-caveat"]')?.textContent,
    ).toContain('Dry-run: tools stubbed.');
  });

  it('still renders the caveat when a report arrives with no limitations', async () => {
    getFn.mockResolvedValue(detail({ replay: report({ limitations: [] }) }));
    await mount();
    expect(q('[data-testid="learning-caveat"]')?.textContent).toContain('tools stubbed');
  });

  it('says "Not run" instead of drawing a scorecard for a candidate never replayed', async () => {
    getFn.mockResolvedValue(
      detail({ candidate: { verdict: null, status: 'pending_replay' }, replay: null }),
    );
    await mount();
    expect(q('[data-testid="learning-scorecard"]')).toBeNull();
    expect(q('[data-testid="learning-no-scorecard"]')?.textContent).toContain('Not run');
  });

  it('expands a case into both responses, each arm’s tool plan, and ✓/✗ per assertion', async () => {
    await mount();
    expect(q('[data-testid="learning-arm"]')).toBeNull();
    await click('[data-case-id="k-up"] [data-testid="learning-case-toggle"]');

    const arms = all('[data-testid="learning-arm"]');
    expect(arms.map((a) => a.getAttribute('data-arm'))).toEqual(['baseline', 'candidate']);
    expect(arms[0]?.querySelector('[data-testid="learning-arm-text"]')?.textContent).toBe(
      'It is somewhere in core.',
    );
    expect(arms[1]?.querySelector('[data-testid="learning-arm-text"]')?.textContent).toBe(
      'packages/core/src/retry.ts:42 holds it.',
    );
    expect(arms[0]?.querySelector('[data-testid="learning-plan-chip"]')?.textContent).toBe(
      'web_search',
    );
    expect(arms[1]?.querySelector('[data-testid="learning-plan-chip"]')?.textContent).toBe(
      'read_file',
    );
    const verdicts = all('[data-testid="learning-assertion"]').map((a) => a.textContent);
    expect(verdicts).toEqual(['✗failcriterianames the file', '✓passcriterianames the file']);
  });
});

describe('Learning inbox — decisions', () => {
  it('"Approve anyway" cannot submit without a reason, and sends override.reason when given one', async () => {
    getFn.mockResolvedValue(
      detail({ candidate: { verdict: 'regress' }, replay: report({ verdict: 'regress' }) }),
    );
    approveFn.mockResolvedValue({ candidate: candidate({ status: 'promoted' }) });
    await mount();

    // The shape changes, not just the state: no plain Approve on a non-pass.
    expect(q('[data-testid="learning-approve"]')).toBeNull();
    expect(q('[data-testid="learning-approve-anyway"]')?.textContent).toBe('Approve anyway…');
    await click('[data-testid="learning-approve-anyway"]');

    const confirm = () => q<HTMLButtonElement>('[data-testid="learning-confirm-approve"]');
    // No placeholder or default reason is offered.
    expect(q<HTMLTextAreaElement>('[data-testid="learning-override-reason"]')?.value).toBe('');
    expect(q<HTMLTextAreaElement>('[data-testid="learning-override-reason"]')?.placeholder).toBe(
      '',
    );
    expect(confirm()?.disabled).toBe(true);
    await type('[data-testid="learning-override-reason"]', '   ');
    expect(confirm()?.disabled).toBe(true);
    await click('[data-testid="learning-confirm-approve"]');
    expect(approveFn).not.toHaveBeenCalled();

    await type('[data-testid="learning-override-reason"]', '  checked the lane-key case by hand  ');
    expect(confirm()?.disabled).toBe(false);
    await click('[data-testid="learning-confirm-approve"]');
    expect(approveFn).toHaveBeenCalledTimes(1);
    expect(approveFn).toHaveBeenCalledWith({
      candidateId: 'c1',
      clientId: expect.any(String),
      override: { reason: 'checked the lane-key case by hand' },
    });
  });

  it('treats a never-replayed candidate as non-pass too', async () => {
    getFn.mockResolvedValue(
      detail({ candidate: { verdict: null, status: 'pending_replay' }, replay: null }),
    );
    await mount();
    expect(q('[data-testid="learning-approve"]')).toBeNull();
    expect(q('[data-testid="learning-approve-anyway"]')).not.toBeNull();
    expect(q('[data-testid="learning-replay"]')?.textContent).toBe('Run replay');
  });

  it('approves a passing candidate with no override', async () => {
    approveFn.mockResolvedValue({ candidate: candidate({ status: 'promoted' }) });
    await mount();
    await click('[data-testid="learning-approve"]');
    expect(approveFn).toHaveBeenCalledWith({ candidateId: 'c1', clientId: expect.any(String) });
  });

  it('shows a refusal as readable text', async () => {
    approveFn.mockRejectedValue(
      Object.assign(new Error('The live file changed since submit'), { code: 'STALE' }),
    );
    await mount();
    await click('[data-testid="learning-approve"]');
    expect(q('[data-testid="learning-notice"]')?.textContent).toContain(
      'Not applied — the live file changed since this was drafted',
    );
  });

  it('disables Rollback, with its explanation, when rollback is not allowed', async () => {
    getFn.mockResolvedValue(
      detail({
        candidate: { status: 'promoted' },
        rollback: {
          allowed: false,
          code: 'live_edited',
          reason:
            '/home/u/.ethos/skills/cite-sources.md has changed since it was promoted; rolling back would discard that edit',
        },
      }),
    );
    await mount();
    expect(q<HTMLButtonElement>('[data-testid="learning-rollback"]')?.disabled).toBe(true);
    const why = q('[data-testid="learning-rollback-why"]')?.textContent ?? '';
    expect(why).toContain('The live file was edited after promotion');
    expect(why).toContain('cite-sources.md has changed since it was promoted');
    // Nothing left to approve on a promoted candidate.
    expect(q('[data-testid="learning-approve"]')).toBeNull();
    expect(q('[data-testid="learning-approve-anyway"]')).toBeNull();
  });

  it('rolls back an allowed promotion', async () => {
    getFn.mockResolvedValue(
      detail({
        candidate: { status: 'promoted' },
        rollback: { allowed: true, code: null, reason: null },
      }),
    );
    rollbackFn.mockResolvedValue({ candidate: candidate({ status: 'rolled_back' }) });
    await mount();
    expect(q('[data-testid="learning-rollback-why"]')).toBeNull();
    await click('[data-testid="learning-rollback"]');
    await click('[data-testid="learning-confirm-rollback"]');
    expect(rollbackFn).toHaveBeenCalledWith({ candidateId: 'c1', clientId: expect.any(String) });
  });
});

describe('Learning inbox — the diff', () => {
  it('shows Core greyed and locked above an Expression diff', async () => {
    getFn.mockResolvedValue(
      detail({
        candidate: { kind: 'expression', op: 'update', content: 'I speak plainly.' },
        current: { content: 'I speak slowly.', core: 'I am a researcher. I do not guess.' },
      }),
    );
    await mount();
    expect(q('[data-testid="learning-locked"]')?.textContent).toContain('Core never changes here');
    expect(q('.learning-diff-core')?.textContent).toContain('I am a researcher. I do not guess.');
    expect(q('[data-kind="del"]')?.textContent).toBe('- I speak slowly.');
    expect(q('[data-kind="add"]')?.textContent).toBe('+ I speak plainly.');
  });

  it('draws no Core for a skill', async () => {
    await mount();
    expect(q('[data-testid="learning-locked"]')).toBeNull();
    expect(all('[data-kind="add"]').map((el) => el.textContent)).toEqual([
      '+ Name the file and line before quoting it.',
    ]);
  });
});

describe('Learning inbox — DESIGN.md conformance', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'Learning.tsx'), 'utf8');
  const css = readFileSync(join(import.meta.dirname, '..', '..', 'styles.css'), 'utf8');
  const learningCss = css.slice(css.indexOf('/* ── Learning inbox'));

  function block(selector: string): string {
    const start = learningCss.indexOf(`${selector} {`);
    expect(start, `missing rule: ${selector}`).toBeGreaterThan(-1);
    return learningCss.slice(start, learningCss.indexOf('}', start));
  }

  it('never imports the Card primitive — cards earn existence', () => {
    const antdImport = source.match(/import \{([^}]*)\} from 'antd';/)?.[1] ?? '';
    expect(antdImport.length).toBeGreaterThan(0);
    expect(antdImport).not.toContain('Card');
    expect(source).not.toMatch(/<Card[\s/>]/);
  });

  it('hardcodes no colour: every hue is a token', () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(learningCss.length).toBeGreaterThan(0);
    expect(learningCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('draws no coloured left border anywhere on the page', () => {
    expect(learningCss).not.toContain('border-left');
    expect(source).not.toMatch(/borderLeft/);
  });

  it('keeps Library chrome neutral: selection is info, never a personality accent', () => {
    expect(block('.learning-row-sel')).toContain('var(--ethos-info)');
    expect(learningCss).not.toContain('var(--accent');
  });

  it('carries state with an icon and a word, not colour alone', () => {
    expect(block('.learning-pill-ok')).toContain('var(--ethos-success)');
    expect(block('.learning-pill-bad')).toContain('var(--ethos-error)');
    expect(block('.learning-pill-wait')).toContain('var(--ethos-warning)');
    // `PillView` renders the icon and the word together, and every pill on the
    // page goes through it — `learning.test.ts` pins that each pill has both.
    expect(source).toMatch(/\{pill\.icon\}[\s\S]{0,40}<\/span>\s*\{pill\.word\}/);
    expect(source).not.toMatch(/className=\{?`?learning-pill learning-pill-(ok|bad|wait|muted)/);
  });
});

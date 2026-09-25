import type { DecisionEvent, SseEvent, StoredMessage } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import { applyAction, applyEvent, type ChatState, initialChatState } from '../chat-reducer';
import { applyEvent as applyDrawerEvent, emptyDrawerState } from '../drawer-reducer';
import {
  applyTrailEvent,
  decisionFooterSegment,
  decisionRowView,
  decisionStatusLabel,
  disagreementSegment,
  summariseTrail,
  type TrailEntry,
  type TrailState,
} from '../trail';

// plan decision-provider-personality §15.1 / §15.8 — decision rows in the
// trail: every row state, the footer tally, the placement rule (router first,
// approver before its call, injection after it), and the claim DESIGN.md's
// "one trail, two renderers" makes — live events and a reload build the same
// rows.

const NOW = 1_000_000;

function decision(over: Partial<DecisionEvent> = {}): DecisionEvent {
  return {
    type: 'decision',
    id: 'd1',
    phase: 'settled',
    site: 'injection',
    provider: 'typesafe',
    mode: 'on',
    outcome: 'ok',
    acted: true,
    verdict: 'clean',
    confidence: 0.94,
    latencyMs: 38,
    model: 'jev-1.13.0',
    personalityId: 'researcher',
    toolCallId: 'tc1',
    traceId: 'trace-1',
    ...over,
  };
}

/** The row's words as a line: glyph word tag subject — detail — duration. */
function line(event: DecisionEvent): string {
  const v = decisionRowView(event);
  return [`${v.glyph} ${v.word} ${v.tag} ${v.subject}`, v.detail, v.duration]
    .filter((part) => part !== '')
    .join(' — ');
}

describe('decision row states', () => {
  it('decided: on, ok, acted', () => {
    expect(line(decision())).toBe(
      '✓ decided jev injection · clean · conf 0.94 — jev-1.13.0 — 38 ms',
    );
    expect(decisionRowView(decision()).tone).toBe('ok');
  });

  it('unsure: on, ok, not acted — falls back to the LLM check (router: the default model)', () => {
    const unsure = decision({
      acted: false,
      verdict: undefined,
      confidence: 0.41,
      latencyMs: 1200,
    });
    expect(line(unsure)).toBe('⚠ unsure → LLM check jev injection · conf 0.41 — jev-1.13.0 — 1.2s');
    const router = decisionRowView(
      decision({ site: 'router', acted: false, verdict: undefined, toolCallId: undefined }),
    );
    expect(router.word).toBe('unsure → default model');
  });

  it('observed, agreed: shadow, disagreed false', () => {
    const agreed = decision({
      mode: 'shadow',
      acted: undefined,
      disagreed: false,
      todayVerdict: 'clean',
      latencyMs: 36,
      todayLatencyMs: 1400,
    });
    expect(line(agreed)).toBe(
      '✓ observed jev injection · clean · conf 0.94 — jev-1.13.0 · agreed with LLM check — 36 ms vs 1.4s',
    );
  });

  it('observed, disagreed: shadow, disagreed true — a warning, never a tick', () => {
    const disagreed = decisionRowView(
      decision({
        mode: 'shadow',
        acted: undefined,
        verdict: 'flagged',
        todayVerdict: 'clean',
        disagreed: true,
        latencyMs: 29,
        todayLatencyMs: 1300,
      }),
    );
    expect(`${disagreed.glyph} ${disagreed.word}`).toBe('⚠ observed');
    expect(disagreed.detail).toBe('jev-1.13.0 · LLM check said clean');
    expect(disagreed.duration).toBe('29 ms vs 1.3s');
    expect(disagreed.tone).toBe('warning');
  });

  it('observed with no comparison claims neither agreement nor disagreement', () => {
    const view = decisionRowView(
      decision({
        mode: 'shadow',
        acted: undefined,
        disagreed: undefined,
        todayLatencyMs: undefined,
      }),
    );
    expect(`${view.glyph} ${view.word}`).toBe('· observed');
    expect(view.detail).toBe('jev-1.13.0');
  });

  it('unavailable: a failed call names the outcome; `→ LLM check` only in on mode', () => {
    const on = decision({
      outcome: 'timeout',
      model: undefined,
      verdict: undefined,
      confidence: undefined,
      acted: false,
    });
    expect(line(on)).toBe('✗ unavailable → LLM check jev injection · timeout — 38 ms');
    const shadow = decisionRowView({ ...on, mode: 'shadow', acted: undefined });
    expect(shadow.word).toBe('unavailable');
    expect(shadow.tone).toBe('failed');
  });

  it('skipped: the breaker was open (PD19), not an outage', () => {
    const skipped = decision({
      outcome: 'breaker_open',
      model: undefined,
      verdict: undefined,
      confidence: undefined,
      acted: false,
      latencyMs: 0,
    });
    expect(line(skipped)).toBe(
      '✗ skipped jev injection — Jev paused after repeated failures — 0 ms',
    );
  });

  it('checking: a started on-mode decision, no duration yet', () => {
    const started = decisionRowView({
      type: 'decision',
      id: 'd1',
      phase: 'started',
      site: 'injection',
      provider: 'typesafe',
      mode: 'on',
      personalityId: 'researcher',
      toolCallId: 'tc1',
    });
    expect(`${started.glyph} ${started.word}`).toBe('· checking');
    expect(started.duration).toBe('—');
  });

  it('shows `vs` only when today was measured on the same input', () => {
    const noToday = decisionRowView(
      decision({ mode: 'shadow', acted: undefined, disagreed: false, todayLatencyMs: undefined }),
    );
    expect(noToday.duration).toBe('38 ms');
    // `on` never compares, even if a today latency were present.
    expect(decisionRowView(decision({ todayLatencyMs: 900 })).duration).toBe('38 ms');
  });

  it('an unknown provider renders under its own id rather than blanking', () => {
    expect(decisionRowView(decision({ provider: 'acme' })).tag).toBe('acme');
  });
});

describe('footer tally', () => {
  const tool = (id: string): TrailEntry => ({
    kind: 'action',
    toolCallId: id,
    toolName: 'read_file',
    args: {},
    status: 'ok',
    durationMs: 3_100,
  });
  const row = (over: Partial<DecisionEvent>): TrailEntry => {
    const event = decision(over);
    return { kind: 'decision', id: event.id, event };
  };

  it('on: `3 decisions 118 ms`, counted apart from actions', () => {
    const entries = [
      tool('a'),
      row({ id: '1', latencyMs: 40 }),
      row({ id: '2', latencyMs: 40 }),
      row({ id: '3', latencyMs: 38 }),
      tool('b'),
    ];
    const summary = summariseTrail(entries);
    expect(summary.actions).toBe(2);
    expect(summary.totalDurationMs).toBe(6_200);
    expect(decisionFooterSegment(summary.decisions)).toBe('3 decisions 118 ms');
    expect(disagreementSegment(summary.decisions)).toBeNull();
  });

  it('shadow: `3 decisions observed 104 ms` and `⚠ 1 disagreement`', () => {
    const shadow = { mode: 'shadow' as const, acted: undefined };
    const summary = summariseTrail([
      row({ id: '1', ...shadow, latencyMs: 30, disagreed: false }),
      row({ id: '2', ...shadow, latencyMs: 45, disagreed: true }),
      row({ id: '3', ...shadow, latencyMs: 29, disagreed: false }),
    ]);
    expect(decisionFooterSegment(summary.decisions)).toBe('3 decisions observed 104 ms');
    expect(disagreementSegment(summary.decisions)).toBe('⚠ 1 disagreement');
  });

  it('mixed on + shadow: `2 decisions 80 ms · 1 observed 38 ms`', () => {
    const summary = summariseTrail([
      row({ id: '1', latencyMs: 41, site: 'router' }),
      row({ id: '2', latencyMs: 39 }),
      row({ id: '3', mode: 'shadow', acted: undefined, latencyMs: 38, disagreed: false }),
    ]);
    expect(decisionFooterSegment(summary.decisions)).toBe('2 decisions 80 ms · 1 observed 38 ms');
  });

  it('singular, and no ms while nothing has settled', () => {
    expect(decisionFooterSegment(summariseTrail([row({ latencyMs: 41 })]).decisions)).toBe(
      '1 decision 41 ms',
    );
    const started = row({ phase: 'started', latencyMs: undefined, outcome: undefined });
    expect(decisionFooterSegment(summariseTrail([started]).decisions)).toBe('1 decision');
  });

  it('no decision rows → no segment', () => {
    expect(decisionFooterSegment(summariseTrail([tool('a')]).decisions)).toBeNull();
  });
});

describe('placement', () => {
  const start = (id: string): SseEvent => ({
    type: 'tool_start',
    toolCallId: id,
    toolName: 'read_file',
    args: { path: id },
  });
  const end = (id: string): SseEvent => ({
    type: 'tool_end',
    toolCallId: id,
    toolName: 'read_file',
    ok: true,
    durationMs: 5,
  });
  const order = (entries: TrailEntry[] | undefined): string[] =>
    (entries ?? []).map((e) =>
      e.kind === 'action'
        ? `tool:${e.toolCallId}`
        : e.kind === 'decision'
          ? `${e.event.site}:${e.id}`
          : e.id,
    );
  function run(events: SseEvent[]): TrailState {
    let trail: TrailState = {};
    for (const event of events) trail = applyTrailEvent(trail, 't1', event) ?? trail;
    return trail;
  }

  it('router is the first row even when it settles after a tool row', () => {
    const trail = run([start('a'), decision({ id: 'r', site: 'router', toolCallId: undefined })]);
    expect(order(trail.t1)).toEqual(['router:r', 'tool:a']);
  });

  it('approver before its call, injection after its call', () => {
    const trail = run([
      decision({ id: 'ap', site: 'approver', toolCallId: 'a' }),
      start('a'),
      end('a'),
      decision({ id: 'in', site: 'injection', toolCallId: 'a' }),
    ]);
    expect(order(trail.t1)).toEqual(['approver:ap', 'tool:a', 'injection:in']);
  });

  it('a parallel batch interleaves each decision with its own call', () => {
    const trail = run([
      decision({ id: 'apA', site: 'approver', toolCallId: 'a' }),
      decision({ id: 'apB', site: 'approver', toolCallId: 'b' }),
      start('a'),
      start('b'),
      end('a'),
      end('b'),
      decision({ id: 'inA', site: 'injection', toolCallId: 'a' }),
      decision({ id: 'inB', site: 'injection', toolCallId: 'b' }),
    ]);
    expect(order(trail.t1)).toEqual([
      'approver:apA',
      'tool:a',
      'injection:inA',
      'approver:apB',
      'tool:b',
      'injection:inB',
    ]);
  });

  it('started → settled resolves one row in place', () => {
    const trail = run([
      start('a'),
      end('a'),
      decision({ id: 'x', phase: 'started', outcome: undefined, latencyMs: undefined }),
      decision({ id: 'x' }),
    ]);
    expect(trail.t1).toHaveLength(2);
    const row = trail.t1?.[1];
    expect(row?.kind === 'decision' && row.event.phase).toBe('settled');
  });

  it('a replayed `started` never regresses a settled row', () => {
    const settled = run([start('a'), decision({ id: 'x' })]);
    const replayed = applyTrailEvent(
      settled,
      't1',
      decision({ id: 'x', phase: 'started', outcome: undefined }),
    );
    expect(replayed).toBe(settled);
  });

  it('a row that settles after its turn moved on joins the turn holding its call', () => {
    let trail = run([start('a'), end('a')]);
    trail = applyTrailEvent(trail, 't2', start('b')) ?? trail;
    trail = applyTrailEvent(trail, 't2', decision({ id: 'late', toolCallId: 'a' })) ?? trail;
    expect(order(trail.t1)).toEqual(['tool:a', 'injection:late']);
    expect(order(trail.t2)).toEqual(['tool:b']);
  });
});

describe('status line (PD20)', () => {
  const runStart: SseEvent = {
    type: 'run_start',
    provider: 'anthropic',
    model: 'm',
    source: 'personality',
  } as SseEvent;
  function sent(): ChatState {
    return applyAction(initialChatState, {
      type: 'submit-user-message',
      id: 'u1',
      text: 'read it',
      timestamp: NOW,
    });
  }
  const events: SseEvent[] = [
    runStart,
    { type: 'tool_start', toolCallId: 'tc1', toolName: 'read_file', args: { path: 'a' } },
    { type: 'tool_end', toolCallId: 'tc1', toolName: 'read_file', ok: true, durationMs: 4 },
  ];

  it('names an open on-mode decision, then hands back to thinking once it settles', () => {
    let state = sent();
    for (const e of events) state = applyEvent(state, e, NOW);
    state = applyEvent(
      state,
      decision({ phase: 'started', outcome: undefined, latencyMs: undefined, model: undefined }),
      NOW + 1,
    );
    expect(state.phase).toBe('decision');
    expect(state.currentOp).toBe('jev checking read_file result');
    state = applyEvent(state, decision(), NOW + 2);
    expect(state.phase).toBe('thinking');
    expect(state.currentOp).toBeNull();
  });

  it('shadow never sets the status line', () => {
    let state = sent();
    for (const e of events) state = applyEvent(state, e, NOW);
    const before = state.phase;
    state = applyEvent(
      state,
      decision({ mode: 'shadow', acted: undefined, disagreed: false }),
      NOW + 1,
    );
    expect(state.phase).toBe(before);
  });

  it('labels the router and an approver whose call has not started yet', () => {
    const router: TrailEntry[] = [
      {
        kind: 'decision',
        id: 'r',
        event: decision({ site: 'router', phase: 'started', toolCallId: undefined }),
      },
    ];
    expect(decisionStatusLabel(router)).toBe('jev choosing a model');
    const approver: TrailEntry[] = [
      { kind: 'decision', id: 'a', event: decision({ site: 'approver', phase: 'started' }) },
    ];
    expect(decisionStatusLabel(approver)).toBe('jev checking a tool call');
  });
});

// "One trail, two renderers": the rows a live turn builds are the rows a reload
// builds from the persisted messages and decision rows.
describe('live and reload build the same rows', () => {
  const ROUTER = decision({
    id: 'router',
    site: 'router',
    toolCallId: undefined,
    verdict: 'trivial',
    confidence: 0.91,
    latencyMs: 41,
  });
  const APPROVER = decision({ id: 'ap', site: 'approver', verdict: 'approve', latencyMs: 20 });
  const INJECTION_STARTED = decision({
    id: 'inj',
    phase: 'started',
    outcome: undefined,
    acted: undefined,
    verdict: undefined,
    confidence: undefined,
    latencyMs: undefined,
    model: undefined,
  });
  const INJECTION = decision({ id: 'inj' });
  const SHADOW = decision({
    id: 'sh',
    toolCallId: 'tc2',
    mode: 'shadow',
    acted: undefined,
    verdict: 'flagged',
    todayVerdict: 'clean',
    disagreed: true,
    latencyMs: 29,
    todayLatencyMs: 1300,
  });

  const live: SseEvent[] = [
    {
      type: 'run_start',
      provider: 'anthropic',
      model: 'm',
      source: 'personality',
      traceId: 'trace-1',
    } as SseEvent,
    ROUTER,
    APPROVER,
    { type: 'tool_start', toolCallId: 'tc1', toolName: 'read_file', args: { path: 'a' } },
    { type: 'tool_start', toolCallId: 'tc2', toolName: 'read_file', args: { path: 'b' } },
    { type: 'tool_end', toolCallId: 'tc1', toolName: 'read_file', ok: true, durationMs: 4 },
    INJECTION_STARTED,
    INJECTION,
    { type: 'tool_end', toolCallId: 'tc2', toolName: 'read_file', ok: true, durationMs: 5 },
    { type: 'text_delta', text: 'done' },
    { type: 'done', text: 'done', turnCount: 1 },
    // A late shadow reading, after the answer (PD17).
    SHADOW,
  ];

  const stored: StoredMessage[] = [
    msg({ id: 'u1', role: 'user', content: 'read it', traceId: 'trace-1' }),
    msg({
      id: 'a1',
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'tc1', name: 'read_file', input: { path: 'a' } },
        { id: 'tc2', name: 'read_file', input: { path: 'b' } },
      ],
      traceId: 'trace-1',
    }),
    msg({ id: 'r1', role: 'tool_result', content: 'A', toolCallId: 'tc1', isError: false }),
    msg({ id: 'r2', role: 'tool_result', content: 'B', toolCallId: 'tc2', isError: false }),
    msg({ id: 'a2', role: 'assistant', content: 'done', traceId: 'trace-1' }),
  ];
  const persisted = [ROUTER, APPROVER, INJECTION, SHADOW].map((event, i) => ({
    seq: i + 1,
    createdAt: '2026-09-25T00:00:00.000Z',
    event,
  }));

  /** Rows minus what history cannot carry (durations, results, args shape). */
  function rows(entries: TrailEntry[] | undefined) {
    return (entries ?? []).map((e) =>
      e.kind === 'action'
        ? { tool: e.toolCallId }
        : e.kind === 'decision'
          ? { decision: e.id, line: line(e.event) }
          : { finding: e.id },
    );
  }

  it('in the chat reducer', () => {
    let state = applyAction(initialChatState, {
      type: 'submit-user-message',
      id: 'u-local',
      text: 'read it',
      timestamp: NOW,
    });
    for (const e of live) state = applyEvent(state, e, NOW);
    const liveTurn = state.messages.find((m) => m.role === 'assistant');
    const liveRows = rows(state.trail[liveTurn?.id ?? '']);

    const reloaded = applyAction(initialChatState, {
      type: 'history-loaded',
      messages: stored,
      decisions: persisted,
    });
    const reloadRows = rows(reloaded.trail.a1);

    expect(liveRows).toEqual(reloadRows);
    // Not vacuously equal.
    expect(liveRows).toEqual([
      { decision: 'router', line: line(ROUTER) },
      { decision: 'ap', line: line(APPROVER) },
      { tool: 'tc1' },
      { decision: 'inj', line: line(INJECTION) },
      { tool: 'tc2' },
      { decision: 'sh', line: line(SHADOW) },
    ]);
  });

  it('an SSE replay over already-loaded history keeps the decision rows', () => {
    // A reload inside the replay window: the history lands first, then the
    // session stream replays the same turn. The replay defense moves the live
    // trail onto the history turn; its decisions must survive that move.
    let state = applyAction(initialChatState, {
      type: 'history-loaded',
      messages: stored,
      decisions: persisted,
    });
    for (const e of live) state = applyEvent(state, e, NOW);
    expect(state.messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(rows(state.trail.a1)).toEqual([
      { decision: 'router', line: line(ROUTER) },
      { decision: 'ap', line: line(APPROVER) },
      { tool: 'tc1' },
      { decision: 'inj', line: line(INJECTION) },
      { tool: 'tc2' },
      { decision: 'sh', line: line(SHADOW) },
    ]);
  });

  it('in the drawer, from its own subscription', () => {
    let drawer = emptyDrawerState('s1');
    for (const e of live) drawer = applyDrawerEvent(drawer, e, NOW);
    const turnId = drawer.turns[0]?.turnId ?? '';
    const reloaded = applyAction(initialChatState, {
      type: 'history-loaded',
      messages: stored,
      decisions: persisted,
    });
    expect(rows(drawer.trail[turnId])).toEqual(rows(reloaded.trail.a1));
  });

  it('drops an untraced router row on reload (§15.5 known limit), keeps the rest', () => {
    const untraced = persisted.map((row) =>
      row.event.site === 'router' ? { ...row, event: { ...row.event, traceId: undefined } } : row,
    );
    const reloaded = applyAction(initialChatState, {
      type: 'history-loaded',
      messages: stored,
      decisions: untraced,
    });
    expect(rows(reloaded.trail.a1).map((r) => ('decision' in r ? r.decision : null))).toEqual([
      'ap',
      null,
      'inj',
      null,
      'sh',
    ]);
  });
});

function msg(
  over: Partial<StoredMessage> & Pick<StoredMessage, 'id' | 'role' | 'content'>,
): StoredMessage {
  return {
    sessionId: 's1',
    toolCallId: null,
    toolName: null,
    toolCalls: null,
    timestamp: '2026-09-25T00:00:00.000Z',
    ...over,
  };
}

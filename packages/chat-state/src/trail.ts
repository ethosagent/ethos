import type { DecisionEvent, SseEvent } from '@ethosagent/web-contracts';
import { resolveDecisionProvider } from './decision-providers';

// The trail — one derivation of "what the agent did on this turn", rendered by
// two surfaces (the per-turn footer under the bubble, and the right drawer).
// See plan/phases/feedback-activity-contract.md §3–§5 and DESIGN.md
// "Feedback & activity".
//
// Zero React imports, on purpose: this is pure state, unit-testable without
// jsdom, the same rule `chat-reducer.ts` and `drawer-reducer.ts` follow. The
// row-formatting helpers (`previewArgs`, `formatDuration`, `formatJson`,
// `statusGlyph`, `statusWord`) live here rather than in a component because
// BOTH the reducer (which builds the status-line label) and the row components
// need them, and one spelling of "how a tool call reads" is the whole point of
// the contract.
//
// NOTE on history: there is deliberately no `deriveTrailsFromHistory(messages)`
// here. Durations and results live on the persisted `StoredMessage` rows, not
// on the parsed `ChatMessage[]`, so a function taking the parsed messages could
// not recover them. `parseHistory` in `chat-reducer.ts` therefore builds the
// `TrailState` as it walks the stored rows — one walk, no duplication.

/**
 * `unrecorded` is what a PRE-MIGRATION tool call reloaded from history reads
 * as: it RAN, and whether it succeeded was never persisted. `StoredMessage`
 * now carries `isError` on a `tool_result` row, so rows written since read back
 * as a real `ok`/`failed`; rows written before it have nothing to read, and
 * painting a ✓ on those would fabricate assurance the wire never carried
 * (contract §3, "fail-open must not fabricate assurance"). A live `tool_end`
 * still flips the state either way.
 */
export type TrailEntryStatus = 'pending-approval' | 'running' | 'ok' | 'failed' | 'unrecorded';

export interface TrailAction {
  kind: 'action';
  toolCallId: string;
  toolName: string;
  args: unknown;
  status: TrailEntryStatus;
  /** Absent => renders as "—" (history rows carry no duration). */
  durationMs?: number;
  result?: string;
  /** Reason copy carried from the approval request (e.g. "force-delete"). */
  reason?: string;
}

export interface TrailFinding {
  kind: 'finding';
  id: string;
  /** The claim being flagged, rendered in mono. */
  claim: string;
  /** Supporting evidence line, rendered in --text-secondary. */
  evidence?: string;
  /** toolCallId of the action this finding cites; the row focuses it. */
  citesToolCallId?: string;
}

/**
 * A decision site ran (plan decision-provider-personality §15.1): the router
 * before the turn's first call, the approver before its call, the injection
 * classifier after its call's result. The row holds the latest event for its
 * `id` — `started` (on mode, the loop waiting) until its `settled` replaces it.
 */
export interface TrailDecision {
  kind: 'decision';
  /** `DecisionEvent.id` — a `started` and its `settled` share it. */
  id: string;
  event: DecisionEvent;
}

/**
 * A loop-level notice the turn's account has to carry (ux-feedback plan A1/A4/
 * W4): a safety halt (`⚠ stopped early`), a model deviation, a `_loop`
 * compaction/fallback line, a proactive memory capture (`✓ remembered`).
 * Feedback rows, never toasts (DESIGN.md "Feedback & activity" item 6), and a
 * row that resolves in place rather than vanishing (item 7).
 */
export interface TrailNotice {
  kind: 'notice';
  id: string;
  /** Glyph + word derive from the tone — colour is never the only carrier. */
  tone: 'ok' | 'warning' | 'neutral';
  /** The state word (`stopped early`, `remembered`, `notice`). */
  word: string;
  /** Mono subject (`budget · tool_calls`, `"prefers pnpm" → USER.md`). */
  subject: string;
  /** Secondary text in --text-secondary (the halt's full message, a fix). */
  detail?: string;
}

export type TrailEntry = TrailAction | TrailFinding | TrailDecision | TrailNotice;

/** turnId -> ordered entries */
export type TrailState = Record<string, TrailEntry[]>;

/**
 * Every state a row can be in, across the trail AND the non-chat feedback rows.
 * `unverified` has no live-tool equivalent — it is what a finding row reads as.
 */
export type RowStatus = TrailEntryStatus | 'unverified';

/** Glyph + word, never colour alone (DESIGN.md "Semantic colors"). */
export function statusGlyph(status: RowStatus): string {
  if (status === 'ok') return '✓';
  if (status === 'failed') return '✗';
  if (status === 'unverified') return '⚠';
  if (status === 'pending-approval') return '?';
  // Neither a tick nor a cross: an unrecorded outcome is not an outcome.
  if (status === 'unrecorded') return '–';
  return '·';
}

export function statusWord(status: RowStatus): string {
  if (status === 'ok') return 'ok';
  if (status === 'failed') return 'failed';
  if (status === 'unverified') return 'unverified';
  if (status === 'pending-approval') return 'waiting';
  if (status === 'unrecorded') return 'unrecorded';
  return 'running';
}

export function appendTrailEntry(trail: TrailState, turnId: string, entry: TrailEntry): TrailState {
  return { ...trail, [turnId]: [...(trail[turnId] ?? []), entry] };
}

/** Apply `update` to one action of one turn. No-op when it isn't there. */
export function updateTrailAction(
  trail: TrailState,
  turnId: string,
  toolCallId: string,
  update: Partial<Omit<TrailAction, 'kind' | 'toolCallId'>>,
): TrailState {
  const entries = trail[turnId];
  if (!entries) return trail;
  const idx = entries.findIndex((e) => e.kind === 'action' && e.toolCallId === toolCallId);
  if (idx < 0) return trail;
  const entry = entries[idx];
  if (entry?.kind !== 'action') return trail;
  const next = [...entries];
  next[idx] = { ...entry, ...update };
  return { ...trail, [turnId]: next };
}

/**
 * The same update, but searching every turn newest-first.
 *
 * `tool_end` can arrive after `done` has already moved the turn into history,
 * so the turn id the caller would key on is no longer the current one.
 */
export function updateTrailActionAnywhere(
  trail: TrailState,
  toolCallId: string,
  update: Partial<Omit<TrailAction, 'kind' | 'toolCallId'>>,
): TrailState {
  // Insertion order puts the newest turn last; the newest match is the one.
  const turnIds = Object.keys(trail).reverse();
  for (const turnId of turnIds) {
    const next = updateTrailAction(trail, turnId, toolCallId, update);
    if (next !== trail) return next;
  }
  return trail;
}

/** The glyph half of a notice row's glyph + word. */
export function noticeGlyph(tone: TrailNotice['tone']): string {
  if (tone === 'ok') return '✓';
  if (tone === 'warning') return '⚠';
  return '·';
}

/** The pseudo tool name a grounding finding arrives under on `tool_progress`
 *  (producer lands with `plan/phases/ground-truth-verification.md`). */
const GROUNDING_TOOL = '_grounding';

/** The reserved loop tool name (ux-feedback plan A4, UD2): compaction/retry and
 *  provider-fallback notices ride `tool_progress` under this name. The registry
 *  refuses `_`-prefixed tool registrations, so nothing can impersonate it. */
const LOOP_TOOL = '_loop';

/** ` [ref:<toolCallId>]`, and only at the very end of the message. */
const GROUNDING_REF = / \[ref:([A-Za-z0-9_-]+)\]$/;
/** Space, EM DASH, space — what separates the claim from its evidence. */
const GROUNDING_SEP = ' \u2014 ';

/**
 * Split a `_grounding` message into the parts a finding row draws.
 *
 * The wire format (`plan/phases/ground-truth-verification.md`):
 *
 *     "<claim>"[ — <evidence>][ [ref:<toolCallId>]]
 *
 * e.g. `"tests pass" — run_tests exited 1 [ref:toolu_01ABC]`. The producer
 * replaces quotes INSIDE the claim with `'`, so the closing `"` is unambiguous
 * and an em dash inside either half is safe.
 *
 * Anything that does not parse is the whole claim, rendered as-is. The same
 * string is printed verbatim by the CLI and every channel adapter, so it has to
 * read as a sentence even unparsed — and a malformed message must never lose
 * content on the way to the screen.
 */
export function parseGroundingMessage(
  message: string,
): Pick<TrailFinding, 'claim' | 'evidence' | 'citesToolCallId'> {
  if (!message.startsWith('"')) return { claim: message };
  const close = message.indexOf('"', 1);
  // No closing quote, or nothing between the quotes: not a claim.
  if (close <= 1) return { claim: message };

  let rest = message.slice(close + 1);
  const ref = GROUNDING_REF.exec(rest);
  if (ref) rest = rest.slice(0, rest.length - ref[0].length);
  // Text after the claim that is not the evidence separator did not parse.
  if (rest !== '' && !rest.startsWith(GROUNDING_SEP)) return { claim: message };
  const evidence = rest.slice(GROUNDING_SEP.length);

  return {
    claim: message.slice(1, close),
    ...(evidence ? { evidence } : {}),
    ...(ref?.[1] ? { citesToolCallId: ref[1] } : {}),
  };
}

/**
 * The ONE event→trail transition, called by both surfaces (contract §4, "one
 * trail, two renderers"). Sharing the TYPES was not enough: each reducer
 * hand-rolled its own transition, so the drawer never grew `tool_progress` or
 * `tool.approval_required` and the two would have disagreed about the same turn
 * the moment the `_grounding` producer landed.
 *
 * `null` means the audience gate dropped it: the stream is alive, nothing
 * surfaces. An UNCHANGED trail is a different answer — it surfaced but wrote no
 * row (status text, or a `tool_end` for a call this surface never saw start).
 *
 * `turnId` names the turn a NEW row joins; `tool_end` ignores it, resolving its
 * call wherever it lives. Everything that is not the trail stays with the
 * caller — the per-turn entry cap, stall clock, phase, `pendingApprovals`.
 */
export function applyTrailEvent(
  trail: TrailState,
  turnId: string,
  event: SseEvent,
  resultCap?: number,
): TrailState | null {
  switch (event.type) {
    case 'tool_start':
      // Lane E (tools-as-code-api): in-script inner calls never surface.
      if (event.audience === 'internal') return null;
      return upsertAction(trail, turnId, {
        kind: 'action',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        status: 'running',
      });
    case 'tool_end':
      if (event.audience === 'internal') return null;
      return updateTrailActionAnywhere(trail, event.toolCallId, {
        status: event.ok ? 'ok' : 'failed',
        durationMs: event.durationMs,
        ...(event.result !== undefined ? { result: capResult(event.result, resultCap) } : {}),
      });
    case 'tool.approval_required': {
      // Deny arrives as a `tool_end` with no `tool_start`; allow as a
      // `tool_start` that flips this row to running.
      const req = event.request;
      return upsertAction(trail, turnId, {
        kind: 'action',
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        args: req.args,
        status: 'pending-approval',
        ...(req.reason ? { reason: req.reason } : {}),
      });
    }
    case 'tool_progress': {
      // Tool-progress audience boundary (CLAUDE.md): only `'user'` surfaces.
      if (event.audience !== 'user') return null;
      // A loop-level notice (compaction retry, provider fallback — A4) is a
      // notice ROW, not a tool row and not transient status text.
      if (event.toolName === LOOP_TOOL) {
        const seq = trail[turnId]?.length ?? 0;
        return appendTrailEntry(trail, turnId, {
          kind: 'notice',
          id: `${turnId}-loop-${seq}`,
          tone: 'warning',
          word: 'notice',
          subject: event.message,
        });
      }
      // Findings are trail rows (contract §5); every other user-audience
      // progress line is status text, which is the caller's business.
      if (event.toolName !== GROUNDING_TOOL) return trail;
      const seq = trail[turnId]?.length ?? 0;
      return appendTrailEntry(trail, turnId, {
        kind: 'finding',
        id: `${turnId}-finding-${seq}`,
        ...parseGroundingMessage(event.message),
      });
    }
    case 'halt': {
      // A1 — an early safety stop is a finding-class row: the reply that
      // follows is partial, and the trail is where the account of why lives.
      const seq = trail[turnId]?.length ?? 0;
      return appendTrailEntry(trail, turnId, {
        kind: 'notice',
        id: `${turnId}-halt-${seq}`,
        tone: 'warning',
        word: 'stopped early',
        subject: `${event.kind} · ${event.rule}`,
        detail: event.message,
      });
    }
    case 'memory.captured': {
      // W4 — `✓ remembered · "…"` is a trail row, not a vanishing toast
      // (DESIGN.md item 6).
      const seq = trail[turnId]?.length ?? 0;
      return appendTrailEntry(trail, turnId, {
        kind: 'notice',
        id: `${turnId}-remembered-${seq}`,
        tone: 'ok',
        word: 'remembered',
        subject: event.summary,
      });
    }
    case 'decision':
      return applyDecision(trail, turnId, event);
    default:
      return trail;
  }
}

/** Add the row, or flip the one this call already has (an approved call has one). */
function upsertAction(trail: TrailState, turnId: string, action: TrailAction): TrailState {
  const flipped = updateTrailAction(trail, turnId, action.toolCallId, {
    args: action.args,
    status: action.status,
    ...(action.reason ? { reason: action.reason } : {}),
  });
  return flipped !== trail ? flipped : appendAction(trail, turnId, action);
}

/**
 * Append a new action, with this call's approver decision rows moved to sit
 * immediately before it. Live, every approver decision of a parallel batch
 * arrives before any `tool_start`; history places each one before its own call
 * (`placeDecision`). Without the move, live and reload would order the same
 * turn differently (DESIGN.md "One trail, two renderers").
 */
function appendAction(trail: TrailState, turnId: string, action: TrailAction): TrailState {
  const entries = trail[turnId] ?? [];
  const ownApprover = (e: TrailEntry): boolean =>
    e.kind === 'decision' &&
    e.event.site === 'approver' &&
    e.event.toolCallId === action.toolCallId;
  const approvals = entries.filter(ownApprover);
  if (approvals.length === 0) return appendTrailEntry(trail, turnId, action);
  return {
    ...trail,
    [turnId]: [...entries.filter((e) => !ownApprover(e)), ...approvals, action],
  };
}

/**
 * Where a decision row goes in a turn — the ONE placement rule, used by the
 * live event and by history replay (`parseHistory`), so the two cannot order a
 * turn differently:
 *   router    → first (the trail's first row; no model-line chrome, §15.1)
 *   approver  → immediately before its call, when the call's row exists
 *   injection → after its call and any decision rows already following it
 *   otherwise → the end
 */
function decisionIndex(entries: TrailEntry[], event: DecisionEvent): number {
  if (event.site === 'router') {
    let i = 0;
    while (entries[i]?.kind === 'decision' && isRouterRow(entries[i])) i++;
    return i;
  }
  const call = event.toolCallId;
  if (call !== undefined) {
    const at = entries.findIndex((e) => e.kind === 'action' && e.toolCallId === call);
    if (at >= 0) {
      if (event.site === 'approver') return at;
      let i = at + 1;
      while (isDecisionFor(entries[i], call)) i++;
      return i;
    }
  }
  return entries.length;
}

function isRouterRow(entry: TrailEntry | undefined): boolean {
  return entry?.kind === 'decision' && entry.event.site === 'router';
}

function isDecisionFor(entry: TrailEntry | undefined, toolCallId: string): boolean {
  return entry?.kind === 'decision' && entry.event.toolCallId === toolCallId;
}

function placeDecision(trail: TrailState, turnId: string, event: DecisionEvent): TrailState {
  const entries = trail[turnId] ?? [];
  const next = [...entries];
  next.splice(decisionIndex(entries, event), 0, { kind: 'decision', id: event.id, event });
  return { ...trail, [turnId]: next };
}

/**
 * The turn a decision belongs to by its own anchors, newest first: the turn
 * holding its call (approver / injection), else the turn already holding a
 * decision of the same trace. `undefined` → the caller's turn.
 *
 * This is how a row that settles after `done` finds its turn — the
 * `updateTrailActionAnywhere` precedent (§15.3, PD17).
 */
function anchoredTurn(trail: TrailState, event: DecisionEvent): string | undefined {
  const turnIds = Object.keys(trail).reverse();
  if (event.toolCallId !== undefined) {
    const call = event.toolCallId;
    const hit = turnIds.find((id) =>
      trail[id]?.some((e) => e.kind === 'action' && e.toolCallId === call),
    );
    if (hit !== undefined) return hit;
  }
  if (event.traceId !== undefined) {
    const trace = event.traceId;
    return turnIds.find((id) =>
      trail[id]?.some((e) => e.kind === 'decision' && e.event.traceId === trace),
    );
  }
  return undefined;
}

/**
 * Replace the row carrying `event.id`, wherever it lives. A `settled` never
 * regresses to `started` (a replayed `started` after its `settled`). `null`
 * when no row carries the id.
 */
function updateDecisionAnywhere(trail: TrailState, event: DecisionEvent): TrailState | null {
  for (const [turnId, entries] of Object.entries(trail)) {
    const idx = entries.findIndex((e) => e.kind === 'decision' && e.id === event.id);
    if (idx < 0) continue;
    const current = entries[idx];
    if (current?.kind !== 'decision') return trail;
    if (current.event.phase === 'settled' && event.phase === 'started') return trail;
    const next = [...entries];
    next[idx] = { kind: 'decision', id: event.id, event };
    return { ...trail, [turnId]: next };
  }
  return null;
}

/** Apply one decision event: resolve its row in place, or place a new one. */
function applyDecision(trail: TrailState, turnId: string, event: DecisionEvent): TrailState {
  const updated = updateDecisionAnywhere(trail, event);
  if (updated !== null) return updated;
  const target = anchoredTurn(trail, event) ?? turnId;
  // No turn to join — an untraced row whose turn this surface never saw.
  if (!target) return trail;
  return placeDecision(trail, target, event);
}

/** Keep a readable head of the result and SAY the rest was cut, never drop it silently. */
function capResult(result: string, cap?: number): string {
  if (cap === undefined || result.length <= cap) return result;
  return `${result.slice(0, cap)}\n[truncated — ${result.length} chars total]`;
}

/**
 * Close a turn's trail because the turn ended without finishing: anything still
 * running did not finish, and anything still parked on `pending-approval` will
 * never be answered — the turn that asked is over and nothing is left alive to
 * resolve it — so both settle as `failed`, and saying so is the honest end.
 *
 * Callers own the other half of an unanswered approval: the request in their
 * own modal queue has to go with it, or the modal stays on screen (chat's
 * `stopTurn` / `error`).
 *
 * `reason` is the caller's account of WHY, and the two endings render
 * differently: `'stopped'` earns the `✗ stopped · N actions` lead (the turn is
 * also recorded in `stoppedTurnIds`), while `'errored'` leaves the footer to
 * lead with ✗ off the failed rows alone — the user did not stop that one.
 * Neither changes what happens to the rows, which is why it is unused here.
 */
export function closeTrail(
  trail: TrailState,
  turnId: string,
  _reason: 'stopped' | 'errored',
): TrailState {
  const entries = trail[turnId];
  if (!entries) return trail;
  let changed = false;
  const next = entries.map((e) => {
    if (e.kind !== 'action') return e;
    if (e.status !== 'running' && e.status !== 'pending-approval') return e;
    changed = true;
    return { ...e, status: 'failed' as const };
  });
  return changed ? { ...trail, [turnId]: next } : trail;
}

export interface TrailSummary {
  actions: number;
  findings: number;
  /** Actions that genuinely came back ok — never inferred from "not failed". */
  ok: number;
  failed: number;
  /** Actions whose outcome was never persisted; neither a success nor a failure. */
  unrecorded: number;
  /**
   * Actions with no outcome YET — still `running`, or still parked on an
   * approval. Neither reducer settles these when a turn simply ends (see the
   * `done` note both of them carry), so the footer is what has to stay honest
   * about them: a ✓ is withheld while any row is unsettled.
   */
  unsettled: number;
  /** Notice rows (halt / deviation / `_loop` / remembered) — counted apart
   *  from actions and findings, since they are the loop's own account. */
  notices: number;
  /** Null when NO action carries a duration — history without durations. */
  totalDurationMs: number | null;
  /**
   * Decision rows, counted apart from actions (§15.1): `on` rows (decided,
   * unsure, unavailable, skipped, or still checking) and `shadow` rows
   * (observed). The ms totals sum measured `latencyMs` only — null when no
   * row of that mode has one. `disagreements` counts shadow rows with
   * `disagreed === true`.
   */
  decisions: DecisionTally;
}

export interface DecisionTally {
  on: number;
  onMs: number | null;
  shadow: number;
  shadowMs: number | null;
  disagreements: number;
}

export function summariseTrail(entries: TrailEntry[]): TrailSummary {
  let actions = 0;
  let findings = 0;
  let notices = 0;
  let ok = 0;
  let failed = 0;
  let unrecorded = 0;
  let unsettled = 0;
  let total: number | null = null;
  const decisions: DecisionTally = {
    on: 0,
    onMs: null,
    shadow: 0,
    shadowMs: null,
    disagreements: 0,
  };
  for (const entry of entries) {
    if (entry.kind === 'finding') {
      findings++;
      continue;
    }
    if (entry.kind === 'notice') {
      notices++;
      continue;
    }
    if (entry.kind === 'decision') {
      const e = entry.event;
      const ms = e.phase === 'settled' ? e.latencyMs : undefined;
      if (e.mode === 'on') {
        decisions.on++;
        if (ms !== undefined) decisions.onMs = (decisions.onMs ?? 0) + ms;
      } else {
        decisions.shadow++;
        if (ms !== undefined) decisions.shadowMs = (decisions.shadowMs ?? 0) + ms;
        if (e.disagreed === true) decisions.disagreements++;
      }
      continue;
    }
    actions++;
    if (entry.status === 'ok') ok++;
    if (entry.status === 'failed') failed++;
    if (entry.status === 'unrecorded') unrecorded++;
    if (entry.status === 'running' || entry.status === 'pending-approval') unsettled++;
    if (entry.durationMs !== undefined) total = (total ?? 0) + entry.durationMs;
  }
  return {
    actions,
    findings,
    notices,
    ok,
    failed,
    unrecorded,
    unsettled,
    totalDurationMs: total,
    decisions,
  };
}

/**
 * The footer's decision segment (§15.1), or null with no decision rows:
 *   on only      `3 decisions 118 ms`
 *   shadow only  `3 decisions observed 104 ms`
 *   mixed        `2 decisions 80 ms · 1 observed 38 ms`
 * The ms figure is dropped when nothing of that mode was measured yet.
 * `observed` never reads as `decided` (K8): the shadow count always says so.
 */
export function decisionFooterSegment(tally: DecisionTally): string | null {
  const ms = (value: number | null): string =>
    value === null ? '' : ` ${formatDecisionMs(value)}`;
  const noun = (n: number): string => (n === 1 ? 'decision' : 'decisions');
  if (tally.on > 0 && tally.shadow > 0) {
    return `${tally.on} ${noun(tally.on)}${ms(tally.onMs)} · ${tally.shadow} observed${ms(tally.shadowMs)}`;
  }
  if (tally.on > 0) return `${tally.on} ${noun(tally.on)}${ms(tally.onMs)}`;
  if (tally.shadow > 0)
    return `${tally.shadow} ${noun(tally.shadow)} observed${ms(tally.shadowMs)}`;
  return null;
}

/**
 * The footer's notice segments, deduped by glyph + word (`⚠ stopped early`,
 * `✓ remembered`) — the collapsed line must say a notice exists, or the row
 * only reachable by expanding would effectively vanish (DESIGN.md item 7).
 */
export function noticeFooterSegments(entries: TrailEntry[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'notice') continue;
    const segment = `${noticeGlyph(entry.tone)} ${entry.word}`;
    if (seen.has(segment)) continue;
    seen.add(segment);
    out.push(segment);
  }
  return out;
}

/** `⚠ 1 disagreement` / `⚠ 2 disagreements`, or null with none. */
export function disagreementSegment(tally: DecisionTally): string | null {
  const n = tally.disagreements;
  if (n === 0) return null;
  return `⚠ ${n} ${n === 1 ? 'disagreement' : 'disagreements'}`;
}

/** Decision latencies read `118 ms` / `1.3s` — the approved design's spelling. */
export function formatDecisionMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Every state a decision row can be in (§15.1). `observed` is a shadow reading
 * with no comparison (today's path threw), so it claims neither agreement nor
 * disagreement.
 */
export type DecisionRowState =
  | 'checking'
  | 'decided'
  | 'unsure'
  | 'observed-agreed'
  | 'observed-disagreed'
  | 'observed'
  | 'unavailable'
  | 'skipped';

export function decisionRowState(e: DecisionEvent): DecisionRowState {
  if (e.phase === 'started') return 'checking';
  // PD19: the breaker refused without sending a request — not an outage.
  if (e.outcome === 'breaker_open') return 'skipped';
  if (e.outcome !== undefined && e.outcome !== 'ok') return 'unavailable';
  if (e.mode === 'on') return e.acted === true ? 'decided' : 'unsure';
  if (e.disagreed === true) return 'observed-disagreed';
  if (e.disagreed === false) return 'observed-agreed';
  return 'observed';
}

/**
 * What each site does when the decision model does not decide — today's path.
 * The router's is "no routing" (`decision-router.ts` header), so the turn runs
 * on the default model.
 */
const TODAY_PATH: Record<DecisionEvent['site'], string> = {
  injection: 'LLM check',
  approver: 'LLM review',
  router: 'default model',
};

export type DecisionTone = 'ok' | 'warning' | 'failed' | 'running' | 'neutral';

/** A decision row as every surface draws it — glyph + word, never colour alone. */
export interface DecisionRowView {
  state: DecisionRowState;
  tone: DecisionTone;
  glyph: string;
  /** The state word, with its fallback where the row fell back: `unsure → LLM check`. */
  word: string;
  /** Mono provider tag (`jev`), from the identity map. */
  tag: string;
  /** `injection · clean · conf 0.94`. */
  subject: string;
  /** Returned model and what happened: `jev-1.13.0 · agreed with LLM check`. */
  detail: string;
  /** `38 ms`, `29 ms vs 1.3s` (shadow, both measured), or `—` while checking. */
  duration: string;
}

export function decisionRowView(e: DecisionEvent): DecisionRowView {
  const state = decisionRowState(e);
  const provider = resolveDecisionProvider(e.provider);
  const today = TODAY_PATH[e.site];
  const fellBack = e.mode === 'on' ? ` → ${today}` : '';

  const subject: string[] = [e.site];
  if (state === 'unavailable') subject.push(e.outcome ?? 'unavailable');
  else if (e.verdict !== undefined) subject.push(e.verdict);
  if (e.confidence !== undefined && state !== 'unavailable' && state !== 'skipped') {
    subject.push(`conf ${e.confidence.toFixed(2)}`);
  }

  const detail: string[] = [];
  if (e.model !== undefined) detail.push(e.model);
  if (state === 'observed-agreed') detail.push(`agreed with ${today}`);
  if (state === 'observed-disagreed') {
    detail.push(
      e.todayVerdict !== undefined ? `${today} said ${e.todayVerdict}` : `disagreed with ${today}`,
    );
  }
  if (state === 'skipped') detail.push(`${provider.label} paused after repeated failures`);
  if (state === 'checking') detail.push(`waiting for ${provider.label}`);

  let duration = '—';
  if (e.latencyMs !== undefined) {
    duration = formatDecisionMs(e.latencyMs);
    // §15.1: the comparison only when both paths were measured on this input.
    if (e.mode === 'shadow' && e.todayLatencyMs !== undefined) {
      duration = `${duration} vs ${formatDecisionMs(e.todayLatencyMs)}`;
    }
  }

  const look: Record<DecisionRowState, { tone: DecisionTone; glyph: string; word: string }> = {
    checking: { tone: 'running', glyph: '·', word: 'checking' },
    decided: { tone: 'ok', glyph: '✓', word: 'decided' },
    unsure: { tone: 'warning', glyph: '⚠', word: `unsure${fellBack}` },
    'observed-agreed': { tone: 'ok', glyph: '✓', word: 'observed' },
    'observed-disagreed': { tone: 'warning', glyph: '⚠', word: 'observed' },
    observed: { tone: 'neutral', glyph: '·', word: 'observed' },
    // Shadow: today's check ran anyway, so there is nothing to fall back to.
    unavailable: { tone: 'failed', glyph: '✗', word: `unavailable${fellBack}` },
    skipped: { tone: 'failed', glyph: '✗', word: 'skipped' },
  };

  return {
    state,
    ...look[state],
    tag: provider.tag,
    subject: subject.join(' · '),
    detail: detail.join(' · '),
    duration,
  };
}

/**
 * The status line's label while an `on` decision holds the loop (PD20):
 * `jev checking read_file result`. Null when no `on` decision in `entries` is
 * still `started` — shadow never blocks, so it never gets a label.
 */
export function decisionStatusLabel(entries: TrailEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.kind !== 'decision') continue;
    const e = entry.event;
    if (e.phase !== 'started' || e.mode !== 'on') continue;
    const tag = resolveDecisionProvider(e.provider).tag;
    if (e.site === 'router') return `${tag} choosing a model`;
    const call = entries.find((x) => x.kind === 'action' && x.toolCallId === e.toolCallId);
    // The approver runs before its call's `tool_start`, so its row has no
    // tool name to borrow yet.
    const tool = call?.kind === 'action' ? call.toolName : 'a tool';
    return e.site === 'injection'
      ? `${tag} checking ${tool} result`
      : `${tag} checking ${tool} call`;
  }
  return null;
}

/** Deterministic DOM id, so a finding row can move focus to the row it cites. */
export function trailRowId(turnId: string, key: string): string {
  return `trail-row-${turnId}-${key}`;
}

/**
 * Single-line preview of args — what the call is doing, not the full payload.
 * Salvaged verbatim from `ToolChip.previewArgs` (the chip this replaced).
 */
export function previewArgs(args: unknown): string {
  if (args === null || args === undefined) return '';
  if (typeof args === 'string') return truncate(args, 60);
  if (typeof args !== 'object') return String(args);

  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return '';

  // Single-key objects are the common case (path: 'x', url: 'x', command: 'x') —
  // show the value, since the key is implicit in the tool name. Multi-key: the
  // first key's value is usually the most informative one.
  const entry = entries[0];
  if (!entry) return '';
  const [, value] = entry;
  return typeof value === 'string' ? truncate(value, 60) : truncate(JSON.stringify(value), 60);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** The status line's label for a running tool: `{tool} · {argsPreview}`. */
export function toolLabel(toolName: string, args: unknown): string {
  const preview = previewArgs(args);
  return preview ? `${toolName} · ${preview}` : toolName;
}

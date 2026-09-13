import type { LearningCandidateView, LearningReplayReportView } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from 'antd';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PersonalityMark } from '../components/ui/PersonalityMark';
import { type LearningListScope, learningKeys } from '../features/learning/api/keys';
import { getClientId } from '../lib/clientId';
import {
  candidateTitle,
  deltaDirection,
  formatAge,
  formatDelta,
  formatScore,
  formatStamp,
  formatUsd,
  groupCandidates,
  kindLabel,
  LEARNING_REJECTABLE,
  LEARNING_WAITING,
  type LearningReplayArm,
  type LearningReplayCase,
  ORIGIN_LABELS,
  type Pill,
  ROLLBACK_HEADLINES,
  rowPill,
  STATUS_WORDS,
  STOP_REASON_TEXT,
  scorecardCaveats,
  splitCaveat,
  timelineText,
  unifiedDiff,
  verdictPill,
} from '../lib/learning';
import { type LearningRefusal, learningRefusal } from '../lib/learning-refusal';
import { sessionOpenPath } from '../lib/workspaceRoutes';
import { rpc } from '../rpc';

// The Learning inbox (plan `trust-before-reach.md` Part 4, L-T9), built to the
// mockup the user signed off on. Every proposed change to a skill or an
// Expression waits here with its evidence, its diff, its replay scorecard and
// its timeline — one queue where there used to be three.
//
// Library-level chrome, so it stays neutral: this page is cross-personality,
// and each row carries its own personality mark instead of the page taking one
// personality's accent (DESIGN.md, "Global chrome stays neutral").
//
// Not the `Card` primitive. The queue is a repeated list unit, so it is dense
// rows; the right pane is bordered containers assembled from primitives. No
// colored left border. State is a pill with an icon AND a word.
//
// The rules a click is subject to — the override reason above all — are
// enforced server-side in `LearningInbox` (`extensions/learning-inbox/src/
// inbox.ts`). This page draws the right button for the state and makes a
// reason impossible to skip, but it is never the gate.

/** A replay the nightly pass finishes shows up without a reload. */
const LEARNING_POLL_MS = 30_000;

type Mode = 'approve' | 'reject' | 'rollback' | null;

export function Learning() {
  const [params, setParams] = useSearchParams();
  const personalityId = params.get('personality') ?? undefined;
  const kindParam = params.get('kind');
  const kind = kindParam === 'skill' || kindParam === 'expression' ? kindParam : undefined;
  const scope: LearningListScope = {
    ...(personalityId ? { personalityId } : {}),
    ...(kind ? { kind } : {}),
  };

  const listQuery = useQuery({
    queryKey: learningKeys.list(scope),
    queryFn: () => rpc.learning.list({ ...scope, limit: 500 }),
    refetchInterval: LEARNING_POLL_MS,
  });

  const candidates = listQuery.data?.candidates ?? [];
  const groups = groupCandidates(candidates);
  const firstId = groups.find((g) => g.items.length > 0)?.items[0]?.id ?? null;
  // A link from a Learning Log entry names a candidate that may sit outside
  // the current filter; the detail loads it by id either way.
  const selectedId = params.get('candidate') ?? firstId;

  const select = (candidateId: string) => {
    const next = new URLSearchParams(params);
    next.set('candidate', candidateId);
    setParams(next);
  };

  const clearFilter = () => {
    const next = new URLSearchParams(params);
    next.delete('personality');
    next.delete('kind');
    setParams(next);
  };

  return (
    <div className="learning-page">
      <header className="page-header-row">
        <h1 className="page-h1">Learning</h1>
        <span className="page-subtitle">
          Every proposed change to a skill or an Expression, measured by replay before it can be
          promoted.
        </span>
      </header>

      <div className="learning-body">
        {(personalityId || kind) && (
          <div className="learning-filter" data-testid="learning-filter">
            Showing
            {personalityId && (
              <span className="learning-chip">
                <PersonalityMark personalityId={personalityId} size={12} />
                <span className="learning-mono">{personalityId}</span>
              </span>
            )}
            {kind && (
              <span className="learning-chip">{kind === 'skill' ? 'Skills' : 'Expression'}</span>
            )}
            <Button size="small" type="link" onClick={clearFilter}>
              Show all
            </Button>
          </div>
        )}

        <div className="learning-panes">
          <div className="learning-list" data-testid="learning-list">
            {listQuery.isLoading ? (
              <div className="learning-empty">Loading…</div>
            ) : listQuery.isError ? (
              <div className="learning-empty">
                Could not load the inbox:{' '}
                {listQuery.error instanceof Error ? listQuery.error.message : 'unknown error'}
              </div>
            ) : candidates.length === 0 ? (
              <div className="learning-empty">
                Nothing proposed. The nightly pass, the live post-turn fork, chat{' '}
                <code>skill_propose</code> and <code>ethos evolve</code> all submit changes here.
              </div>
            ) : (
              groups.map(({ group, items }) =>
                items.length === 0 ? null : (
                  <section
                    key={group.key}
                    className="learning-group"
                    data-testid={`learning-group-${group.key}`}
                  >
                    <div className="learning-group-label">
                      {group.label} <span className="learning-group-count">{items.length}</span>
                    </div>
                    {items.map((c) => (
                      <CandidateRow
                        key={c.id}
                        candidate={c}
                        selected={c.id === selectedId}
                        onSelect={() => select(c.id)}
                      />
                    ))}
                  </section>
                ),
              )
            )}
          </div>

          {selectedId ? <CandidateDetail key={selectedId} candidateId={selectedId} /> : null}
        </div>
      </div>
    </div>
  );
}

function PillView({ pill, testId }: { pill: Pill; testId?: string }) {
  return (
    <span className={`learning-pill learning-pill-${pill.tone}`} data-testid={testId}>
      <span className="learning-pill-ic" aria-hidden="true">
        {pill.icon}
      </span>
      {pill.word}
    </span>
  );
}

function CandidateRow({
  candidate,
  selected,
  onSelect,
}: {
  candidate: LearningCandidateView;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`learning-row${selected ? ' learning-row-sel' : ''}`}
      data-testid="learning-row"
      data-candidate-id={candidate.id}
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
    >
      <span className="learning-row-top">
        <PersonalityMark personalityId={candidate.personalityId} size={14} />
        <span className="learning-row-name">{candidateTitle(candidate)}</span>
      </span>
      <span className="learning-row-bot">
        <span className="learning-chip">{kindLabel(candidate)}</span>
        <span className="learning-chip">{ORIGIN_LABELS[candidate.origin]}</span>
        <PillView pill={rowPill(candidate)} />
        <span className="learning-mono">{candidate.personalityId}</span>
        <span>{formatAge(candidate.submittedAt)}</span>
      </span>
    </button>
  );
}

function CandidateDetail({ candidateId }: { candidateId: string }) {
  const queryClient = useQueryClient();
  const clientId = getClientId();
  const [mode, setMode] = useState<Mode>(null);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<LearningRefusal | null>(null);
  const [replayNote, setReplayNote] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: learningKeys.get(candidateId),
    queryFn: () => rpc.learning.get({ candidateId }),
  });

  const open = (next: Mode) => {
    setMode(next);
    setReason('');
    setNotice(null);
  };

  const onDecided = () => {
    setMode(null);
    setReason('');
    setNotice(null);
    void queryClient.invalidateQueries({ queryKey: learningKeys.all() });
  };

  const approveMut = useMutation({
    mutationFn: (overrideReason: string | null) =>
      rpc.learning.approve({
        candidateId,
        clientId,
        ...(overrideReason ? { override: { reason: overrideReason } } : {}),
      }),
    onSuccess: onDecided,
    onError: (err, overrideReason) => {
      const refusal = learningRefusal(err, 'Approve failed');
      // The verdict changed under us (a replay landed): ask for the reason
      // rather than report a failure the person can fix by typing one.
      if (refusal.code === 'OVERRIDE_REQUIRED' && !overrideReason) setMode('approve');
      setNotice(refusal);
      void queryClient.invalidateQueries({ queryKey: learningKeys.get(candidateId) });
    },
  });

  const rejectMut = useMutation({
    mutationFn: (why: string) =>
      rpc.learning.reject({ candidateId, clientId, ...(why ? { reason: why } : {}) }),
    onSuccess: onDecided,
    onError: (err) => setNotice(learningRefusal(err, 'Reject failed')),
  });

  const rollbackMut = useMutation({
    mutationFn: (why: string) =>
      rpc.learning.rollback({ candidateId, clientId, ...(why ? { reason: why } : {}) }),
    onSuccess: onDecided,
    onError: (err) => {
      setNotice(learningRefusal(err, 'Rollback failed'));
      void queryClient.invalidateQueries({ queryKey: learningKeys.get(candidateId) });
    },
  });

  const replayMut = useMutation({
    mutationFn: () => rpc.learning.replay({ candidateId }),
    onSuccess: (result) => {
      setNotice(null);
      setReplayNote(
        result.promoted
          ? 'Replay passed and the change was promoted automatically.'
          : result.decisionReason
            ? `Held for review: ${result.decisionReason}`
            : null,
      );
      void queryClient.invalidateQueries({ queryKey: learningKeys.all() });
    },
    onError: (err) => setNotice(learningRefusal(err, 'Replay failed')),
  });

  if (detailQuery.isLoading) {
    return <div className="learning-empty learning-detail">Loading…</div>;
  }
  if (detailQuery.isError || !detailQuery.data) {
    const refusal = learningRefusal(detailQuery.error, 'Could not load this candidate');
    return (
      <div className="learning-empty learning-detail" role="alert">
        {refusal.title} — {refusal.detail}
      </div>
    );
  }

  const { candidate, current, replay, timeline, rollback } = detailQuery.data;
  const waiting = LEARNING_WAITING.includes(candidate.status);
  const rejectable = LEARNING_REJECTABLE.includes(candidate.status);
  const passed = candidate.verdict === 'pass';
  const trimmed = reason.trim();
  const busy =
    approveMut.isPending || rejectMut.isPending || rollbackMut.isPending || replayMut.isPending;
  const evidenceCount = candidate.evidence.sessionIds.length + candidate.evidence.taskIds.length;

  return (
    <div className="learning-detail" data-testid="learning-detail">
      <section className="learning-panel">
        <h2>{candidateTitle(candidate)}</h2>
        <div className="learning-kv">
          <span className="learning-chip">{kindLabel(candidate)}</span>
          <span className="learning-chip">{ORIGIN_LABELS[candidate.origin]}</span>
          <span className="learning-chip">
            <PersonalityMark personalityId={candidate.personalityId} size={12} />
            <span className="learning-mono">{candidate.personalityId}</span>
          </span>
          <span className="learning-chip learning-mono">{candidate.destination}</span>
          <span className="learning-chip">{STATUS_WORDS[candidate.status]}</span>
          <PillView pill={verdictPill(candidate.verdict, replay)} />
        </div>
        <div className="learning-sub">
          Submitted {formatAge(candidate.submittedAt)} · drafted from{' '}
          {candidate.evidence.sessionIds.length}{' '}
          {candidate.evidence.sessionIds.length === 1 ? 'session' : 'sessions'} and{' '}
          {candidate.evidence.taskIds.length}{' '}
          {candidate.evidence.taskIds.length === 1 ? 'task' : 'tasks'}
          {replay
            ? ` · ${replay.cases.length} ${replay.cases.length === 1 ? 'case' : 'cases'} · replayed ${formatAge(replay.finishedAt)}`
            : ''}
        </div>
      </section>

      <section className="learning-panel">
        <h2>Evidence</h2>
        <div className="learning-sub">What the draft was written from.</div>
        {candidate.evidence.digest ? (
          <pre className="learning-digest">{candidate.evidence.digest}</pre>
        ) : null}
        {evidenceCount > 0 || candidate.evidence.ref ? (
          <div className="learning-kv">
            {candidate.evidence.sessionIds.map((id) => (
              <Link
                key={`s:${id}`}
                className="learning-chip learning-mono"
                to={sessionOpenPath(id, candidate.personalityId)}
              >
                session · {id}
              </Link>
            ))}
            {candidate.evidence.taskIds.map((id) => (
              <span key={`t:${id}`} className="learning-chip learning-mono">
                task · {id}
              </span>
            ))}
            {candidate.evidence.ref ? (
              <span className="learning-chip learning-mono">{candidate.evidence.ref}</span>
            ) : null}
          </div>
        ) : candidate.evidence.digest ? null : (
          <div className="learning-sub">No evidence was recorded with this candidate.</div>
        )}
      </section>

      <section className="learning-panel">
        <h2>Diff</h2>
        {candidate.kind === 'skill' && current.content === null ? (
          <div className="learning-sub">
            New file — nothing is live at{' '}
            <span className="learning-mono">{candidate.destination}</span> yet.
          </div>
        ) : null}
        <DiffView
          before={current.content}
          after={candidate.content}
          core={candidate.kind === 'expression' ? (current.core ?? '') : null}
        />
      </section>

      {replay ? (
        <Scorecard report={replay} />
      ) : (
        <section className="learning-panel" data-testid="learning-no-scorecard">
          <h2>Replay scorecard</h2>
          <div className="learning-kv">
            <PillView pill={verdictPill(null)} />
          </div>
          <div className="learning-sub">
            Not replayed yet. A replay runs frozen past tasks once on what is live and once with
            this change, then compares them.
          </div>
        </section>
      )}

      <section className="learning-panel">
        <h2>Timeline</h2>
        {timeline.length === 0 ? (
          <div className="learning-sub">No audit lines for this candidate.</div>
        ) : (
          <div className="learning-tl" data-testid="learning-timeline">
            {timeline.map((entry, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: audit lines have no id; the log is append-only, so order is stable
                key={i}
                className="learning-tl-row"
              >
                <span className="learning-tl-t">{formatStamp(entry.at)}</span>
                <span>{timelineText(entry)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="learning-panel">
        {notice && (
          <div className="learning-notice" role="alert" data-testid="learning-notice">
            <span className="learning-notice-ic" aria-hidden="true">
              ✗
            </span>
            <span>
              <b>{notice.title}.</b> {notice.detail}
            </span>
          </div>
        )}
        {replayNote && <div className="learning-sub">{replayNote}</div>}

        {mode === 'approve' ? (
          <>
            <div className="learning-why">
              The verdict is <b>{verdictPill(candidate.verdict).word}</b>, so approving overrides
              the replay. Say why — it goes into the audit log. Required.
            </div>
            <textarea
              className="learning-textarea"
              aria-label="Reason to approve anyway"
              data-testid="learning-override-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <div className="learning-actions">
              <Button
                className="learning-btn-warn"
                disabled={busy || trimmed === ''}
                data-testid="learning-confirm-approve"
                onClick={() => trimmed !== '' && approveMut.mutate(trimmed)}
              >
                Approve anyway
              </Button>
              <Button onClick={() => open(null)}>Cancel</Button>
            </div>
          </>
        ) : mode === 'reject' || mode === 'rollback' ? (
          <>
            <textarea
              className="learning-textarea"
              aria-label={mode === 'reject' ? 'Rejection reason' : 'Rollback reason'}
              data-testid={
                mode === 'reject' ? 'learning-reject-reason' : 'learning-rollback-reason'
              }
              placeholder="Why (optional) — recorded on the timeline"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <div className="learning-actions">
              <Button
                danger
                disabled={busy}
                data-testid={
                  mode === 'reject' ? 'learning-confirm-reject' : 'learning-confirm-rollback'
                }
                onClick={() =>
                  mode === 'reject' ? rejectMut.mutate(trimmed) : rollbackMut.mutate(trimmed)
                }
              >
                {mode === 'reject' ? 'Reject' : 'Roll back'}
              </Button>
              <Button onClick={() => open(null)}>Cancel</Button>
            </div>
          </>
        ) : (
          <div className="learning-actions">
            {waiting &&
              (passed ? (
                <Button
                  type="primary"
                  disabled={busy}
                  data-testid="learning-approve"
                  onClick={() => approveMut.mutate(null)}
                >
                  Approve
                </Button>
              ) : (
                <Button
                  className="learning-btn-warn"
                  disabled={busy}
                  data-testid="learning-approve-anyway"
                  onClick={() => open('approve')}
                >
                  Approve anyway…
                </Button>
              ))}
            {rejectable && (
              <Button disabled={busy} data-testid="learning-reject" onClick={() => open('reject')}>
                Reject…
              </Button>
            )}
            {waiting && (
              <Button
                disabled={busy}
                loading={replayMut.isPending}
                data-testid="learning-replay"
                onClick={() => replayMut.mutate()}
              >
                {replayMut.isPending ? 'Replaying…' : 'Run replay'}
              </Button>
            )}
            {candidate.status === 'promoted' && (
              <>
                <Button
                  disabled={busy || !rollback.allowed}
                  data-testid="learning-rollback"
                  onClick={() => open('rollback')}
                >
                  Rollback
                </Button>
                {!rollback.allowed && (
                  <span className="learning-why" data-testid="learning-rollback-why">
                    Disabled —{' '}
                    {(rollback.code ? ROLLBACK_HEADLINES[rollback.code] : undefined) ??
                      'rollback is not available.'}{' '}
                    {rollback.reason ? (
                      <span className="learning-mono">{rollback.reason}</span>
                    ) : null}
                  </span>
                )}
              </>
            )}
          </div>
        )}

        {replayMut.isPending && (
          <div className="learning-why">
            A replay runs every case twice against the model and can take minutes.
          </div>
        )}
        {mode !== 'approve' && waiting && !passed && (
          <div className="learning-why">
            Not a passing replay. Approving it anyway needs a reason, and the reason goes into the
            audit log.
          </div>
        )}
        {replay && (
          <div className="learning-why">
            Replay measured this on <span className="learning-mono">{replay.testedOn}</span> only.
          </div>
        )}
      </section>
    </div>
  );
}

function LockGlyph() {
  return (
    <svg
      aria-hidden="true"
      width={12}
      height={12}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3.5 7.5h9v6.5h-9zM5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5" />
    </svg>
  );
}

function DiffView({
  before,
  after,
  core,
}: {
  before: string | null;
  after: string;
  /** Expression only: the Core, shown greyed and locked above the diff. */
  core: string | null;
}) {
  const lines = unifiedDiff(before, after);
  return (
    <div className="learning-diff" data-testid="learning-diff">
      {core !== null && (
        <>
          <div className="learning-locked" data-testid="learning-locked">
            <LockGlyph /> Core never changes here
          </div>
          {core.split('\n').map((text, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: Core lines have no id; order is fixed
              key={`core:${i}`}
              className="learning-diff-line learning-diff-core"
            >
              {`  ${text}`}
            </div>
          ))}
        </>
      )}
      {lines.map((line, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no id; order is fixed
          key={i}
          className={`learning-diff-line learning-diff-${line.kind}`}
          data-kind={line.kind}
        >
          {`${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '} ${line.text}`}
        </div>
      ))}
    </div>
  );
}

function Scorecard({ report }: { report: LearningReplayReportView }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (caseId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(caseId)) next.delete(caseId);
      else next.add(caseId);
      return next;
    });
  const target = deltaDirection(report.targetMeanDelta);

  return (
    <section className="learning-panel" data-testid="learning-scorecard">
      <h2>Replay scorecard</h2>
      <div className="learning-kv">
        <PillView pill={verdictPill(report.verdict, report)} testId="learning-scorecard-verdict" />
        <span className="learning-chip">
          target{' '}
          <span className={`learning-mono learning-delta learning-delta-${target}`}>
            {formatDelta(report.targetMeanDelta)}
          </span>
        </span>
        <span className="learning-chip">
          regressions {report.regressionsWorse}/{report.regressionCount}
        </span>
        <span className="learning-chip learning-mono">
          {formatUsd(report.costUsd)} of {formatUsd(report.maxCostUsd)}
        </span>
        <span className="learning-chip learning-mono">tested on {report.testedOn}</span>
      </div>

      {report.stopReason ? (
        <div className="learning-sub">
          {STOP_REASON_TEXT[report.stopReason]}
          {report.error ? ` — ${report.error}` : ''}
        </div>
      ) : null}

      {report.cases.length > 0 ? (
        <div className="learning-tablewrap">
          <table className="learning-table">
            <thead>
              <tr>
                <th>Case</th>
                <th>Source</th>
                <th className="learning-num">Baseline</th>
                <th className="learning-num">Candidate</th>
                <th className="learning-num">Δ</th>
              </tr>
            </thead>
            <tbody>
              {report.cases.map((c) => (
                <CaseRows
                  key={c.caseId}
                  replayCase={c}
                  open={expanded.has(c.caseId)}
                  onToggle={() => toggle(c.caseId)}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="learning-sub">No case ran in both arms.</div>
      )}

      {report.skipped.length > 0 ? (
        <div className="learning-sub">
          Skipped:{' '}
          {report.skipped.map((s) => (
            <span key={s.caseId}>
              <span className="learning-mono">{s.caseId}</span> ({s.reason}){' '}
            </span>
          ))}
        </div>
      ) : null}

      {/* Never fine print: the caveat sits with the numbers, on every scorecard. */}
      <div className="learning-caveat" data-testid="learning-caveat">
        <span className="learning-caveat-ic" aria-hidden="true">
          !
        </span>
        <span className="learning-caveat-lines">
          {scorecardCaveats(report).map((text) => {
            const { head, rest } = splitCaveat(text);
            return (
              <span key={text}>
                <b>{head}.</b> {rest}
              </span>
            );
          })}
        </span>
      </div>
    </section>
  );
}

function CaseRows({
  replayCase,
  open,
  onToggle,
}: {
  replayCase: LearningReplayCase;
  open: boolean;
  onToggle: () => void;
}) {
  const direction = deltaDirection(replayCase.delta);
  return (
    <>
      <tr data-testid="learning-case" data-case-id={replayCase.caseId}>
        <td>
          <button
            type="button"
            className="learning-case-toggle"
            aria-expanded={open}
            data-testid="learning-case-toggle"
            onClick={onToggle}
          >
            <span aria-hidden="true">{open ? '▾' : '▸'}</span>
            <span className="learning-case-prompt">{replayCase.prompt}</span>
          </button>
        </td>
        <td className="learning-sub">
          {replayCase.source} · {replayCase.role}
        </td>
        <td className="learning-num">{formatScore(replayCase.baseline?.score)}</td>
        <td className="learning-num">{formatScore(replayCase.candidate?.score)}</td>
        <td
          className={`learning-num learning-delta learning-delta-${direction}`}
          data-testid="learning-case-delta"
          data-direction={direction}
        >
          {formatDelta(replayCase.delta)}
        </td>
      </tr>
      {open && (
        <tr className="learning-case-detail">
          <td colSpan={5}>
            <div className="learning-sub learning-mono">{replayCase.sourceRef}</div>
            <div className="learning-arms">
              <ArmView label="Baseline" arm={replayCase.baseline} />
              <ArmView label="Candidate" arm={replayCase.candidate} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function ArmView({ label, arm }: { label: string; arm: LearningReplayArm | null }) {
  return (
    <div className="learning-arm" data-testid="learning-arm" data-arm={label.toLowerCase()}>
      <div className="learning-group-label">
        {label} <span className="learning-group-count">{formatScore(arm?.score)}</span>
      </div>
      {arm === null ? (
        <div className="learning-sub">This arm did not run.</div>
      ) : (
        <>
          <pre className="learning-arm-text" data-testid="learning-arm-text">
            {arm.text || '(no text)'}
          </pre>
          <div className="learning-kv">
            {arm.plan.length === 0 ? (
              <span className="learning-sub">No tool calls planned</span>
            ) : (
              arm.plan.map((step) => (
                <span
                  key={step.toolCallId}
                  className="learning-chip learning-mono"
                  data-testid="learning-plan-chip"
                >
                  {step.toolName}
                </span>
              ))
            )}
          </div>
          {arm.errors.map((e) => (
            <div key={`${e.code}:${e.error}`} className="learning-assert learning-assert-fail">
              <span className="learning-assert-ic" aria-hidden="true">
                ✗
              </span>
              error <span className="learning-mono">{e.code}</span> — {e.error}
            </div>
          ))}
          {arm.halts.map((h) => (
            <div key={`${h.kind}:${h.rule}`} className="learning-assert learning-assert-fail">
              <span className="learning-assert-ic" aria-hidden="true">
                ✗
              </span>
              halted ({h.kind}) — {h.message}
            </div>
          ))}
          <div className="learning-asserts">
            {arm.assertions.map((a, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: assertions have no id; order is the case's own
                key={i}
                className={`learning-assert ${a.passed ? 'learning-assert-pass' : 'learning-assert-fail'}`}
                data-testid="learning-assertion"
                data-passed={a.passed ? 'true' : 'false'}
              >
                <span className="learning-assert-ic" aria-hidden="true">
                  {a.passed ? '✓' : '✗'}
                </span>
                <span className="learning-assert-word">{a.passed ? 'pass' : 'fail'}</span>
                <span className="learning-mono">{a.kind}</span>
                <span>{a.value}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

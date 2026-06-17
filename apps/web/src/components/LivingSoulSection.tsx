import { ContentRenderer } from '@ethosagent/ui-components';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Modal, Spin, Typography } from 'antd';
import { useState } from 'react';
import { rpc } from '../rpc';

// ---------------------------------------------------------------------------
// Living Soul — user-mode Expression evolution (Phase 3a, component C)
//
// Core is immutable identity (never edited here). Expression is the voice
// region the agent revises from session evidence. The Learning Log records
// each applied revision. This section lets the user inspect the split,
// propose an LLM-drafted Expression update, review evidence + rationale +
// a before/after diff, and apply or revert.
// ---------------------------------------------------------------------------

/** Narrow read of an oRPC/EthosError `code` field without casting a typed value. */
function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const c: unknown = Reflect.get(err, 'code');
    return typeof c === 'string' ? c : undefined;
  }
  return undefined;
}

function formatAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const MONO = 'Geist Mono, monospace';

const LABEL_STYLE = {
  display: 'block',
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  marginBottom: 8,
} as const;

type Judge = {
  alignmentScore: number;
  signal: 'drift' | 'underspecified_soul' | null;
  lowStreak: number;
  at?: string;
  perDimension?: Array<{ dimension: string; score: number }>;
};

function signalGloss(signal: NonNullable<Judge['signal']>): string {
  return signal === 'underspecified_soul'
    ? 'underspecified soul — the Core/Expression may be too thin to align against'
    : 'drift — recent responses are pulling away from Core';
}

function AlignmentBlock({ judge }: { judge?: Judge }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <Typography.Text type="secondary" style={LABEL_STYLE}>
        Alignment
      </Typography.Text>
      {!judge ? (
        <Typography.Text type="secondary">No alignment checks yet.</Typography.Text>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            <Typography.Text style={{ fontFamily: MONO, fontSize: 13 }}>
              Alignment {judge.alignmentScore.toFixed(2)}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontFamily: MONO, fontSize: 12 }}>
              low-streak {judge.lowStreak}
            </Typography.Text>
            {judge.at ? (
              <Typography.Text type="secondary" style={{ fontFamily: MONO, fontSize: 11 }}>
                {formatAt(judge.at)}
              </Typography.Text>
            ) : null}
          </div>
          {judge.signal ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Signal: {signalGloss(judge.signal)}
            </Typography.Text>
          ) : null}
          {judge.perDimension && judge.perDimension.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {judge.perDimension.map((d) => (
                <Typography.Text
                  key={d.dimension}
                  type="secondary"
                  style={{ fontFamily: MONO, fontSize: 12 }}
                >
                  {d.dimension} {d.score.toFixed(2)}
                </Typography.Text>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

type Nightly = {
  windowEnd: string;
  completed: string[];
};

function NightlyLine({ nightly }: { nightly?: Nightly }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <Typography.Text type="secondary" style={LABEL_STYLE}>
        Nightly pass
      </Typography.Text>
      {!nightly ? (
        <Typography.Text type="secondary">No nightly pass has run yet.</Typography.Text>
      ) : (
        <Typography.Text type="secondary" style={{ fontFamily: MONO, fontSize: 12 }}>
          Last nightly pass: {nightly.windowEnd} · steps:{' '}
          {nightly.completed.length > 0 ? nightly.completed.join(', ') : 'none'}
        </Typography.Text>
      )}
    </div>
  );
}

type Proposal = {
  currentExpression: string;
  newExpression: string;
  rationale: string;
  evidence: string;
};

function ExpressionPanel({ label, text }: { label: string; text: string }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <Typography.Text
        type="secondary"
        style={{
          display: 'block',
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          marginBottom: 8,
        }}
      >
        {label}
      </Typography.Text>
      <div
        style={{
          border: '1px solid var(--border-subtle, #2A2A2A)',
          borderRadius: 'var(--radius-md)',
          padding: '8px 12px',
          maxHeight: 320,
          overflowY: 'auto',
          fontFamily: MONO,
          fontSize: 12,
          lineHeight: 1.45,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {text.trim() ? text : <Typography.Text type="secondary">(empty)</Typography.Text>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pending skill candidates — the manual-mode review queue. The nightly
// skill-evolver drafts candidates and leaves them in `.pending/`; here a
// human promotes (approve) or discards (reject) each one.
// ---------------------------------------------------------------------------

function SkillCandidatesSection({ personalityId }: { personalityId: string }) {
  const qc = useQueryClient();
  const { notification, modal } = AntApp.useApp();

  const { data, isLoading } = useQuery({
    queryKey: ['personalities', 'skillCandidates', personalityId],
    queryFn: () => rpc.personalities.skillCandidatesList({ personalityId }),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['personalities', 'skillCandidates', personalityId] });
    qc.invalidateQueries({ queryKey: ['personalities', 'skills', personalityId] });
    qc.invalidateQueries({ queryKey: ['personalities', 'livingSoul', personalityId] });
  };

  const approveMut = useMutation({
    mutationFn: (fileName: string) =>
      rpc.personalities.skillCandidateApprove({ personalityId, fileName }),
    onSuccess: () => {
      invalidate();
      notification.success({ message: 'Skill promoted to live', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({
        message: 'Approve failed',
        description: err instanceof Error ? err.message : String(err),
      }),
  });

  const rejectMut = useMutation({
    mutationFn: (fileName: string) =>
      rpc.personalities.skillCandidateReject({ personalityId, fileName }),
    onSuccess: () => {
      invalidate();
      notification.success({ message: 'Candidate rejected', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({
        message: 'Reject failed',
        description: err instanceof Error ? err.message : String(err),
      }),
  });

  const confirmApprove = (fileName: string) => {
    modal.confirm({
      title: 'Promote this skill to live?',
      content: `"${fileName}" becomes an active skill for this personality.`,
      okText: 'Promote',
      cancelText: 'Cancel',
      onOk: () => approveMut.mutateAsync(fileName),
    });
  };

  const confirmReject = (fileName: string) => {
    modal.confirm({
      title: 'Reject this skill candidate?',
      content: `"${fileName}" is deleted and will not be promoted.`,
      okText: 'Reject',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: () => rejectMut.mutateAsync(fileName),
    });
  };

  return (
    <div style={{ marginTop: 32 }}>
      <Typography.Text type="secondary" style={LABEL_STYLE}>
        Pending skill candidates
      </Typography.Text>
      {isLoading ? (
        <div style={{ display: 'grid', placeItems: 'center', height: 64 }}>
          <Spin />
        </div>
      ) : !data || data.candidates.length === 0 ? (
        <Typography.Text type="secondary">No skill candidates awaiting review.</Typography.Text>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {data.candidates.map((c) => (
            <div
              key={c.fileName}
              style={{
                border: '1px solid var(--border-subtle, #2A2A2A)',
                borderRadius: 'var(--radius-md)',
                padding: '12px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 12,
                  marginBottom: 8,
                }}
              >
                <Typography.Text style={{ fontFamily: MONO, fontSize: 12 }}>
                  {c.fileName}
                </Typography.Text>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button
                    type="primary"
                    size="small"
                    loading={approveMut.isPending}
                    onClick={() => confirmApprove(c.fileName)}
                  >
                    Approve
                  </Button>
                  <Button
                    type="text"
                    size="small"
                    danger
                    loading={rejectMut.isPending}
                    onClick={() => confirmReject(c.fileName)}
                  >
                    Reject
                  </Button>
                </div>
              </div>
              <div
                style={{
                  maxHeight: 240,
                  overflowY: 'auto',
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                <ContentRenderer content={c.content} format="markdown" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function LivingSoulSection({ personalityId }: { personalityId: string }) {
  const qc = useQueryClient();
  const { notification, modal } = AntApp.useApp();
  const [proposal, setProposal] = useState<Proposal | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['personalities', 'livingSoul', personalityId],
    queryFn: () => rpc.personalities.livingSoul({ id: personalityId }),
  });

  const proposeMut = useMutation({
    mutationFn: () => rpc.personalities.proposeExpression({ id: personalityId }),
    onSuccess: (result) => setProposal(result),
    onError: (err) => {
      if (errorCode(err) === 'NOT_CONFIGURED') {
        notification.warning({
          message: 'Voice updates need an LLM configured on the server',
          description: 'Start the server with a provider configured in ~/.ethos/config.yaml.',
          placement: 'topRight',
        });
        return;
      }
      notification.error({
        message: 'Could not draft a voice update',
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const applyMut = useMutation({
    mutationFn: (p: Proposal) =>
      rpc.personalities.applyExpression({
        id: personalityId,
        newExpression: p.newExpression,
        summary: p.rationale.slice(0, 120) || 'expression update',
        evidenceRef: `web:${new Date().toISOString()}`,
      }),
    onSuccess: () => {
      setProposal(null);
      qc.invalidateQueries({ queryKey: ['personalities', 'livingSoul', personalityId] });
      qc.invalidateQueries({ queryKey: ['personalities', 'characterSheet', personalityId] });
      notification.success({ message: 'Voice updated', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({
        message: 'Apply failed',
        description: err instanceof Error ? err.message : String(err),
      }),
  });

  const revertMut = useMutation({
    mutationFn: () => rpc.personalities.revertExpression({ id: personalityId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'livingSoul', personalityId] });
      qc.invalidateQueries({ queryKey: ['personalities', 'characterSheet', personalityId] });
      notification.success({ message: 'Reverted last change', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({
        message: 'Revert failed',
        description: err instanceof Error ? err.message : String(err),
      }),
  });

  const confirmRevert = () => {
    modal.confirm({
      title: 'Revert last voice change?',
      content: 'This restores the Expression to the state before the most recent revision.',
      okText: 'Revert',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: () => revertMut.mutateAsync(),
    });
  };

  if (isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 120 }}>
        <Spin />
      </div>
    );
  }
  if (!data) return null;

  const { expression, learningLog, judge, nightly } = data;

  return (
    <div style={{ marginBottom: 32 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
        }}
      >
        <Typography.Title level={5} style={{ margin: 0 }}>
          Living Soul
        </Typography.Title>
        <div style={{ display: 'flex', gap: 8 }}>
          {learningLog.length > 0 ? (
            <Button onClick={confirmRevert} loading={revertMut.isPending}>
              Revert last change
            </Button>
          ) : null}
          <Button type="primary" loading={proposeMut.isPending} onClick={() => proposeMut.mutate()}>
            Propose voice update
          </Button>
        </div>
      </div>

      <Typography.Text
        type="secondary"
        style={{ display: 'block', fontSize: 12, marginBottom: 16 }}
      >
        Core is immutable identity — it is never edited from this flow. Expression is the voice the
        agent revises from session evidence.
      </Typography.Text>

      <AlignmentBlock judge={judge} />

      <NightlyLine nightly={nightly} />

      <div style={{ marginBottom: 20 }}>
        <Typography.Text type="secondary" style={LABEL_STYLE}>
          Current Expression
        </Typography.Text>
        {expression.trim() ? (
          <div
            style={{
              border: '1px solid var(--border-subtle, #2A2A2A)',
              borderRadius: 'var(--radius-md)',
              padding: '8px 12px',
              maxHeight: 280,
              overflowY: 'auto',
              fontFamily: MONO,
              fontSize: 12,
              lineHeight: 1.45,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {expression}
          </div>
        ) : (
          <Typography.Text type="secondary">
            No Expression region yet — propose one below.
          </Typography.Text>
        )}
      </div>

      <div>
        <Typography.Text
          type="secondary"
          style={{
            display: 'block',
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            marginBottom: 8,
          }}
        >
          Learning Log
        </Typography.Text>
        {learningLog.length === 0 ? (
          <Typography.Text type="secondary">No revisions yet.</Typography.Text>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {learningLog.map((entry) => (
              <div
                key={entry.revisionId}
                style={{
                  borderBottom: '1px solid var(--border-subtle, #2A2A2A)',
                  paddingBottom: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
                  <Typography.Text style={{ fontFamily: MONO, fontSize: 11 }} type="secondary">
                    {formatAt(entry.at)}
                  </Typography.Text>
                  <Typography.Text style={{ fontFamily: MONO, fontSize: 11 }} type="secondary">
                    {entry.revisionId}
                  </Typography.Text>
                </div>
                <Typography.Text style={{ fontSize: 13 }}>{entry.summary}</Typography.Text>
              </div>
            ))}
          </div>
        )}
      </div>

      <SkillCandidatesSection personalityId={personalityId} />

      <Modal
        open={proposal !== null}
        title="Review voice update"
        width={720}
        onCancel={() => setProposal(null)}
        footer={[
          <Button key="cancel" type="text" onClick={() => setProposal(null)}>
            Cancel
          </Button>,
          <Button
            key="apply"
            type="primary"
            loading={applyMut.isPending}
            onClick={() => proposal && applyMut.mutate(proposal)}
          >
            Apply update
          </Button>,
        ]}
      >
        {proposal ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div>
              <Typography.Text
                type="secondary"
                style={{
                  display: 'block',
                  fontSize: 11,
                  fontWeight: 500,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  marginBottom: 8,
                }}
              >
                Evidence
              </Typography.Text>
              <div
                style={{
                  border: '1px solid var(--border-subtle, #2A2A2A)',
                  borderRadius: 'var(--radius-md)',
                  padding: '8px 12px',
                  maxHeight: 200,
                  overflowY: 'auto',
                  fontFamily: MONO,
                  fontSize: 12,
                  lineHeight: 1.45,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {proposal.evidence.trim() ? (
                  proposal.evidence
                ) : (
                  <Typography.Text type="secondary">
                    No recent-session evidence found.
                  </Typography.Text>
                )}
              </div>
            </div>

            <div>
              <Typography.Text
                type="secondary"
                style={{
                  display: 'block',
                  fontSize: 11,
                  fontWeight: 500,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  marginBottom: 8,
                }}
              >
                Rationale
              </Typography.Text>
              <Typography.Paragraph style={{ marginBottom: 0 }}>
                {proposal.rationale.trim() || '(none given)'}
              </Typography.Paragraph>
            </div>

            <div style={{ display: 'flex', gap: 16 }}>
              <ExpressionPanel label="Before" text={proposal.currentExpression} />
              <ExpressionPanel label="After" text={proposal.newExpression} />
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

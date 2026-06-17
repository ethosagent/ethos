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

  const { expression, learningLog } = data;

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

      <div style={{ marginBottom: 20 }}>
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

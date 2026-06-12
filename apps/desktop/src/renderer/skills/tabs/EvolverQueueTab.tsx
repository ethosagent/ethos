import { createEthosClient } from '@ethosagent/sdk';
import { useEffect, useMemo, useState } from 'react';
import { useServerUrl } from '../../shell/ServerUrl';
import { SectionLabel } from '../../ui/SectionLabel';
import { EvolverConfigDrawer } from '../components/EvolverConfigDrawer';
import { EvolverHistoryRow } from '../components/EvolverHistoryRow';
import { PendingSkillRow } from '../components/PendingSkillRow';

interface PendingCandidate {
  id: string;
  name: string;
  proposedAt: string;
  body: string;
  description: string | null;
}

interface HistoryRun {
  ranAt: string;
  evalOutputPath: string;
  rewritesProposed: number;
  newSkillsProposed: number;
  skipped: { kind: string; target: string; reason: string }[];
}

interface EvolverQueueTabProps {
  onPendingCountChange: (count: number) => void;
}

export function EvolverQueueTab({ onPendingCountChange }: EvolverQueueTabProps) {
  const [pending, setPending] = useState<PendingCandidate[]>([]);
  const [history, setHistory] = useState<HistoryRun[]>([]);
  const [configDrawerOpen, setConfigDrawerOpen] = useState(false);

  const baseUrl = useServerUrl();
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  useEffect(() => {
    let cancelled = false;

    client.rpc.evolver
      .pendingList({})
      .then((res) => {
        if (!cancelled) {
          setPending(res.pending);
          onPendingCountChange(res.pending.length);
        }
      })
      .catch(() => {});

    client.rpc.evolver
      .history({ limit: 20 })
      .then((res) => {
        if (!cancelled) {
          setHistory(res.runs);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [client, onPendingCountChange]);

  const handleApprove = async (id: string) => {
    try {
      await client.rpc.evolver.pendingApprove({ id });
    } catch {
      // best-effort
    }
    const next = pending.filter((c) => c.id !== id);
    setPending(next);
    onPendingCountChange(next.length);
  };

  const handleReject = async (id: string) => {
    try {
      await client.rpc.evolver.pendingReject({ id });
    } catch {
      // best-effort
    }
    const next = pending.filter((c) => c.id !== id);
    setPending(next);
    onPendingCountChange(next.length);
  };

  return (
    <div>
      <div>
        <SectionLabel>Pending review</SectionLabel>
        <div style={{ marginTop: 8 }}>
          {pending.length === 0 ? (
            <div style={{ fontSize: 14, color: 'var(--text-tertiary)' }}>
              No skills awaiting review.
            </div>
          ) : (
            pending.map((candidate) => (
              <PendingSkillRow
                key={candidate.id}
                candidate={candidate}
                onApprove={handleApprove}
                onReject={handleReject}
              />
            ))
          )}
        </div>
      </div>

      <div style={{ marginTop: 24 }}>
        <SectionLabel>Run history</SectionLabel>
        <div>
          {history.length === 0 ? (
            <div style={{ fontSize: 14, color: 'var(--text-tertiary)', marginTop: 8 }}>
              No evolver runs yet.
            </div>
          ) : (
            history.map((run, i) => <EvolverHistoryRow key={run.ranAt ?? i} entry={run} />)
          )}
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <button
          type="button"
          onClick={() => setConfigDrawerOpen(true)}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 12,
            color: 'var(--text-secondary)',
            padding: 0,
          }}
        >
          Configure thresholds →
        </button>
      </div>

      <EvolverConfigDrawer open={configDrawerOpen} onClose={() => setConfigDrawerOpen(false)} />
    </div>
  );
}

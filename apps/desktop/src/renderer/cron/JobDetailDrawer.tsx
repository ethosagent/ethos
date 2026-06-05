import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Chip } from '../ui/Chip';
import { JobHistoryTab } from './tabs/JobHistoryTab';
import { JobInfoTab } from './tabs/JobInfoTab';
import { JobOutputTab } from './tabs/JobOutputTab';

interface CronJob {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  personalityId: string;
  deliver: string | null;
  status: 'active' | 'paused' | 'done';
  missedRunPolicy: 'run-once' | 'skip';
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

interface JobDetailDrawerProps {
  jobId: string;
  port: number;
  onClose: () => void;
  onJobChanged: () => void;
}

type TabId = 'info' | 'history' | 'output';

const statusChip: Record<
  CronJob['status'],
  { label: string; variant: 'success' | 'warning' | 'neutral' | 'error' }
> = {
  active: { label: 'Active', variant: 'success' },
  paused: { label: 'Paused', variant: 'warning' },
  done: { label: 'Done', variant: 'neutral' },
};

export function JobDetailDrawer({ jobId, port, onClose, onJobChanged }: JobDetailDrawerProps) {
  const [job, setJob] = useState<CronJob | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('info');
  const [selectedRun, setSelectedRun] = useState<{
    ranAt: string;
    output: string | null;
    outputPath: string;
  } | null>(null);

  const client = useMemo(
    () => createEthosClient({ baseUrl: `http://localhost:${port}`, fetch: globalThis.fetch }),
    [port],
  );

  const loadJob = useCallback(async () => {
    try {
      const res = await client.rpc.cron.get({ id: jobId });
      setJob(res.job);
    } catch {
      // best-effort
    }
  }, [client, jobId]);

  useEffect(() => {
    loadJob();
  }, [loadJob]);

  const handlePauseResume = async () => {
    if (!job) return;
    try {
      if (job.status === 'paused') {
        await client.rpc.cron.resume({ id: jobId });
      } else {
        await client.rpc.cron.pause({ id: jobId });
      }
      await loadJob();
      onJobChanged();
    } catch {
      // best-effort
    }
  };

  const handleDelete = async () => {
    const confirmed = await window.ethos.dialog.showMessage({
      type: 'warning',
      message: `Delete "${job?.name ?? 'this job'}"? This action cannot be undone.`,
      buttons: ['Cancel', 'Delete'],
    });
    if (confirmed.response !== 1) return;
    try {
      await client.rpc.cron.delete({ id: jobId });
      onJobChanged();
      onClose();
    } catch {
      // best-effort
    }
  };

  const handleViewOutput = (run: { ranAt: string; output: string | null; outputPath: string }) => {
    setSelectedRun(run);
    setActiveTab('output');
  };

  const handleJobSaved = () => {
    loadJob();
    onJobChanged();
  };

  if (!job) {
    return (
      <div style={drawerStyle}>
        <div style={{ padding: 16, color: 'var(--text-tertiary)', fontSize: 13 }}>Loading...</div>
      </div>
    );
  }

  const chip = statusChip[job.status];
  const tabs: { id: TabId; label: string }[] = [
    { id: 'info', label: 'Info' },
    { id: 'history', label: 'History' },
    { id: 'output', label: 'Output' },
  ];

  return (
    <div style={drawerStyle}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 40,
          padding: '0 16px',
          borderBottom: '1px solid var(--border-subtle)',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
          {job.name}
        </span>
        <span style={{ marginLeft: 8 }}>
          <Chip label={chip.label} variant={chip.variant} />
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 16,
            color: 'var(--text-secondary)',
            padding: 0,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>

      {/* Tab bar */}
      <div
        style={{
          display: 'flex',
          borderBottom: '1px solid var(--border-subtle)',
          padding: '0 16px',
          flexShrink: 0,
        }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            style={{
              background: 'none',
              border: 'none',
              borderBottom:
                activeTab === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
              cursor: 'pointer',
              padding: '8px 12px',
              fontSize: 13,
              color: activeTab === tab.id ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontWeight: activeTab === tab.id ? 500 : 400,
              transition: `color var(--motion-fast) var(--ease)`,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {activeTab === 'info' && <JobInfoTab job={job} port={port} onSaved={handleJobSaved} />}
        {activeTab === 'history' && (
          <JobHistoryTab jobId={jobId} port={port} onViewOutput={handleViewOutput} />
        )}
        {activeTab === 'output' && selectedRun && selectedRun.output !== null && (
          <JobOutputTab jobName={job.name} ranAt={selectedRun.ranAt} output={selectedRun.output} />
        )}
        {activeTab === 'output' && (!selectedRun || selectedRun.output === null) && (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 13, paddingTop: 20 }}>
            Select a run from the History tab to view its output.
          </div>
        )}
      </div>

      {/* Footer */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: 40,
          padding: '0 16px',
          borderTop: '1px solid var(--border-subtle)',
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={handleDelete}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 14,
            color: 'var(--error)',
            padding: 0,
          }}
        >
          Delete job
        </button>
        <button
          type="button"
          onClick={handlePauseResume}
          style={{
            background: 'none',
            border: '1px solid var(--border-subtle)',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 13,
            color: 'var(--text-secondary)',
            padding: '4px 12px',
          }}
        >
          {job.status === 'paused' ? 'Resume' : 'Pause'}
        </button>
      </div>
    </div>
  );
}

const drawerStyle: React.CSSProperties = {
  width: 360,
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  borderLeft: '1px solid var(--border-subtle)',
  backgroundColor: 'var(--bg-base)',
  flexShrink: 0,
};

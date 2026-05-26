import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppState } from '../state/AppContext';
import { CreateJobForm } from './CreateJobForm';
import { CronJobCard } from './CronJobCard';
import { JobDetailDrawer } from './JobDetailDrawer';

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

export function CronPage() {
  const { state } = useAppState();
  const { port } = state;

  const client = useMemo(
    () => createEthosClient({ baseUrl: `http://localhost:${port}`, fetch: globalThis.fetch }),
    [port],
  );

  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [createFormOpen, setCreateFormOpen] = useState(true);
  const [runningJobId, setRunningJobId] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    try {
      const res = await client.rpc.cron.list({});
      setJobs(res.jobs);
    } catch {
      // best-effort
    }
  }, [client]);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  const handleSelectJob = useCallback((id: string) => {
    setSelectedJobId(id);
    setCreateFormOpen(false);
  }, []);

  const handleToggleCreateForm = useCallback(() => {
    setCreateFormOpen((prev) => {
      if (!prev) setSelectedJobId(null);
      return !prev;
    });
  }, []);

  const handleCreated = useCallback(() => {
    loadJobs();
    setCreateFormOpen(false);
  }, [loadJobs]);

  const handleRunNow = useCallback(
    async (id: string) => {
      setRunningJobId(id);
      try {
        await client.rpc.cron.runNow({ id });
        await loadJobs();
      } catch {
        // best-effort
      } finally {
        setRunningJobId(null);
      }
    },
    [client, loadJobs],
  );

  const handlePause = useCallback(
    async (id: string) => {
      try {
        await client.rpc.cron.pause({ id });
        await loadJobs();
      } catch {
        // best-effort
      }
    },
    [client, loadJobs],
  );

  const handleResume = useCallback(
    async (id: string) => {
      try {
        await client.rpc.cron.resume({ id });
        await loadJobs();
      } catch {
        // best-effort
      }
    },
    [client, loadJobs],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await client.rpc.cron.delete({ id });
        if (selectedJobId === id) setSelectedJobId(null);
        await loadJobs();
      } catch {
        // best-effort
      }
    },
    [client, loadJobs, selectedJobId],
  );

  const handleEdit = useCallback((id: string) => {
    setSelectedJobId(id);
    setCreateFormOpen(false);
  }, []);

  const handleJobChanged = useCallback(() => {
    loadJobs();
  }, [loadJobs]);

  const handleCloseDrawer = useCallback(() => {
    setSelectedJobId(null);
  }, []);

  const platformStatus = { telegram: false, slack: false, discord: false };

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      {/* Main column */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Page header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            height: 40,
            padding: '0 16px',
            flexShrink: 0,
          }}
        >
          <h3
            style={{
              margin: 0,
              fontSize: 20,
              fontWeight: 600,
              color: 'var(--text-primary)',
            }}
          >
            Cron Jobs
          </h3>
          <button
            type="button"
            onClick={() => {
              setSelectedJobId(null);
              setCreateFormOpen(true);
            }}
            style={{
              height: 28,
              padding: '0 12px',
              background: 'none',
              border: '1px solid var(--border-subtle)',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 13,
              color: 'var(--text-secondary)',
            }}
          >
            New job
          </button>
        </div>

        {/* Job list */}
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            padding: '0 16px',
          }}
        >
          {jobs.length === 0 && (
            <div
              style={{
                marginTop: 40,
                fontSize: 14,
                color: 'var(--text-tertiary)',
              }}
            >
              No scheduled jobs. Create one below.
            </div>
          )}
          {jobs.map((job) => (
            <CronJobCard
              key={job.id}
              job={job}
              onSelect={handleSelectJob}
              onRunNow={handleRunNow}
              onPause={handlePause}
              onResume={handleResume}
              onDelete={handleDelete}
              onEdit={handleEdit}
              runningJobId={runningJobId}
            />
          ))}
        </div>

        {/* Create form */}
        <CreateJobForm
          port={port}
          open={createFormOpen}
          onToggle={handleToggleCreateForm}
          onCreated={handleCreated}
          platformStatus={platformStatus}
        />
      </div>

      {/* Detail drawer */}
      {selectedJobId && (
        <JobDetailDrawer
          jobId={selectedJobId}
          port={port}
          onClose={handleCloseDrawer}
          onJobChanged={handleJobChanged}
        />
      )}
    </div>
  );
}

import type { CronJob } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Form, Input, Modal, Select, Spin, Typography } from 'antd';
import { useState } from 'react';
import { MonoBadge } from '../components/ui/MonoBadge';
import { rpc } from '../rpc';

// Cron tab — proactive pillar of v0.5. Lists scheduled jobs as vertical
// cards, lets the user create / pause / resume / delete / run-now, and
// shows the head of recent run history inline when expanded.
//
// Server-side: serve.ts owns the actual scheduler tick loop. This UI
// just calls into rpc.cron.* and lets the backend do the work.

const PRESET_SCHEDULES: Array<{ value: string; label: string }> = [
  { value: '*/5 * * * *', label: 'Every 5 minutes' },
  { value: '0 * * * *', label: 'Hourly' },
  { value: '0 9 * * *', label: 'Daily at 9am' },
  { value: '0 9 * * 1-5', label: 'Weekdays at 9am' },
  { value: '0 8 * * 1', label: 'Mondays at 8am' },
];

export function Cron() {
  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['cron', 'list'],
    queryFn: () => rpc.cron.list(),
  });

  if (isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }

  if (error) {
    return (
      <Typography.Text type="danger">
        Failed to load cron jobs: {(error as Error).message}
      </Typography.Text>
    );
  }

  const jobs = data?.jobs ?? [];
  const activeCount = jobs.filter((j) => j.status === 'active').length;

  return (
    <div className="cron-tab">
      <header className="cron-header">
        <div className="cron-header-left">
          <span className="cron-title">Cron</span>
          <span className="cron-subtitle">
            {jobs.length} {jobs.length === 1 ? 'job' : 'jobs'} &middot; {activeCount} active
          </span>
        </div>
        <button type="button" className="cron-new-btn" onClick={() => setCreateOpen(true)}>
          + New job
        </button>
      </header>

      <div className="cron-card-list">
        {jobs.length === 0 && (
          <div className="cron-empty">
            No cron jobs yet. Create one to schedule a recurring agent task.
          </div>
        )}
        {jobs.map((job) => (
          <CronJobCard key={job.id} job={job} />
        ))}
      </div>

      {createOpen ? <CreateJobModal open onClose={() => setCreateOpen(false)} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Job card
// ---------------------------------------------------------------------------

function CronJobCard({ job }: { job: CronJob }) {
  const [expanded, setExpanded] = useState(false);
  const queryClient = useQueryClient();
  const { notification } = AntApp.useApp();
  const isPaused = job.status === 'paused';

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['cron', 'list'] });
  };

  const runNow = useMutation({
    mutationFn: () => rpc.cron.runNow({ id: job.id }),
    onSuccess: (result) => {
      invalidate();
      notification.success({
        message: `${job.name} ran`,
        description: result.output.slice(0, 200) || '(no output)',
        placement: 'topRight',
      });
    },
    onError: (err) => surfaceError(notification, 'Run failed', err),
  });

  const pause = useMutation({
    mutationFn: () => rpc.cron.pause({ id: job.id }),
    onSuccess: invalidate,
    onError: (err) => surfaceError(notification, 'Pause failed', err),
  });

  const resume = useMutation({
    mutationFn: () => rpc.cron.resume({ id: job.id }),
    onSuccess: invalidate,
    onError: (err) => surfaceError(notification, 'Resume failed', err),
  });

  const remove = useMutation({
    mutationFn: () => rpc.cron.delete({ id: job.id }),
    onSuccess: invalidate,
    onError: (err) => surfaceError(notification, 'Delete failed', err),
  });

  return (
    <div className={`cron-card${isPaused ? ' cron-card--paused' : ''}`}>
      {/* Top row: name + badge + "Run now" */}
      <div className="cron-card-top">
        <span className="cron-card-name">{job.name}</span>
        <MonoBadge label={isPaused ? 'Paused' : 'Active'} variant={isPaused ? 'amber' : 'green'} />
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="cron-run-now-btn"
          disabled={runNow.isPending}
          onClick={(e) => {
            e.stopPropagation();
            if (!runNow.isPending) runNow.mutate();
          }}
        >
          {runNow.isPending ? 'Running...' : 'Run now'}
        </button>
      </div>

      {/* Meta row: cron expression + personality + next run */}
      <div className="cron-card-meta">
        <span className="cron-card-cron">{job.schedule}</span>
        <span className="cron-card-personality">{job.personalityId}</span>
        <span className="cron-card-next">
          {isPaused ? 'Paused' : `Next: ${job.nextRunAt ? formatNextRun(job.nextRunAt) : 'never'}`}
        </span>
      </div>

      {/* Description row (prompt preview) */}
      {job.prompt ? <div className="cron-card-desc">{job.prompt}</div> : null}

      {/* Hover-reveal action row */}
      <div className="cron-card-actions">
        <button
          type="button"
          className="cron-action-btn"
          title={isPaused ? 'Resume' : 'Pause'}
          onClick={(e) => {
            e.stopPropagation();
            if (isPaused) resume.mutate();
            else pause.mutate();
          }}
        >
          {isPaused ? '▶' : '⏸'}
        </button>
        <button
          type="button"
          className="cron-action-btn"
          title="Edit"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((prev) => !prev);
          }}
        >
          &#x270E;
        </button>
        <button
          type="button"
          className="cron-action-btn cron-action-btn--delete"
          title="Delete"
          onClick={(e) => {
            e.stopPropagation();
            remove.mutate();
          }}
        >
          &#x1F5D1;
        </button>
      </div>

      {/* Expandable last run output */}
      {expanded ? <RunHistory jobId={job.id} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create job modal
// ---------------------------------------------------------------------------

interface CreateForm {
  name: string;
  schedule: string;
  prompt: string;
  personalityId: string;
}

function CreateJobModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form] = Form.useForm<CreateForm>();
  const queryClient = useQueryClient();
  const { notification } = AntApp.useApp();

  const personalities = useQuery({
    queryKey: ['personalities'],
    queryFn: () => rpc.personalities.list({}),
  });

  const create = useMutation({
    mutationFn: (input: CreateForm) =>
      rpc.cron.create({
        name: input.name,
        schedule: input.schedule,
        prompt: input.prompt,
        personalityId: input.personalityId,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['cron', 'list'] });
      form.resetFields();
      onClose();
    },
    onError: (err) => surfaceError(notification, 'Could not create job', err),
  });

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText="Create"
      okButtonProps={{ loading: create.isPending }}
      title="New cron job"
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        onFinish={(values) => create.mutate(values)}
      >
        <Form.Item
          label="Name"
          name="name"
          rules={[{ required: true, message: 'A short name to identify the job' }]}
        >
          <Input placeholder="daily-news" autoFocus />
        </Form.Item>

        <Form.Item
          label="Schedule"
          name="schedule"
          rules={[{ required: true, message: 'A 5-field cron expression' }]}
          extra="Standard 5-field cron (minute hour day-of-month month day-of-week)."
        >
          <Select
            showSearch
            allowClear
            placeholder="0 9 * * 1-5  or pick a preset"
            options={PRESET_SCHEDULES.map((p) => ({
              value: p.value,
              label: `${p.label}  ·  ${p.value}`,
            }))}
            mode="tags"
            maxTagCount={1}
            onChange={(values: string[]) => {
              const last = values[values.length - 1];
              form.setFieldsValue({ schedule: last ?? '' });
            }}
          />
        </Form.Item>

        <Form.Item
          label="Prompt"
          name="prompt"
          rules={[{ required: true, message: 'What should the agent do?' }]}
        >
          <Input.TextArea
            rows={4}
            placeholder="Summarize the latest issues from openclaw and email me the top 5."
          />
        </Form.Item>

        <Form.Item
          label="Personality"
          name="personalityId"
          rules={[{ required: true, message: 'A personality is required' }]}
        >
          <Select
            allowClear
            placeholder="Select personality"
            loading={personalities.isLoading}
            options={(personalities.data?.items ?? []).map((p) => ({
              value: p.id,
              label: p.name,
            }))}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Run history (expandable section within card)
// ---------------------------------------------------------------------------

function RunHistory({ jobId }: { jobId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['cron', 'history', jobId],
    queryFn: () => rpc.cron.history({ id: jobId, limit: 5 }),
  });

  if (isLoading) {
    return (
      <div style={{ padding: 12 }}>
        <Spin size="small" />
      </div>
    );
  }

  if (error) {
    return (
      <Typography.Text type="danger">
        Could not load history: {(error as Error).message}
      </Typography.Text>
    );
  }

  const runs = data?.runs ?? [];
  if (runs.length === 0) {
    return <span className="cron-card-muted">No runs yet.</span>;
  }

  return (
    <div className="cron-history">
      {runs.map((run, idx) => (
        <div key={run.outputPath} className="cron-history-row">
          <span className="cron-history-when">{formatRelativePast(run.ranAt)}</span>
          {idx === 0 && run.output ? (
            <pre className="cron-history-output">{run.output.slice(0, 2000)}</pre>
          ) : (
            <span className="cron-card-muted">{idx === 0 ? '(no output)' : ''}</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatNextRun(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const timeStr = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: false,
  });

  if (date.toDateString() === now.toDateString()) {
    return `Today ${timeStr}`;
  }
  if (date.toDateString() === tomorrow.toDateString()) {
    return `Tomorrow ${timeStr}`;
  }

  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatRelativePast(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (diff < 60_000) return 'just now';
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function surfaceError(
  notification: ReturnType<typeof AntApp.useApp>['notification'],
  title: string,
  err: unknown,
): void {
  notification.error({
    message: title,
    description: err instanceof Error ? err.message : String(err),
    placement: 'topRight',
  });
}

import type { CronJob } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Spin,
  Typography,
} from 'antd';
import { useState } from 'react';
import { rpc } from '../rpc';

// Cron tab — proactive pillar of v0.5. Lists scheduled jobs, lets the
// user create / pause / resume / delete / run-now, and shows the head
// of recent run history inline when a row is expanded.
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
  const [filterPersonality, setFilterPersonality] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'user' | 'system'>('user');

  const { data, isLoading, error } = useQuery({
    queryKey: ['cron', 'list'],
    queryFn: () => rpc.cron.list(),
  });

  const personalitiesQuery = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list({}),
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

  const allJobs = data?.jobs ?? [];
  const tabJobs = allJobs.filter((j) => (j.source ?? 'user') === activeTab);
  const jobs = filterPersonality
    ? tabJobs.filter((j) => j.personalityId === filterPersonality)
    : tabJobs;

  return (
    <div className="cron-tab">
      <header className="cron-toolbar">
        <span className="sessions-count">
          {jobs.length} {activeTab} {jobs.length === 1 ? 'job' : 'jobs'}
          {filterPersonality ? ` · ${filterPersonality}` : ''}
        </span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Segmented
            value={activeTab}
            onChange={(v) => setActiveTab(v as 'user' | 'system')}
            options={[
              { label: 'User', value: 'user' },
              { label: 'System', value: 'system' },
            ]}
            size="small"
          />
          {activeTab === 'user' && (
            <Select
              allowClear
              placeholder="All personalities"
              size="small"
              style={{ width: 180 }}
              value={filterPersonality}
              onChange={(v) => setFilterPersonality(v ?? null)}
              loading={personalitiesQuery.isLoading}
              options={(personalitiesQuery.data?.items ?? []).map((p) => ({
                value: p.id,
                label: p.name,
              }))}
            />
          )}
          {activeTab === 'user' && (
            <Button type="primary" onClick={() => setCreateOpen(true)}>
              New job
            </Button>
          )}
        </div>
      </header>

      {jobs.length === 0 ? (
        <div className="cron-card-empty">
          {activeTab === 'system'
            ? 'No system jobs. System jobs are seeded at startup and managed by operator config.'
            : 'No cron jobs yet. Create one to schedule a recurring agent task.'}
        </div>
      ) : (
        <div className="cron-card-list">
          {jobs.map((job) => (
            <CronCard key={job.id} job={job} />
          ))}
        </div>
      )}

      {createOpen ? <CreateJobModal open onClose={() => setCreateOpen(false)} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CronCard — card-based layout for each job
// ---------------------------------------------------------------------------

function CronCard({ job }: { job: CronJob }) {
  const [expanded, setExpanded] = useState(false);
  const queryClient = useQueryClient();
  const { notification } = AntApp.useApp();

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

  const isSystem = job.source === 'system';
  const isPaused = job.status === 'paused';
  const cardClass = `cron-card${isPaused ? ' cron-card--paused' : ''}`;

  return (
    <div>
      <button
        type="button"
        className={cardClass}
        onClick={() => setExpanded((p) => !p)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') setExpanded((p) => !p);
        }}
      >
        {/* Row 1: name + badge + run-now */}
        <div className="cron-card-top">
          <span className="cron-card-name">{job.name}</span>
          {isSystem ? (
            <span
              className="cron-card-badge"
              style={{
                background: 'var(--color-bg-secondary, #e8e8e8)',
                color: 'var(--color-text-secondary, #888)',
              }}
            >
              System
            </span>
          ) : (
            <span
              className={`cron-card-badge ${isPaused ? 'cron-card-badge--paused' : 'cron-card-badge--active'}`}
            >
              {isPaused ? 'Paused' : 'Active'}
            </span>
          )}
          <button
            type="button"
            className="cron-run-now-btn"
            disabled={runNow.isPending}
            onClick={(e) => {
              e.stopPropagation();
              runNow.mutate();
            }}
          >
            {runNow.isPending ? 'Running...' : 'Run now'}
          </button>
        </div>

        {/* Row 2: schedule · personality · deliver badge · next run */}
        <div className="cron-card-meta">
          <span>{job.schedule}</span>
          <span className="cron-card-meta-sep">&middot;</span>
          <span className="cron-card-personality">{job.personalityId}</span>
          {job.systemTask ? (
            <>
              <span className="cron-card-meta-sep">&middot;</span>
              <span>{job.systemTask}</span>
            </>
          ) : null}
          {job.deliver ? (
            <>
              <span className="cron-card-meta-sep">&middot;</span>
              <span className="cron-card-deliver-badge">{job.deliver}</span>
            </>
          ) : null}
          <span className="cron-card-meta-sep">&middot;</span>
          <span>
            {isPaused
              ? 'paused'
              : job.nextRunAt
                ? `next: ${formatRelativeFuture(job.nextRunAt)}`
                : 'next: never'}
          </span>
        </div>

        {/* Row 3: prompt description + hover actions */}
        <div className="cron-card-desc">
          <span className="cron-card-desc-text">{job.prompt}</span>
          {!isSystem && (
            /* biome-ignore lint/a11y/noStaticElementInteractions: event propagation barrier */
            <div
              className="cron-card-actions"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className="cron-card-action-btn"
                disabled={pause.isPending || resume.isPending}
                onClick={() => {
                  if (isPaused) resume.mutate();
                  else pause.mutate();
                }}
              >
                {isPaused ? 'Resume' : 'Pause'}
              </button>
              <Popconfirm
                title="Delete this job?"
                description="The schedule and run history are removed."
                okText="Delete"
                okButtonProps={{ danger: true, loading: remove.isPending }}
                cancelText="Cancel"
                onConfirm={(e) => {
                  e?.stopPropagation();
                  remove.mutate();
                }}
              >
                <button type="button" className="cron-card-action-btn cron-card-action-btn--danger">
                  Delete
                </button>
              </Popconfirm>
            </div>
          )}
        </div>
      </button>

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
            // mode=tags lets users type a custom expression in addition to picking a preset.
            // Limit to one tag so the form value stays a single string.
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
// Run history (expanded row)
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
    return <span className="cron-muted">No runs yet.</span>;
  }

  return (
    <div className="cron-history">
      {runs.map((run, idx) => (
        <div key={run.outputPath} className="cron-history-row">
          <span className="sessions-mono cron-history-when">{formatRelativePast(run.ranAt)}</span>
          {idx === 0 && run.output ? (
            <pre className="cron-history-output">{run.output.slice(0, 2000)}</pre>
          ) : (
            <span className="cron-muted">{idx === 0 ? '(no output)' : '(expand head only)'}</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function formatRelativeFuture(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = then - Date.now();
  if (diff < 0) return 'overdue';
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'in <1m';
  if (min < 60) return `in ${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `in ${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `in ${d}d`;
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

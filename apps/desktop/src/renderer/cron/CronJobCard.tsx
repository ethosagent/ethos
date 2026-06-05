import { useState } from 'react';
import { Chip } from '../ui/Chip';
import { formatNextRun, getNextRun } from './utils/cron-next-run';

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

interface CronJobCardProps {
  job: CronJob;
  onSelect: (id: string) => void;
  onRunNow: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string) => void;
  runningJobId: string | null;
}

const statusChip: Record<
  CronJob['status'],
  { label: string; variant: 'success' | 'warning' | 'neutral' | 'error' }
> = {
  active: { label: 'Active', variant: 'success' },
  paused: { label: 'Paused', variant: 'warning' },
  done: { label: 'Done', variant: 'neutral' },
};

export function CronJobCard({
  job,
  onSelect,
  onRunNow,
  onPause,
  onResume,
  onDelete,
  onEdit,
  runningJobId,
}: CronJobCardProps) {
  const [hovered, setHovered] = useState(false);
  const isRunning = runningJobId === job.id;
  const chip = statusChip[job.status];
  const nextRun = job.nextRunAt ? new Date(job.nextRunAt) : getNextRun(job.schedule);

  return (
    // biome-ignore lint/a11y/useSemanticElements: container holds nested buttons; cannot use <button>
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(job.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(job.id);
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        backgroundColor: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 8,
        padding: 16,
        marginBottom: 16,
        cursor: 'pointer',
        transition: `border-color var(--motion-fast) var(--ease)`,
        borderColor: hovered ? 'var(--text-tertiary)' : 'var(--border-subtle)',
      }}
    >
      {/* Row 1: name, chip, spacer, run now */}
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
          {job.name}
        </span>
        <span style={{ marginLeft: 8 }}>
          <Chip label={chip.label} variant={chip.variant} />
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (!isRunning) onRunNow(job.id);
          }}
          disabled={isRunning}
          style={{
            background: 'none',
            border: 'none',
            cursor: isRunning ? 'default' : 'pointer',
            fontSize: 12,
            color: isRunning ? 'var(--text-tertiary)' : 'var(--info)',
            padding: 0,
            transition: `color var(--motion-fast) var(--ease)`,
          }}
        >
          {isRunning ? 'Running...' : 'Run now'}
        </button>
      </div>

      {/* Row 2: schedule, personality, next run */}
      <div style={{ display: 'flex', alignItems: 'center', marginTop: 8 }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-secondary)',
          }}
        >
          {job.schedule}
        </span>
        <span style={{ margin: '0 6px', color: 'var(--text-tertiary)', fontSize: 11 }}>·</span>
        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{job.personalityId}</span>
        {job.deliver ? (
          <>
            <span style={{ margin: '0 6px', color: 'var(--text-tertiary)', fontSize: 11 }}>·</span>
            <span
              style={{
                fontSize: 10,
                fontFamily: 'var(--font-mono)',
                textTransform: 'capitalize',
                color: 'var(--text-tertiary)',
                background: 'var(--ethos-surface-tint)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-sm, 4px)',
                padding: '1px 6px',
              }}
            >
              {job.deliver}
            </span>
          </>
        ) : null}
        <span style={{ margin: '0 6px', color: 'var(--text-tertiary)', fontSize: 11 }}>·</span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-tertiary)',
          }}
        >
          {job.status === 'paused' ? 'Paused' : formatNextRun(nextRun)}
        </span>
      </div>

      {/* Row 3: prompt preview + hover actions */}
      <div style={{ display: 'flex', alignItems: 'center', marginTop: 12 }}>
        <div
          style={{
            flex: 1,
            fontSize: 12,
            color: 'var(--text-tertiary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {job.prompt}
        </div>
        <div
          style={{
            display: 'flex',
            gap: 10,
            opacity: hovered ? 1 : 0,
            transition: `opacity var(--motion-fast) var(--ease)`,
            marginLeft: 12,
          }}
        >
          <button
            type="button"
            title={job.status === 'paused' ? 'Resume' : 'Pause'}
            onClick={(e) => {
              e.stopPropagation();
              job.status === 'paused' ? onResume(job.id) : onPause(job.id);
            }}
            style={actionButtonStyle}
          >
            {job.status === 'paused' ? '▶' : '⏸'}
          </button>
          <button
            type="button"
            title="Edit"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(job.id);
            }}
            style={actionButtonStyle}
          >
            ✎
          </button>
          <button
            type="button"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(job.id);
            }}
            style={{ ...actionButtonStyle, color: 'var(--text-secondary)' }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'var(--error)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'var(--text-secondary)';
            }}
          >
            🗑
          </button>
        </div>
      </div>
    </div>
  );
}

const actionButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  fontSize: 18,
  color: 'var(--text-secondary)',
  padding: 0,
  lineHeight: 1,
};

import type { JobSteerWire } from '@ethosagent/web-contracts';
import { useMemo } from 'react';
import { transcriptLines } from '../../../lib/task-steer';
import { useTaskEvents } from '../api/queries';

const mono = "'Geist Mono', monospace";

const STATE_CHIP: Record<JobSteerWire['state'], { color: string; label: string }> = {
  pending: { color: 'var(--info)', label: 'Pending' },
  read: { color: 'var(--success)', label: 'Read' },
  unread: { color: 'var(--warning)', label: 'Unread' },
};

export function SteersList({ steers }: { steers: JobSteerWire[] }) {
  if (steers.length === 0) {
    return <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>No steers sent.</span>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {steers.map((s) => {
        const chip = STATE_CHIP[s.state];
        return (
          <div
            key={s.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '72px 1fr',
              gap: 8,
              alignItems: 'baseline',
              padding: '4px 0',
              borderBottom: '1px solid var(--border-subtle)',
            }}
          >
            <span
              style={{
                justifySelf: 'start',
                padding: '2px 8px',
                borderRadius: 9999,
                fontSize: 11,
                fontWeight: 500,
                color: chip.color,
                background: `color-mix(in srgb, ${chip.color} 15%, transparent)`,
              }}
            >
              {chip.label}
            </span>
            <span style={{ fontSize: 13, wordBreak: 'break-word' }}>{s.text}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Live transcript: model text with tool headlines between, fed by the `tasks.events` cursor poll. */
export function TranscriptPane({ jobId, live }: { jobId: string; live: boolean }) {
  const { data } = useTaskEvents(jobId, { live });
  const lines = useMemo(() => transcriptLines(data ?? []), [data]);
  if (lines.length === 0) {
    return <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>No output yet.</span>;
  }
  return (
    <div
      style={{
        maxHeight: 320,
        overflowY: 'auto',
        padding: 12,
        fontFamily: mono,
        fontSize: 12,
        lineHeight: 1.5,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 6,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {lines.map((l) => (
        <div
          key={l.key}
          style={{
            color: l.kind === 'text' ? 'var(--text-primary)' : 'var(--text-tertiary)',
          }}
        >
          {l.kind === 'tool' ? `› ${l.text}` : l.kind === 'steer' ? `↩ ${l.text}` : l.text}
        </div>
      ))}
    </div>
  );
}

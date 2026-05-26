import { useCallback } from 'react';
import { formatNextRun, getNextRun } from '../utils/cron-next-run';
import { parseScheduleInput } from '../utils/schedule-parser';

interface ScheduleInputProps {
  value: string;
  onChange: (value: string) => void;
  cronExpression: string | null;
  onCronChange: (cron: string | null) => void;
  id?: string;
}

export function ScheduleInput({
  value,
  onChange,
  cronExpression,
  onCronChange,
  id,
}: ScheduleInputProps) {
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value;
      onChange(raw);
      const result = parseScheduleInput(raw);
      onCronChange(result?.cron ?? null);
    },
    [onChange, onCronChange],
  );

  const parsed = parseScheduleInput(value);
  const nextRun = cronExpression ? getNextRun(cronExpression) : null;
  const hasInput = value.trim().length > 0;

  return (
    <div>
      <input
        id={id}
        type="text"
        value={value}
        onChange={handleChange}
        placeholder="every weekday at 9am"
        style={{
          width: '100%',
          height: 36,
          fontFamily: 'var(--font-display)',
          fontSize: 14,
          color: 'var(--text-primary)',
          backgroundColor: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 4,
          padding: '0 10px',
          outline: 'none',
          boxSizing: 'border-box',
        }}
      />
      {hasInput && parsed && (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--text-secondary)',
            }}
          >
            &rarr; {parsed.cron}
          </span>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--text-tertiary)',
            }}
          >
            Next: {formatNextRun(nextRun)}
          </span>
        </div>
      )}
      {hasInput && !parsed && (
        <span
          style={{
            display: 'block',
            marginTop: 6,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--error)',
          }}
        >
          Could not parse schedule
        </span>
      )}
    </div>
  );
}

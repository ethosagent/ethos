import { createEthosClient } from '@ethosagent/sdk';
import { useMemo, useState } from 'react';
import { DeliveryOptions } from './components/DeliveryOptions';
import { PersonalityPicker } from './components/PersonalityPicker';
import { ScheduleInput } from './components/ScheduleInput';

interface CreateJobFormProps {
  port: number;
  open: boolean;
  onToggle: () => void;
  onCreated: () => void;
  platformStatus: { telegram: boolean; slack: boolean; discord: boolean };
}

export function CreateJobForm({
  port,
  open,
  onToggle,
  onCreated,
  platformStatus,
}: CreateJobFormProps) {
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [personalityId, setPersonalityId] = useState<string | null>(null);
  const [scheduleText, setScheduleText] = useState('');
  const [cronExpression, setCronExpression] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const client = useMemo(
    () => createEthosClient({ baseUrl: `http://localhost:${port}`, fetch: globalThis.fetch }),
    [port],
  );

  const canSubmit = name.trim() && cronExpression && personalityId && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit || !cronExpression || !personalityId) return;
    setSubmitting(true);
    try {
      await client.rpc.cron.create({
        name: name.trim(),
        schedule: cronExpression,
        prompt: prompt.trim(),
        personalityId,
      });
      setName('');
      setPrompt('');
      setPersonalityId(null);
      setScheduleText('');
      setCronExpression(null);
      onCreated();
    } catch {
      // best-effort
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ borderTop: '1px solid var(--border-subtle)' }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          height: 36,
          padding: '0 16px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 500,
            color: 'var(--text-tertiary)',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
          }}
        >
          NEW JOB
        </span>
        <span
          style={{
            fontSize: 12,
            color: 'var(--text-tertiary)',
            transition: `transform var(--motion-fast) var(--ease)`,
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            display: 'inline-block',
          }}
        >
          ▾
        </span>
      </button>

      {open && (
        <div
          style={{
            padding: '0 16px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Daily standup"
            style={inputStyle}
          />

          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should the agent do?"
            style={{
              ...inputStyle,
              height: 'auto',
              minHeight: 72,
              resize: 'vertical',
              padding: '8px 10px',
              fontFamily: 'var(--font-display)',
            }}
          />

          <PersonalityPicker port={port} value={personalityId} onChange={setPersonalityId} />

          <ScheduleInput
            value={scheduleText}
            onChange={setScheduleText}
            cronExpression={cronExpression}
            onCronChange={setCronExpression}
          />

          <DeliveryOptions platformStatus={platformStatus} />

          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            style={{
              width: '100%',
              height: 36,
              backgroundColor: 'var(--accent)',
              color: 'var(--bg-base)',
              border: 'none',
              borderRadius: 4,
              fontSize: 13,
              fontWeight: 500,
              cursor: canSubmit ? 'pointer' : 'default',
              opacity: canSubmit ? 1 : 0.5,
              transition: `opacity var(--motion-fast) var(--ease)`,
            }}
          >
            {submitting ? 'Scheduling...' : 'Schedule job'}
          </button>
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 36,
  fontFamily: 'var(--font-display)',
  fontSize: 14,
  color: 'var(--text-primary)',
  backgroundColor: 'var(--bg-elevated)',
  border: '1px solid var(--border-strong, #3a3a3a)',
  borderRadius: 4,
  padding: '0 10px',
  outline: 'none',
  boxSizing: 'border-box',
};

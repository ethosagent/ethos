import { createEthosClient } from '@ethosagent/sdk';
import { useMemo, useState } from 'react';
import { PersonalityPicker } from '../components/PersonalityPicker';
import { ScheduleInput } from '../components/ScheduleInput';
import { formatNextRun, getNextRun } from '../utils/cron-next-run';
import { parseScheduleInput } from '../utils/schedule-parser';

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

interface JobInfoTabProps {
  job: CronJob;
  port: number;
  onSaved: () => void;
}

export function JobInfoTab({ job, port, onSaved }: JobInfoTabProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(job.name);
  const [prompt, setPrompt] = useState(job.prompt);
  const [personalityId, setPersonalityId] = useState(job.personalityId);
  const [scheduleText, setScheduleText] = useState(job.schedule);
  const [cronExpression, setCronExpression] = useState<string | null>(job.schedule);
  const [saving, setSaving] = useState(false);

  const client = useMemo(
    () => createEthosClient({ baseUrl: `http://localhost:${port}`, fetch: globalThis.fetch }),
    [port],
  );

  const parsed = parseScheduleInput(job.schedule);
  const nextRun = getNextRun(job.schedule);

  const handleEdit = () => {
    setName(job.name);
    setPrompt(job.prompt);
    setPersonalityId(job.personalityId);
    setScheduleText(job.schedule);
    setCronExpression(job.schedule);
    setEditing(true);
  };

  const handleCancel = () => {
    setEditing(false);
  };

  const handleSave = async () => {
    if (!cronExpression) return;
    setSaving(true);
    try {
      await client.rpc.cron.update({
        id: job.id,
        name,
        schedule: cronExpression,
        prompt,
        personalityId,
      });
      setEditing(false);
      onSaved();
    } catch {
      // best-effort
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label htmlFor="edit-job-name" style={labelStyle}>
            Job name
          </label>
          <input
            id="edit-job-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={inputStyle}
          />
        </div>
        <div>
          <label htmlFor="edit-job-prompt" style={labelStyle}>
            Prompt
          </label>
          <textarea
            id="edit-job-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            style={{
              ...inputStyle,
              minHeight: 72,
              resize: 'vertical',
              fontFamily: 'var(--font-mono)',
              fontSize: 13,
              padding: '8px 10px',
            }}
          />
        </div>
        <div>
          <label htmlFor="edit-job-personality" style={labelStyle}>
            Personality
          </label>
          <PersonalityPicker
            port={port}
            value={personalityId}
            onChange={setPersonalityId}
            id="edit-job-personality"
          />
        </div>
        <div>
          <label htmlFor="edit-job-schedule" style={labelStyle}>
            Schedule
          </label>
          <ScheduleInput
            id="edit-job-schedule"
            value={scheduleText}
            onChange={setScheduleText}
            cronExpression={cronExpression}
            onCronChange={setCronExpression}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !name.trim() || !cronExpression}
            style={{
              height: 32,
              padding: '0 16px',
              backgroundColor: 'var(--accent)',
              color: 'var(--bg-base)',
              border: 'none',
              borderRadius: 4,
              fontSize: 13,
              fontWeight: 500,
              cursor: saving ? 'default' : 'pointer',
              opacity: saving || !name.trim() || !cronExpression ? 0.5 : 1,
            }}
          >
            {saving ? 'Saving...' : 'Save changes'}
          </button>
          <button
            type="button"
            onClick={handleCancel}
            style={{
              height: 32,
              padding: '0 16px',
              backgroundColor: 'transparent',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 4,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={handleEdit}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 12,
            color: 'var(--info)',
            padding: 0,
          }}
        >
          Edit
        </button>
      </div>

      <div>
        <div style={sectionLabelStyle}>Schedule</div>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--text-primary)',
          }}
        >
          {job.schedule}
        </div>
        {parsed && (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
            {parsed.human}
          </div>
        )}
        <div
          style={{
            fontSize: 12,
            color: 'var(--text-tertiary)',
            marginTop: 2,
          }}
        >
          Next run: {job.status === 'paused' ? 'Paused' : formatNextRun(nextRun)}
        </div>
      </div>

      <div>
        <div style={sectionLabelStyle}>Prompt</div>
        <pre
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            color: 'var(--text-primary)',
            backgroundColor: 'var(--bg-elevated)',
            borderRadius: 4,
            padding: '8px 10px',
            margin: 0,
            maxHeight: 120,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {job.prompt}
        </pre>
      </div>

      <div>
        <div style={sectionLabelStyle}>Personality</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{job.personalityId}</div>
      </div>

      {job.deliver && (
        <div>
          <div style={sectionLabelStyle}>Delivery</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{job.deliver}</div>
        </div>
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  fontWeight: 500,
  color: 'var(--text-tertiary)',
  textTransform: 'uppercase',
  marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
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
};

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  color: 'var(--text-tertiary)',
  textTransform: 'uppercase',
  marginBottom: 6,
};

import { Button, Input } from 'antd';
import { useState } from 'react';
import { STEER_MAX_CHARS } from '../../../lib/task-steer';
import { useTaskSteer } from '../api/mutations';

/**
 * One-line steer box. The run reads the message at its next step, so the
 * success state says "queued", never "delivered".
 */
export function TaskSteerInput({ jobId, autoFocus }: { jobId: string; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const steer = useTaskSteer();
  const trimmed = text.trim();

  const send = () => {
    if (!trimmed || steer.isPending) return;
    steer.mutate({ id: jobId, text: trimmed }, { onSuccess: () => setText('') });
  };

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <Input
        size="small"
        autoFocus={autoFocus}
        value={text}
        maxLength={STEER_MAX_CHARS}
        placeholder="Tell this run something — it reads it at its next step"
        aria-label="Steer this run"
        onChange={(e) => setText(e.target.value)}
        onPressEnter={send}
      />
      <Button
        size="small"
        type="primary"
        loading={steer.isPending}
        disabled={!trimmed}
        onClick={send}
      >
        Send
      </Button>
      {steer.isSuccess ? (
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>queued</span>
      ) : null}
    </div>
  );
}

import { useState } from 'react';

interface SaveButtonProps {
  disabled: boolean;
  onSave: () => Promise<{ ok: boolean; error?: string }>;
  onError?: (error: string) => void;
}

type SaveState = 'idle' | 'saving' | 'success' | 'error';

export function SaveButton({ disabled, onSave, onError }: SaveButtonProps) {
  const [state, setState] = useState<SaveState>('idle');
  const [errorText, setErrorText] = useState('');

  async function handleClick() {
    setState('saving');
    setErrorText('');
    try {
      const result = await onSave();
      if (result.ok) {
        setState('success');
        setTimeout(() => setState('idle'), 2000);
      } else {
        const msg = result.error ?? 'Save failed';
        setState('error');
        setErrorText(msg);
        onError?.(msg);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Save failed';
      setState('error');
      setErrorText(msg);
      onError?.(msg);
    }
  }

  const label = state === 'saving' ? 'Saving...' : state === 'success' ? 'Saved ✓' : 'Save';

  const bgColor = state === 'success' ? 'var(--success)' : 'var(--bg-overlay)';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
      <button
        type="button"
        disabled={disabled || state === 'saving'}
        onClick={handleClick}
        style={{
          height: 36,
          padding: '0 20px',
          borderRadius: 4,
          border: 'none',
          backgroundColor: bgColor,
          color: 'var(--text-primary)',
          fontSize: 13,
          fontWeight: 500,
          cursor: disabled || state === 'saving' ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          transition: 'background-color var(--motion-fast) var(--ease)',
        }}
      >
        {label}
      </button>
      {state === 'error' && errorText && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--error)',
          }}
        >
          {errorText}
        </span>
      )}
    </div>
  );
}

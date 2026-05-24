import { useCallback, useEffect, useState } from 'react';

interface KeyRevealPanelProps {
  keyValue: string;
  onDismiss: () => void;
}

export function KeyRevealPanel({ keyValue, onDismiss }: KeyRevealPanelProps) {
  const [countdown, setCountdown] = useState(30);
  const [copied, setCopied] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (countdown <= 0) {
      setHidden(true);
      return;
    }
    const timer = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(keyValue);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [keyValue]);

  return (
    <div
      style={{
        position: 'relative',
        border: '1px solid var(--border-subtle)',
        borderRadius: 8,
        padding: 16,
        background: 'var(--bg-elevated)',
      }}
    >
      <button
        type="button"
        onClick={onDismiss}
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          background: 'none',
          border: 'none',
          fontSize: 18,
          color: 'var(--text-tertiary)',
          cursor: 'pointer',
          padding: 0,
          lineHeight: 1,
        }}
      >
        &times;
      </button>

      <div
        style={{
          fontSize: 11,
          fontWeight: 500,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--warning)',
          marginBottom: 12,
        }}
      >
        YOUR NEW API KEY (COPY NOW &mdash; SHOWN ONCE)
      </div>

      {hidden ? (
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', padding: '12px 0' }}>
          Key hidden. It cannot be retrieved again.
        </div>
      ) : (
        <>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 13,
              color: 'var(--text-primary)',
              background: 'var(--bg-elevated)',
              borderRadius: 8,
              padding: '12px 16px',
              letterSpacing: '0.02em',
              wordBreak: 'break-all',
              border: '1px solid var(--border-subtle)',
              marginBottom: 12,
            }}
          >
            {keyValue}
          </div>

          <button
            type="button"
            onClick={handleCopy}
            style={{
              height: 28,
              width: '100%',
              borderRadius: 4,
              border: 'none',
              background: copied ? 'var(--success)' : 'var(--accent)',
              color: '#fff',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              marginBottom: 8,
            }}
          >
            {copied ? 'Copied ✓' : 'Copy'}
          </button>

          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--text-tertiary)',
            }}
          >
            Auto-hiding in {countdown} seconds.
          </div>
        </>
      )}
    </div>
  );
}

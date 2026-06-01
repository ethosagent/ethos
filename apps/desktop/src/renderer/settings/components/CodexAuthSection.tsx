import { useEffect, useState } from 'react';

interface CodexAuthSectionProps {
  onAuthUpdated: () => void;
}

type AuthState =
  | { status: 'checking' }
  | { status: 'connected' }
  | { status: 'not_connected' }
  | { status: 'awaiting_code'; userCode: string }
  | { status: 'error'; message: string };

export function CodexAuthSection({ onAuthUpdated }: CodexAuthSectionProps) {
  const [state, setState] = useState<AuthState>({ status: 'checking' });

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional mount-only effect
  useEffect(() => {
    void checkStatus();

    const cleanup = window.ethos.codex.onAuthComplete((data) => {
      if (data.ok) {
        setState({ status: 'connected' });
        onAuthUpdated();
      } else {
        setState({ status: 'error', message: data.error ?? 'Authorization failed.' });
      }
    });

    return cleanup;
  }, []);

  async function checkStatus() {
    setState({ status: 'checking' });
    try {
      const result = await window.ethos.codex.authStatus();
      setState(result.authorized ? { status: 'connected' } : { status: 'not_connected' });
    } catch {
      setState({ status: 'not_connected' });
    }
  }

  async function handleConnect() {
    setState({ status: 'checking' });
    try {
      const result = await window.ethos.codex.startAuth();
      if (!result.ok || !result.userCode) {
        setState({ status: 'error', message: result.error ?? 'Failed to start device auth.' });
        return;
      }
      setState({ status: 'awaiting_code', userCode: result.userCode });
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to start device auth.',
      });
    }
  }

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // ignore
    }
  }

  return (
    <div style={{ padding: '8px 0' }}>
      {state.status === 'checking' && (
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Checking status…</div>
      )}

      {state.status === 'connected' && (
        <div>
          <div
            style={{
              fontSize: 13,
              color: 'var(--success)',
              marginBottom: 8,
            }}
          >
            Connected
          </div>
          <button
            type="button"
            onClick={() => void handleConnect()}
            style={{
              height: 28,
              padding: '0 12px',
              borderRadius: 4,
              border: '1px solid var(--border-subtle)',
              backgroundColor: 'transparent',
              color: 'var(--text-secondary)',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Re-connect
          </button>
        </div>
      )}

      {state.status === 'not_connected' && (
        <button
          type="button"
          onClick={() => void handleConnect()}
          style={{
            height: 32,
            padding: '0 16px',
            borderRadius: 4,
            border: 'none',
            backgroundColor: 'var(--bg-overlay)',
            color: 'var(--text-primary)',
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          Connect with ChatGPT
        </button>
      )}

      {state.status === 'awaiting_code' && (
        <div>
          <div style={{ fontSize: 13, color: 'var(--text-primary)', marginBottom: 8 }}>
            The auth page has opened in your browser. Enter this code:
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 8,
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 18,
                fontWeight: 700,
                letterSpacing: '0.12em',
                color: 'var(--text-primary)',
              }}
            >
              {state.userCode}
            </span>
            <button
              type="button"
              onClick={() => void copyCode(state.userCode)}
              style={{
                height: 24,
                padding: '0 10px',
                borderRadius: 4,
                border: '1px solid var(--border-subtle)',
                backgroundColor: 'transparent',
                color: 'var(--text-secondary)',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              Copy
            </button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            Waiting for authorization…
          </div>
        </div>
      )}

      {state.status === 'error' && (
        <div>
          <div style={{ fontSize: 13, color: 'var(--error)', marginBottom: 8 }}>
            {state.message}
          </div>
          <button
            type="button"
            onClick={() => void handleConnect()}
            style={{
              height: 28,
              padding: '0 12px',
              borderRadius: 4,
              border: '1px solid var(--border-subtle)',
              backgroundColor: 'transparent',
              color: 'var(--text-primary)',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

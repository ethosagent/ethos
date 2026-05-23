import { useState } from 'react';

interface StepApiKeyProps {
  provider: string;
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  onValidated: (models: string[]) => void;
}

type ValidationState = 'idle' | 'loading' | 'success' | 'error';

export function StepApiKey({ provider, apiKey, onApiKeyChange, onValidated }: StepApiKeyProps) {
  const [state, setState] = useState<ValidationState>('idle');
  const [showKey, setShowKey] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const isOllama = provider === 'ollama';

  async function validate() {
    setState('loading');
    setErrorMessage('');

    const result = (await window.ethos.onboarding.validateProvider({
      provider,
      apiKey,
      baseUrl: isOllama ? 'http://localhost:11434' : undefined,
    })) as { valid: boolean; completionTested: boolean; error?: string; models?: string[] };

    if (result.valid) {
      setState('success');
      onValidated(result.models || []);
    } else {
      setState('error');
      setErrorMessage(result.error || 'Validation failed');
    }
  }

  if (isOllama) {
    return (
      <div>
        <h2
          style={{ fontSize: 24, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}
        >
          Connect to Ollama
        </h2>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 16 }}>
          Ollama must be running on this machine. Start it with{' '}
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>ollama serve</code>.
        </p>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            backgroundColor: 'var(--bg-elevated)',
            borderRadius: 'var(--radius-md)',
            padding: 12,
            marginBottom: 16,
            color: 'var(--text-primary)',
          }}
        >
          ollama serve
        </div>
        <button
          type="button"
          onClick={validate}
          disabled={state === 'loading'}
          style={{
            height: 36,
            padding: '0 16px',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border-subtle)',
            background: 'transparent',
            color: 'var(--text-primary)',
            fontSize: 14,
            cursor: state === 'loading' ? 'not-allowed' : 'pointer',
            opacity: state === 'loading' ? 0.6 : 1,
          }}
        >
          {state === 'loading' ? 'Checking...' : 'Test connection'}
        </button>
        {state === 'success' && (
          <p style={{ fontSize: 12, color: 'var(--success)', marginTop: 8 }}>Ollama is running ✓</p>
        )}
        {state === 'error' && (
          <p style={{ fontSize: 12, color: 'var(--error)', marginTop: 8 }}>
            Cannot reach Ollama. Make sure it is running.
          </p>
        )}
      </div>
    );
  }

  const instruction =
    provider === 'anthropic'
      ? 'Get your key at console.anthropic.com → API keys'
      : 'Get your key at platform.openai.com → API keys';

  return (
    <div>
      <h2 style={{ fontSize: 24, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
        Add your API key
      </h2>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 16 }}>
        {instruction}
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => {
              onApiKeyChange(e.target.value);
              setState('idle');
            }}
            placeholder="sk-..."
            style={{
              width: '100%',
              height: 36,
              padding: '0 36px 0 12px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-subtle)',
              backgroundColor: 'var(--bg-elevated)',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-mono)',
              fontSize: 13,
              outline: 'none',
              transition: `border-color var(--motion-fast) var(--ease)`,
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = 'var(--info)';
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'var(--border-subtle)';
            }}
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            style={{
              position: 'absolute',
              right: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              background: 'none',
              border: 'none',
              color: 'var(--text-tertiary)',
              cursor: 'pointer',
              fontSize: 14,
              padding: 4,
            }}
            aria-label={showKey ? 'Hide API key' : 'Show API key'}
          >
            {showKey ? '🙈' : '👁'}
          </button>
        </div>
        <button
          type="button"
          onClick={validate}
          disabled={state === 'loading' || !apiKey.trim()}
          style={{
            height: 36,
            padding: '0 16px',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border-subtle)',
            background: 'transparent',
            color: 'var(--text-primary)',
            fontSize: 14,
            cursor: state === 'loading' || !apiKey.trim() ? 'not-allowed' : 'pointer',
            opacity: state === 'loading' || !apiKey.trim() ? 0.6 : 1,
            whiteSpace: 'nowrap',
          }}
        >
          {state === 'loading' ? 'Checking...' : 'Validate'}
        </button>
      </div>
      {state === 'success' && (
        <p style={{ fontSize: 12, color: 'var(--success)', marginBottom: 12 }}>Valid ✓</p>
      )}
      {state === 'error' && (
        <p style={{ fontSize: 12, color: 'var(--error)', marginBottom: 12 }}>{errorMessage}</p>
      )}
      <p
        style={{
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--text-tertiary)',
        }}
      >
        STORED IN {process.platform === 'darwin' ? 'MACOS KEYCHAIN' : 'SYSTEM CREDENTIAL STORE'} ·
        NEVER WRITTEN TO A FILE
      </p>
    </div>
  );
}

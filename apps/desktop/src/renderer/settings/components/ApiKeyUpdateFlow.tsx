import { useState } from 'react';

interface ApiKeyUpdateFlowProps {
  provider: string;
  onKeyUpdated: () => void;
}

type ValidationState = 'idle' | 'validating' | 'valid' | 'invalid';

export function ApiKeyUpdateFlow({ provider, onKeyUpdated }: ApiKeyUpdateFlowProps) {
  const [newKey, setNewKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [validation, setValidation] = useState<ValidationState>('idle');
  const [validationError, setValidationError] = useState('');
  const [updating, setUpdating] = useState(false);
  const [stored, setStored] = useState(false);

  async function handleValidate() {
    if (!newKey.trim()) return;
    setValidation('validating');
    setValidationError('');
    try {
      const result = await window.ethos.onboarding.validateProvider({
        provider: provider as 'anthropic' | 'openai' | 'openrouter' | 'azure',
        apiKey: newKey,
      });
      const res = result as { valid: boolean; error?: string };
      if (res.valid) {
        setValidation('valid');
      } else {
        setValidation('invalid');
        setValidationError(res.error ?? 'Invalid key');
      }
    } catch {
      setValidation('invalid');
      setValidationError('Validation failed');
    }
  }

  async function handleUpdate() {
    setUpdating(true);
    try {
      await window.ethos.keychain.set({ key: 'api-key', value: newKey });
      await window.ethos.settings.updateConfig({});
      setStored(true);
      setNewKey('');
      setValidation('idle');
      setShowKey(false);
      onKeyUpdated();
      setTimeout(() => setStored(false), 5000);
    } catch {
      // keep state
    } finally {
      setUpdating(false);
    }
  }

  return (
    <div style={{ padding: '8px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type={showKey ? 'text' : 'password'}
          value={newKey}
          onChange={(e) => {
            setNewKey(e.target.value);
            setValidation('idle');
            setValidationError('');
          }}
          placeholder="Paste new key here..."
          style={{
            flex: 1,
            height: 36,
            padding: '0 12px',
            borderRadius: 4,
            border: '1px solid var(--border-subtle)',
            backgroundColor: 'var(--bg-elevated)',
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            outline: 'none',
          }}
        />
        <button
          type="button"
          onClick={() => setShowKey(!showKey)}
          style={{
            height: 36,
            padding: '0 12px',
            borderRadius: 4,
            border: '1px solid var(--border-subtle)',
            backgroundColor: 'transparent',
            color: 'var(--text-secondary)',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          {showKey ? 'Hide' : 'Show'}
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <button
          type="button"
          onClick={handleValidate}
          disabled={!newKey.trim() || validation === 'validating'}
          style={{
            height: 28,
            padding: '0 12px',
            borderRadius: 4,
            border: '1px solid var(--border-subtle)',
            backgroundColor: 'transparent',
            color: 'var(--text-primary)',
            fontSize: 12,
            cursor: !newKey.trim() ? 'not-allowed' : 'pointer',
            opacity: !newKey.trim() ? 0.5 : 1,
          }}
        >
          {validation === 'validating' ? 'Validating...' : 'Validate'}
        </button>

        {validation === 'valid' && <span style={{ fontSize: 12, color: 'var(--success)' }}>✓</span>}
        {validation === 'invalid' && (
          <span style={{ fontSize: 12, color: 'var(--error)' }}>✕ {validationError}</span>
        )}

        {validation === 'valid' && (
          <button
            type="button"
            onClick={handleUpdate}
            disabled={updating}
            style={{
              height: 28,
              padding: '0 16px',
              borderRadius: 4,
              border: 'none',
              backgroundColor: 'var(--bg-overlay)',
              color: 'var(--text-primary)',
              fontSize: 12,
              fontWeight: 500,
              cursor: updating ? 'not-allowed' : 'pointer',
            }}
          >
            {updating ? 'Updating...' : 'Update'}
          </button>
        )}
      </div>

      {stored && (
        <div
          style={{
            marginTop: 8,
            display: 'inline-block',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--success)',
            backgroundColor: 'var(--bg-overlay)',
            padding: '2px 8px',
            borderRadius: 4,
          }}
        >
          Stored in keychain
        </div>
      )}
    </div>
  );
}

import { useState } from 'react';

interface StepApiKeyProps {
  provider: string;
  apiKey: string;
  baseUrl: string;
  selectedModel: string;
  onApiKeyChange: (key: string) => void;
  onBaseUrlChange: (url: string) => void;
  onModelChange: (model: string) => void;
  onValidated: (models: string[]) => void;
}

type ValidationState = 'idle' | 'loading' | 'success' | 'error';

function inputField(
  label: string,
  value: string,
  onChange: (v: string) => void,
  opts: { type?: string; placeholder?: string; monospace?: boolean; id?: string } = {},
) {
  const fieldId = label.toLowerCase().replace(/\s+/g, '-');
  return (
    <div style={{ marginBottom: 12 }}>
      <label
        htmlFor={opts.id || fieldId}
        style={{
          display: 'block',
          fontSize: 11,
          fontWeight: 500,
          color: 'var(--text-secondary)',
          marginBottom: 4,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        {label}
      </label>
      <input
        id={opts.id || fieldId}
        type={opts.type || 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={opts.placeholder}
        style={{
          width: '100%',
          height: 36,
          padding: '0 12px',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border-subtle)',
          backgroundColor: 'var(--bg-elevated)',
          color: 'var(--text-primary)',
          fontFamily: opts.monospace ? 'var(--font-mono)' : 'inherit',
          fontSize: 13,
          outline: 'none',
          boxSizing: 'border-box',
          transition: 'border-color var(--motion-fast) var(--ease)',
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = 'var(--info)';
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = 'var(--border-subtle)';
        }}
      />
    </div>
  );
}

export function StepApiKey({
  provider,
  apiKey,
  baseUrl,
  selectedModel,
  onApiKeyChange,
  onBaseUrlChange,
  onModelChange,
  onValidated,
}: StepApiKeyProps) {
  const [validationState, setValidationState] = useState<ValidationState>('idle');
  const [showKey, setShowKey] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [deploymentName, setDeploymentName] = useState('');

  function resetValidation() {
    setValidationState('idle');
    setErrorMessage('');
  }

  function handleApiKeyChange(k: string) {
    onApiKeyChange(k);
    resetValidation();
  }

  function handleBaseUrlChange(url: string) {
    onBaseUrlChange(url);
    resetValidation();
  }

  function handleDeploymentChange(name: string) {
    setDeploymentName(name);
    resetValidation();
  }

  function isValidateDisabled(): boolean {
    if (validationState === 'loading') return true;
    if (provider === 'azure') {
      return !baseUrl.trim() || !apiKey.trim() || !deploymentName.trim();
    }
    return !apiKey.trim();
  }

  async function validate() {
    setValidationState('loading');
    setErrorMessage('');

    const req: {
      provider: 'anthropic' | 'openai' | 'openrouter' | 'azure';
      apiKey: string;
      baseUrl?: string;
      model?: string;
    } = {
      provider: provider as 'anthropic' | 'openai' | 'openrouter' | 'azure',
      apiKey,
    };

    if (provider === 'azure') {
      req.baseUrl = baseUrl;
      req.model = deploymentName;
    }

    const result = (await window.ethos.onboarding.validateProvider(req)) as {
      valid: boolean;
      completionTested: boolean;
      error?: string;
      models?: string[];
    };

    if (result.valid) {
      setValidationState('success');
      const models = result.models || [];
      onValidated(models);
      // Pre-select the first model for providers that return a list
      if (provider === 'anthropic') {
        onModelChange('claude-sonnet-4-20250514');
      } else if (provider === 'openai') {
        onModelChange('gpt-4o');
      } else if (provider === 'azure') {
        onModelChange(deploymentName);
      }
      // OpenRouter: model is typed by the user, no pre-select
    } else {
      setValidationState('error');
      setErrorMessage(result.error || 'Validation failed');
    }
  }

  const validated = validationState === 'success';

  const apiKeyField = (
    <div style={{ marginBottom: 12 }}>
      <label
        htmlFor="api-key"
        style={{
          display: 'block',
          fontSize: 11,
          fontWeight: 500,
          color: 'var(--text-secondary)',
          marginBottom: 4,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        API Key
      </label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <input
            id="api-key"
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => handleApiKeyChange(e.target.value)}
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
              boxSizing: 'border-box',
              transition: 'border-color var(--motion-fast) var(--ease)',
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
          disabled={isValidateDisabled()}
          style={{
            height: 36,
            padding: '0 16px',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border-subtle)',
            background: 'transparent',
            color: 'var(--text-primary)',
            fontSize: 14,
            cursor: isValidateDisabled() ? 'not-allowed' : 'pointer',
            opacity: isValidateDisabled() ? 0.6 : 1,
            whiteSpace: 'nowrap',
          }}
        >
          {validationState === 'loading' ? 'Checking...' : 'Validate'}
        </button>
      </div>
    </div>
  );

  const footer = (
    <p
      style={{
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--text-tertiary)',
        marginTop: 8,
      }}
    >
      STORED IN MACOS KEYCHAIN · NEVER WRITTEN TO A FILE
    </p>
  );

  const validationStatus = (
    <>
      {validationState === 'success' && (
        <p style={{ fontSize: 12, color: 'var(--success)', marginBottom: 12 }}>Valid ✓</p>
      )}
      {validationState === 'error' && (
        <p style={{ fontSize: 12, color: 'var(--error)', marginBottom: 12 }}>{errorMessage}</p>
      )}
    </>
  );

  if (provider === 'anthropic') {
    return (
      <div>
        <h2
          style={{ fontSize: 24, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}
        >
          Add your API key
        </h2>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 16 }}>
          Get your key at console.anthropic.com → API keys
        </p>
        {apiKeyField}
        {validationStatus}
        {validated && (
          <div style={{ marginBottom: 12 }}>
            <label
              htmlFor="anthropic-model"
              style={{
                display: 'block',
                fontSize: 11,
                fontWeight: 500,
                color: 'var(--text-secondary)',
                marginBottom: 4,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              Model
            </label>
            <select
              id="anthropic-model"
              value={selectedModel}
              onChange={(e) => onModelChange(e.target.value)}
              style={{
                width: '100%',
                height: 36,
                padding: '0 12px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-subtle)',
                backgroundColor: 'var(--bg-elevated)',
                color: 'var(--text-primary)',
                fontSize: 13,
                outline: 'none',
              }}
            >
              <option value="claude-sonnet-4-20250514">claude-sonnet-4-20250514</option>
              <option value="claude-opus-4-7">claude-opus-4-7</option>
              <option value="claude-haiku-4-5-20251001">claude-haiku-4-5-20251001</option>
            </select>
          </div>
        )}
        {footer}
      </div>
    );
  }

  if (provider === 'openai') {
    return (
      <div>
        <h2
          style={{ fontSize: 24, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}
        >
          Add your API key
        </h2>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 16 }}>
          Get your key at platform.openai.com → API keys
        </p>
        {apiKeyField}
        {validationStatus}
        {validated && (
          <div style={{ marginBottom: 12 }}>
            <label
              htmlFor="openai-model"
              style={{
                display: 'block',
                fontSize: 11,
                fontWeight: 500,
                color: 'var(--text-secondary)',
                marginBottom: 4,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              Model
            </label>
            <select
              id="openai-model"
              value={selectedModel}
              onChange={(e) => onModelChange(e.target.value)}
              style={{
                width: '100%',
                height: 36,
                padding: '0 12px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-subtle)',
                backgroundColor: 'var(--bg-elevated)',
                color: 'var(--text-primary)',
                fontSize: 13,
                outline: 'none',
              }}
            >
              <option value="gpt-4o">gpt-4o</option>
              <option value="gpt-4o-mini">gpt-4o-mini</option>
              <option value="o3">o3</option>
            </select>
          </div>
        )}
        {footer}
      </div>
    );
  }

  if (provider === 'openrouter') {
    return (
      <div>
        <h2
          style={{ fontSize: 24, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}
        >
          Add your API key
        </h2>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 16 }}>
          Get your key at openrouter.ai/keys
        </p>
        {apiKeyField}
        {validationStatus}
        {validated && (
          <div style={{ marginBottom: 12 }}>
            {inputField('Model', selectedModel, onModelChange, {
              placeholder: 'openai/gpt-4o',
              monospace: true,
              id: 'openrouter-model',
            })}
            <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: -4 }}>
              Use any model ID from openrouter.ai/models
            </p>
          </div>
        )}
        {footer}
      </div>
    );
  }

  if (provider === 'azure') {
    return (
      <div>
        <h2
          style={{ fontSize: 24, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}
        >
          Connect Azure OpenAI
        </h2>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 16 }}>
          Enter your Azure OpenAI resource details
        </p>
        {inputField('Resource URL', baseUrl, handleBaseUrlChange, {
          placeholder: 'https://my-resource.openai.azure.com',
          id: 'azure-resource-url',
        })}
        <div style={{ marginBottom: 12 }}>
          <label
            htmlFor="azure-api-key"
            style={{
              display: 'block',
              fontSize: 11,
              fontWeight: 500,
              color: 'var(--text-secondary)',
              marginBottom: 4,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            API Key
          </label>
          <div style={{ position: 'relative' }}>
            <input
              id="azure-api-key"
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => handleApiKeyChange(e.target.value)}
              placeholder="Azure API key"
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
                boxSizing: 'border-box',
                transition: 'border-color var(--motion-fast) var(--ease)',
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
        </div>
        <div style={{ marginBottom: 12 }}>
          <label
            htmlFor="azure-deployment"
            style={{
              display: 'block',
              fontSize: 11,
              fontWeight: 500,
              color: 'var(--text-secondary)',
              marginBottom: 4,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            Deployment Name
          </label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              id="azure-deployment"
              type="text"
              value={deploymentName}
              onChange={(e) => handleDeploymentChange(e.target.value)}
              placeholder="my-gpt4o-deployment"
              style={{
                flex: 1,
                height: 36,
                padding: '0 12px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-subtle)',
                backgroundColor: 'var(--bg-elevated)',
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-mono)',
                fontSize: 13,
                outline: 'none',
                transition: 'border-color var(--motion-fast) var(--ease)',
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
              onClick={validate}
              disabled={isValidateDisabled()}
              style={{
                height: 36,
                padding: '0 16px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-subtle)',
                background: 'transparent',
                color: 'var(--text-primary)',
                fontSize: 14,
                cursor: isValidateDisabled() ? 'not-allowed' : 'pointer',
                opacity: isValidateDisabled() ? 0.6 : 1,
                whiteSpace: 'nowrap',
              }}
            >
              {validationState === 'loading' ? 'Checking...' : 'Validate'}
            </button>
          </div>
        </div>
        {validationStatus}
        {validated && (
          <p style={{ fontSize: 12, color: 'var(--success)', marginBottom: 12 }}>
            Connected — deployment "{deploymentName}" is ready ✓
          </p>
        )}
        {footer}
      </div>
    );
  }

  return null;
}

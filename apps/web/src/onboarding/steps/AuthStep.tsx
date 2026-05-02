import type { ProviderId } from '@ethosagent/web-contracts';
import { Button, Input } from 'antd';
import { useState } from 'react';
import { rpc } from '../../rpc';
import { type CatalogProviderId, getCatalogEntry } from '../catalog/providers';
import type { WizardAnswers } from '../reducer';

type ValidateStatus = 'idle' | 'validating' | 'ok' | 'error';

export function AuthStep({
  answers,
  onNext,
}: {
  answers: WizardAnswers;
  onNext: (patch: Partial<WizardAnswers>) => void;
}) {
  const providerId = (answers.provider as CatalogProviderId | undefined) ?? 'anthropic';
  const catalog = getCatalogEntry(providerId);

  const [apiKey, setApiKey] = useState(answers.apiKey ?? '');
  const [baseUrl, setBaseUrl] = useState(answers.baseUrl ?? catalog.baseUrl?.default ?? '');
  const [status, setStatus] = useState<ValidateStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [modelCount, setModelCount] = useState<number | null>(null);
  const [models, setModels] = useState<string[]>(answers.models ?? []);

  const isKeyless = catalog.baseUrl?.keyless === true;
  const hasBaseUrl = !!catalog.baseUrl;
  const baseUrlRequired = catalog.baseUrl?.required === true;

  const canValidate = isKeyless
    ? !hasBaseUrl || baseUrl.length > 0
    : apiKey.length > 0 && (!baseUrlRequired || baseUrl.length > 0);

  const validate = async () => {
    setStatus('validating');
    setError(null);
    try {
      const result = await rpc.onboarding.validateProvider({
        provider: catalog.wiresAs as ProviderId,
        apiKey: isKeyless ? 'no-key' : apiKey,
        ...(baseUrl ? { baseUrl } : {}),
      });
      if (!result.ok) {
        setStatus('error');
        setError(result.error ?? 'Validation failed.');
        return;
      }
      const ms = result.models ?? [];
      setModels(ms);
      setModelCount(ms.length);
      setStatus('ok');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleContinue = () => {
    onNext({
      apiKey: isKeyless ? 'no-key' : apiKey,
      baseUrl: baseUrl || undefined,
      models,
      // Clear model so ModelStep forces a pick
      model: undefined,
    });
  };

  return (
    <section className="onboarding-step-content">
      <h1 className="onboarding-headline">
        {isKeyless ? `Set your ${catalog.label} URL.` : `Add your ${catalog.label} API key.`}
      </h1>

      {catalog.signupUrl ? (
        <a
          href={catalog.signupUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="onboarding-signup-link"
        >
          Get an API key from {catalog.label} →
        </a>
      ) : null}

      {!isKeyless ? (
        <div className="onboarding-field">
          <label htmlFor="onboarding-key" className="onboarding-field-label">
            API KEY
          </label>
          <Input.Password
            id="onboarding-key"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setStatus('idle');
            }}
            placeholder={providerId === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
            autoComplete="off"
          />
        </div>
      ) : null}

      {hasBaseUrl ? (
        <div className="onboarding-field">
          <label htmlFor="onboarding-baseurl" className="onboarding-field-label">
            {isKeyless ? 'BASE URL' : `${catalog.label.toUpperCase()} API URL`}
          </label>
          <Input
            id="onboarding-baseurl"
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value);
              setStatus('idle');
            }}
            placeholder={catalog.baseUrl?.default ?? 'https://api.example.com/v1'}
            autoComplete="off"
            suffix={
              catalog.baseUrl?.default && baseUrl !== catalog.baseUrl.default && baseUrl ? (
                <button
                  type="button"
                  className="onboarding-reset-default"
                  onClick={() => setBaseUrl(catalog.baseUrl?.default ?? '')}
                >
                  Reset
                </button>
              ) : null
            }
          />
        </div>
      ) : null}

      {status === 'ok' ? (
        <div className="onboarding-validate-success">
          ✓{' '}
          {modelCount !== null
            ? `${modelCount} model${modelCount !== 1 ? 's' : ''} available`
            : 'Connected'}
        </div>
      ) : null}

      {status === 'error' && error ? (
        <div className="onboarding-error" role="alert">
          ✕ {error}
        </div>
      ) : null}

      <div className="onboarding-actions">
        {status !== 'ok' ? (
          <Button
            type="primary"
            onClick={() => void validate()}
            loading={status === 'validating'}
            disabled={!canValidate}
          >
            Validate
          </Button>
        ) : (
          <Button type="primary" onClick={handleContinue}>
            Continue
          </Button>
        )}
      </div>
    </section>
  );
}

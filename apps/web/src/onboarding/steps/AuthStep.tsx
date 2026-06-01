import type { ProviderId } from '@ethosagent/web-contracts';
import { Button, Input } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { rpc } from '../../rpc';
import {
  type CatalogProviderId,
  getCatalogEntry,
  type ProviderCatalogEntry,
} from '../catalog/providers';
import type { WizardAnswers } from '../reducer';

type ValidateStatus = 'idle' | 'validating' | 'ok' | 'error';

// ---------------------------------------------------------------------------
// DeviceAuthFlow — handles Codex device auth
// ---------------------------------------------------------------------------

type DeviceAuthState =
  | { phase: 'loading' }
  | { phase: 'awaiting_code'; userCode: string; sessionToken: string }
  | { phase: 'authorized' }
  | { phase: 'error'; message: string };

function DeviceAuthFlow({
  catalog,
  onNext,
}: {
  catalog: ProviderCatalogEntry;
  onNext: (patch: Partial<WizardAnswers>) => void;
}) {
  const [state, setState] = useState<DeviceAuthState>({ phase: 'loading' });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function clearPoll() {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }

  async function startDeviceAuth() {
    setState({ phase: 'loading' });
    clearPoll();
    try {
      const res = await fetch('/auth/codex/device-code', { method: 'POST' });
      const data = (await res.json()) as {
        ok: boolean;
        userCode?: string;
        sessionToken?: string;
        error?: string;
      };
      if (!data.ok || !data.userCode || !data.sessionToken) {
        setState({ phase: 'error', message: data.error ?? 'Failed to start device auth.' });
        return;
      }
      setState({
        phase: 'awaiting_code',
        userCode: data.userCode,
        sessionToken: data.sessionToken,
      });

      intervalRef.current = setInterval(() => {
        void (async () => {
          try {
            const statusRes = await fetch(
              `/auth/codex/status?session=${encodeURIComponent(data.sessionToken ?? '')}`,
            );
            const statusData = (await statusRes.json()) as {
              ok: boolean;
              authorized?: boolean;
              error?: string;
            };
            if (!statusData.ok && statusData.error) {
              clearPoll();
              setState({ phase: 'error', message: statusData.error });
              return;
            }
            if (statusData.authorized) {
              clearPoll();
              setState({ phase: 'authorized' });
              onNext({ apiKey: '', models: [] });
            }
          } catch (err) {
            clearPoll();
            setState({
              phase: 'error',
              message: err instanceof Error ? err.message : 'Status check failed.',
            });
          }
        })();
      }, 4_000);
    } catch (err) {
      setState({
        phase: 'error',
        message: err instanceof Error ? err.message : 'Failed to start device auth.',
      });
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional mount-only effect
  useEffect(() => {
    void startDeviceAuth();
    return () => clearPoll();
  }, []);

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // ignore
    }
  }

  return (
    <section className="onboarding-step-content">
      <h1 className="onboarding-headline">Connect your {catalog.label} account.</h1>

      {state.phase === 'loading' && (
        <div className="onboarding-validate-success">Requesting device code…</div>
      )}

      {state.phase === 'awaiting_code' && (
        <div>
          <p style={{ marginBottom: 12 }}>
            1.{' '}
            <a
              href="https://auth.openai.com/codex/device"
              target="_blank"
              rel="noopener noreferrer"
              className="onboarding-signup-link"
            >
              Open: https://auth.openai.com/codex/device
            </a>
          </p>
          <p style={{ marginBottom: 16 }}>
            2. Enter this code:{' '}
            <strong
              style={{
                fontFamily: 'monospace',
                fontSize: '1.2em',
                letterSpacing: '0.1em',
              }}
            >
              {state.userCode}
            </strong>{' '}
            <button
              type="button"
              className="onboarding-reset-default"
              onClick={() => void copyCode(state.userCode)}
            >
              Copy
            </button>
          </p>
          <div className="onboarding-validate-success">Waiting for authorization…</div>
        </div>
      )}

      {state.phase === 'authorized' && (
        <div className="onboarding-validate-success">✓ Authorized</div>
      )}

      {state.phase === 'error' && (
        <div>
          <div className="onboarding-error" role="alert">
            ✕ {state.message}
          </div>
          <div className="onboarding-actions" style={{ marginTop: 12 }}>
            <Button type="primary" onClick={() => void startDeviceAuth()}>
              Retry
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

export function AuthStep({
  answers,
  onNext,
}: {
  answers: WizardAnswers;
  onNext: (patch: Partial<WizardAnswers>) => void;
}) {
  const providerId = (answers.provider as CatalogProviderId | undefined) ?? 'anthropic';
  const catalog = getCatalogEntry(providerId);

  const isDeviceAuth = catalog.authType === 'device-auth';

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

  if (isDeviceAuth) {
    return <DeviceAuthFlow catalog={catalog} onNext={onNext} />;
  }

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

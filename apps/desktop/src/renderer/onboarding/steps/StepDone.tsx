import { useEffect, useState } from 'react';

interface StepDoneProps {
  provider: string;
  personalityId: string;
  personalityName: string;
  apiKey: string;
  model: string;
  onReady: () => void;
}

type HealthState = 'starting' | 'ready' | 'error';

export function StepDone({
  provider,
  personalityId,
  personalityName,
  apiKey,
  model,
  onReady,
}: StepDoneProps) {
  const [healthState, setHealthState] = useState<HealthState>('starting');
  const [dots, setDots] = useState('');
  const [retryCount, setRetryCount] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryCount triggers re-execution on retry
  useEffect(() => {
    let healthInterval: ReturnType<typeof setInterval> | null = null;
    let dotsInterval: ReturnType<typeof setInterval> | null = null;
    let elapsed = 0;

    async function start() {
      await window.ethos.onboarding.complete({ provider, model, apiKey, personalityId });

      const port = 3001;
      await window.ethos.backend.start({ port });
      healthInterval = setInterval(async () => {
        elapsed += 500;
        const { healthy } = await window.ethos.health.check({ port });
        if (healthy) {
          setHealthState('ready');
          if (healthInterval) clearInterval(healthInterval);
        } else if (elapsed >= 90000) {
          setHealthState('error');
          if (healthInterval) clearInterval(healthInterval);
        }
      }, 500);
    }

    start();

    dotsInterval = setInterval(() => {
      setDots((d) => (d.length >= 3 ? '' : `${d}.`));
    }, 400);

    return () => {
      if (healthInterval) clearInterval(healthInterval);
      if (dotsInterval) clearInterval(dotsInterval);
    };
  }, [retryCount, provider, model, apiKey, personalityId]);

  function retry() {
    setHealthState('starting');
    setRetryCount((c) => c + 1);
  }

  const providerLabel =
    provider === 'anthropic'
      ? 'Anthropic'
      : provider === 'openai'
        ? 'OpenAI'
        : provider === 'openrouter'
          ? 'OpenRouter'
          : 'Azure OpenAI';

  return (
    <div>
      <h2 style={{ fontSize: 24, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>
        You're all set
      </h2>
      <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 24 }}>
        {providerLabel} · {personalityName}
      </p>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, marginBottom: 24 }}>
        {healthState === 'starting' && (
          <span style={{ color: 'var(--text-tertiary)' }}>Starting Ethos{dots}</span>
        )}
        {healthState === 'ready' && <span style={{ color: 'var(--success)' }}>Ready ✓</span>}
        {healthState === 'error' && (
          <span style={{ color: 'var(--error)' }}>
            Could not start Ethos. Please restart the app.{' '}
            <button
              type="button"
              onClick={retry}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-secondary)',
                textDecoration: 'underline',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: 'inherit',
              }}
            >
              Retry
            </button>
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={onReady}
        disabled={healthState !== 'ready'}
        style={{
          height: 36,
          minWidth: 140,
          padding: '0 24px',
          borderRadius: 'var(--radius-sm)',
          border: 'none',
          backgroundColor: healthState === 'ready' ? 'var(--text-primary)' : 'var(--border-subtle)',
          color: healthState === 'ready' ? 'var(--bg-base)' : 'var(--text-tertiary)',
          fontSize: 14,
          fontWeight: 500,
          cursor: healthState === 'ready' ? 'pointer' : 'not-allowed',
          transition: `background-color var(--motion-fast) var(--ease), color var(--motion-fast) var(--ease)`,
        }}
      >
        Open Ethos
      </button>
    </div>
  );
}

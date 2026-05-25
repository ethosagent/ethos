import { useState } from 'react';
import { StepApiKey } from './steps/StepApiKey';
import { StepDone } from './steps/StepDone';
import { StepPersonality } from './steps/StepPersonality';
import { StepProvider } from './steps/StepProvider';

interface OnboardingShellProps {
  onComplete: () => void;
}

const STEP_LABELS = ['Provider', 'API Key', 'Personality', 'Ready'];

export function OnboardingShell({ onComplete }: OnboardingShellProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [provider, setProvider] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [validated, setValidated] = useState(false);
  const [selectedModel, setSelectedModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [personalityId, setPersonalityId] = useState<string | null>(null);
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');

  function canContinue(): boolean {
    switch (currentStep) {
      case 0:
        return provider !== null;
      case 1:
        return validated && selectedModel.trim().length > 0;
      case 2:
        return personalityId !== null;
      default:
        return false;
    }
  }

  function next() {
    if (!canContinue()) return;
    setDirection('forward');
    setCurrentStep((s) => Math.min(s + 1, 3));
  }

  function back() {
    setDirection('back');
    setCurrentStep((s) => Math.max(s - 1, 0));
  }

  function handleProviderSelect(id: string) {
    setProvider(id);
    setApiKey('');
    setValidated(false);
    setSelectedModel('');
    setBaseUrl('');
  }

  function handleValidated(_modelList: string[]) {
    setValidated(true);
  }

  const personalityName = personalityId
    ? { researcher: 'Researcher', engineer: 'Engineer', operator: 'Assistant', coach: 'Coach' }[
        personalityId
      ] || personalityId
    : '';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        height: '100%',
        padding: '48px 0 32px',
      }}
    >
      {/* Step progress indicator */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 48 }}>
        {STEP_LABELS.map((label, i) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 11,
                  fontWeight: 600,
                  transition: `background-color var(--motion-fast) var(--ease), border-color var(--motion-fast) var(--ease)`,
                  ...(i < currentStep
                    ? { backgroundColor: 'var(--success)', color: '#fff' }
                    : i === currentStep
                      ? { backgroundColor: 'var(--info)', color: '#fff' }
                      : {
                          backgroundColor: 'var(--bg-elevated)',
                          border: '1px solid var(--border-subtle)',
                          color: 'var(--text-secondary)',
                        }),
                }}
              >
                {i < currentStep ? '✓' : i + 1}
              </div>
              <span
                style={{
                  fontSize: 10,
                  color: i === currentStep ? 'var(--info)' : 'var(--text-tertiary)',
                  transition: `color var(--motion-fast) var(--ease)`,
                }}
              >
                {label}
              </span>
            </div>
            {i < STEP_LABELS.length - 1 && (
              <div
                style={{
                  width: 60,
                  height: 1,
                  backgroundColor: 'var(--border-subtle)',
                  margin: '0 8px',
                  marginBottom: 20,
                }}
              />
            )}
          </div>
        ))}
      </div>

      {/* Step content */}
      <div
        style={{
          width: 520,
          flex: 1,
          overflowY: 'auto',
          position: 'relative',
        }}
      >
        <div
          key={currentStep}
          style={{
            animation: `slideIn var(--motion-slow) var(--ease)`,
          }}
        >
          {currentStep === 0 && (
            <StepProvider selectedProvider={provider} onSelectProvider={handleProviderSelect} />
          )}
          {currentStep === 1 && provider && (
            <StepApiKey
              provider={provider}
              apiKey={apiKey}
              baseUrl={baseUrl}
              selectedModel={selectedModel}
              onApiKeyChange={(k) => {
                setApiKey(k);
                setValidated(false);
                setSelectedModel('');
              }}
              onBaseUrlChange={setBaseUrl}
              onModelChange={setSelectedModel}
              onValidated={handleValidated}
            />
          )}
          {currentStep === 2 && (
            <StepPersonality
              selectedPersonalityId={personalityId}
              onSelectPersonality={setPersonalityId}
            />
          )}
          {currentStep === 3 && provider && personalityId && (
            <StepDone
              provider={provider}
              personalityId={personalityId}
              personalityName={personalityName}
              apiKey={apiKey}
              model={selectedModel}
              onReady={onComplete}
            />
          )}
        </div>
      </div>

      {/* Navigation */}
      {currentStep < 3 && (
        <div
          style={{
            width: 520,
            display: 'flex',
            justifyContent: 'space-between',
            paddingTop: 24,
          }}
        >
          <button
            type="button"
            onClick={back}
            disabled={currentStep === 0}
            style={{
              height: 36,
              padding: '0 16px',
              borderRadius: 'var(--radius-sm)',
              border: 'none',
              background: 'transparent',
              color: currentStep === 0 ? 'var(--text-tertiary)' : 'var(--text-secondary)',
              fontSize: 14,
              cursor: currentStep === 0 ? 'default' : 'pointer',
            }}
          >
            Back
          </button>
          <button
            type="button"
            onClick={next}
            disabled={!canContinue()}
            style={{
              height: 36,
              padding: '0 24px',
              borderRadius: 'var(--radius-sm)',
              border: 'none',
              backgroundColor: canContinue() ? 'var(--text-primary)' : 'var(--border-subtle)',
              color: canContinue() ? 'var(--bg-base)' : 'var(--text-tertiary)',
              fontSize: 14,
              fontWeight: 500,
              cursor: canContinue() ? 'pointer' : 'not-allowed',
              transition: `background-color var(--motion-fast) var(--ease), color var(--motion-fast) var(--ease)`,
            }}
          >
            Continue
          </button>
        </div>
      )}

      <style>{`
        @keyframes slideIn {
          from { opacity: 0; transform: translateX(${direction === 'forward' ? '20px' : '-20px'}); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}

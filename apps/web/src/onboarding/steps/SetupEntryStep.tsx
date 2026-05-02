import { Button } from 'antd';
import { useState } from 'react';
import type { WizardAnswers, WizardMode } from '../reducer';

export function SetupEntryStep({ onNext }: { onNext: (patch: Partial<WizardAnswers>) => void }) {
  const [mode, setMode] = useState<WizardMode>('quick');

  return (
    <section className="onboarding-step-content">
      <h1 className="onboarding-headline">How would you like to set up Ethos?</h1>

      <div className="onboarding-mode-options">
        {(
          [
            {
              value: 'quick' as WizardMode,
              label: 'Quick setup',
              tag: 'recommended',
              hint: 'Provider · API key · Model · Personality · Messaging. Done in under 2 minutes.',
            },
            {
              value: 'full' as WizardMode,
              label: 'Full setup',
              hint: 'Adds provider failover chains, key rotation pools, memory backend, and daemon configuration.',
            },
          ] as const
        ).map((opt) => (
          <label
            key={opt.value}
            className={`onboarding-mode-option${mode === opt.value ? ' active' : ''}`}
          >
            <input
              type="radio"
              name="mode"
              value={opt.value}
              checked={mode === opt.value}
              onChange={() => setMode(opt.value)}
            />
            <div className="onboarding-mode-option-body">
              <span className="onboarding-mode-option-name">
                {opt.label}
                {'tag' in opt ? (
                  <span className="onboarding-recommended-tag">{opt.tag}</span>
                ) : null}
              </span>
              <span className="onboarding-mode-option-hint">{opt.hint}</span>
            </div>
          </label>
        ))}
      </div>

      <div className="onboarding-actions">
        <Button type="primary" onClick={() => onNext({ mode })}>
          Continue
        </Button>
      </div>
    </section>
  );
}

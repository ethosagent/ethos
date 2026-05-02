import { Button } from 'antd';
import { useState } from 'react';
import type { WizardAnswers } from '../reducer';

export function MemoryStep({
  onNext,
  onBack,
}: {
  answers: WizardAnswers;
  onNext: (patch: Partial<WizardAnswers>) => void;
  onBack: () => void;
}) {
  const [backend, setBackend] = useState<'markdown' | 'vector'>('markdown');

  return (
    <section className="onboarding-step-content">
      <h1 className="onboarding-headline">Choose a memory backend.</h1>
      <p className="onboarding-supporting">
        Markdown keeps notes in plain files you can edit. Vector adds semantic search over longer
        history.
      </p>

      <div className="onboarding-mode-options">
        {(
          [
            {
              value: 'markdown' as const,
              label: 'Markdown',
              hint: 'Plain files in ~/.ethos/. Easy to inspect and edit.',
            },
            {
              value: 'vector' as const,
              label: 'Vector (coming soon)',
              hint: 'Semantic search over longer history. Requires a local embedding model.',
            },
          ] as const
        ).map((opt) => (
          <label
            key={opt.value}
            className={`onboarding-mode-option${backend === opt.value ? ' active' : ''}`}
          >
            <input
              type="radio"
              name="memory-backend"
              value={opt.value}
              checked={backend === opt.value}
              disabled={opt.value === 'vector'}
              onChange={() => setBackend(opt.value)}
            />
            <div className="onboarding-mode-option-body">
              <span className="onboarding-mode-option-name">{opt.label}</span>
              <span className="onboarding-mode-option-hint">{opt.hint}</span>
            </div>
          </label>
        ))}
      </div>

      <div className="onboarding-actions">
        <Button onClick={onBack}>Back</Button>
        <Button type="primary" onClick={() => onNext({ memoryBackend: backend })}>
          Continue
        </Button>
      </div>
    </section>
  );
}

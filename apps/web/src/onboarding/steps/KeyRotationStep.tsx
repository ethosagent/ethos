import { Button } from 'antd';
import type { WizardAnswers } from '../reducer';

export function KeyRotationStep({
  onNext,
  onBack,
}: {
  answers: WizardAnswers;
  onNext: (patch: Partial<WizardAnswers>) => void;
  onBack: () => void;
}) {
  return (
    <section className="onboarding-step-content">
      <h1 className="onboarding-headline">Set up key rotation.</h1>
      <p className="onboarding-supporting">
        Add a pool of API keys per provider. The agent rotates through them to stay within per-key
        rate limits.
      </p>
      <p className="onboarding-supporting" style={{ opacity: 0.6 }}>
        Full-mode feature — add keys to ~/.ethos/config.yaml after setup, or skip to continue.
      </p>
      <div className="onboarding-actions">
        <Button onClick={onBack}>Back</Button>
        <Button type="primary" onClick={() => onNext({})}>
          Skip for now
        </Button>
      </div>
    </section>
  );
}

import { Button } from 'antd';
import type { WizardAnswers } from '../reducer';

export function MultiProviderStep({
  onNext,
  onBack,
}: {
  answers: WizardAnswers;
  onNext: (patch: Partial<WizardAnswers>) => void;
  onBack: () => void;
}) {
  return (
    <section className="onboarding-step-content">
      <h1 className="onboarding-headline">Configure provider failover.</h1>
      <p className="onboarding-supporting">
        Chain multiple providers so the agent falls back automatically when one fails or hits its
        rate limit.
      </p>
      <p className="onboarding-supporting" style={{ opacity: 0.6 }}>
        Full-mode feature — configure providers in ~/.ethos/config.yaml after setup, or skip to
        continue.
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

import { Button } from 'antd';
import { useState } from 'react';
import {
  type CatalogProviderId,
  DEVICE_AUTH_PROVIDERS,
  EXPANDED_PROVIDERS,
  RECOMMENDED_PROVIDERS,
  SELF_HOSTED_PROVIDERS,
} from '../catalog/providers';
import type { WizardAnswers } from '../reducer';

export function ProviderStep({
  answers,
  onNext,
}: {
  answers: WizardAnswers;
  onNext: (patch: Partial<WizardAnswers>) => void;
}) {
  const [selected, setSelected] = useState<CatalogProviderId>(
    (answers.provider as CatalogProviderId | undefined) ?? 'anthropic',
  );
  const [expanded, setExpanded] = useState(false);

  const apiKeyProviders = [...RECOMMENDED_PROVIDERS, ...(expanded ? EXPANDED_PROVIDERS : [])];

  return (
    <section className="onboarding-step-content">
      <h1 className="onboarding-headline">Pick a model API.</h1>
      <p className="onboarding-supporting">We'll validate your credentials before moving on.</p>

      <div className="onboarding-provider-groups">
        <div className="onboarding-section-label">API KEY</div>
        <div className="onboarding-providers">
          {apiKeyProviders.map((p) => (
            <ProviderRow
              key={p.id}
              id={p.id}
              label={p.label}
              description={p.description}
              recommended={p.recommended}
              selected={selected === p.id}
              onSelect={() => setSelected(p.id)}
            />
          ))}
        </div>
        {!expanded && EXPANDED_PROVIDERS.length > 0 ? (
          <button type="button" className="onboarding-expand-btn" onClick={() => setExpanded(true)}>
            ▾ Show all providers ({EXPANDED_PROVIDERS.length})
          </button>
        ) : null}

        {DEVICE_AUTH_PROVIDERS.length > 0 && (
          <>
            <div className="onboarding-section-label" style={{ marginTop: 16 }}>
              CHATGPT SUBSCRIPTION
            </div>
            <div className="onboarding-providers">
              {DEVICE_AUTH_PROVIDERS.map((p) => (
                <ProviderRow
                  key={p.id}
                  id={p.id}
                  label={p.label}
                  description={p.description}
                  selected={selected === p.id}
                  onSelect={() => setSelected(p.id)}
                />
              ))}
            </div>
          </>
        )}

        <div className="onboarding-section-label" style={{ marginTop: 16 }}>
          SELF-HOSTED
        </div>
        <div className="onboarding-providers">
          {SELF_HOSTED_PROVIDERS.map((p) => (
            <ProviderRow
              key={p.id}
              id={p.id}
              label={p.label}
              description={p.description}
              selected={selected === p.id}
              onSelect={() => setSelected(p.id)}
            />
          ))}
        </div>
      </div>

      <div className="onboarding-actions">
        <Button
          type="primary"
          onClick={() => onNext({ provider: selected as WizardAnswers['provider'] })}
        >
          Continue
        </Button>
      </div>
    </section>
  );
}

function ProviderRow({
  id,
  label,
  description,
  recommended,
  selected,
  onSelect,
}: {
  id: CatalogProviderId;
  label: string;
  description: string;
  recommended?: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <label className={`onboarding-provider${selected ? ' active' : ''}`}>
      <input type="radio" name="provider" value={id} checked={selected} onChange={onSelect} />
      <span className="onboarding-provider-name-row">
        <span className="onboarding-provider-label">{label}</span>
        {recommended ? <span className="onboarding-recommended-tag">recommended</span> : null}
      </span>
      <span className="onboarding-provider-hint">{description}</span>
    </label>
  );
}

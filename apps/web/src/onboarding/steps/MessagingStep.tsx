import type { PlatformId } from '@ethosagent/web-contracts';
import { useMutation } from '@tanstack/react-query';
import { Button, Input } from 'antd';
import { useState } from 'react';
import { rpc } from '../../rpc';
import type { WizardAnswers } from '../reducer';

type SetupChoice = 'setup' | 'skip';

interface PlatformShape {
  id: PlatformId;
  label: string;
  fields: Array<{ name: string; label: string; placeholder?: string; secret: boolean }>;
  deepLink?: { label: string; url: string };
}

const PLATFORMS: PlatformShape[] = [
  {
    id: 'telegram',
    label: 'Telegram',
    fields: [{ name: 'token', label: 'Bot token', placeholder: '123456:ABC-DEF…', secret: true }],
    deepLink: { label: 'Open BotFather', url: 'https://t.me/BotFather' },
  },
  {
    id: 'discord',
    label: 'Discord',
    fields: [{ name: 'token', label: 'Bot token', secret: true }],
    deepLink: {
      label: 'Open Discord Developer Portal',
      url: 'https://discord.com/developers/applications',
    },
  },
  {
    id: 'slack',
    label: 'Slack',
    fields: [
      { name: 'botToken', label: 'Bot token', placeholder: 'xoxb-…', secret: true },
      { name: 'appToken', label: 'App token', placeholder: 'xapp-…', secret: true },
      { name: 'signingSecret', label: 'Signing secret', secret: true },
    ],
    deepLink: { label: 'Open Slack API Apps', url: 'https://api.slack.com/apps' },
  },
  {
    id: 'email',
    label: 'Email',
    fields: [
      { name: 'imapHost', label: 'IMAP host', placeholder: 'imap.example.com', secret: false },
      { name: 'imapPort', label: 'IMAP port', placeholder: '993', secret: false },
      { name: 'user', label: 'Email address', secret: false },
      { name: 'password', label: 'Password', secret: true },
      { name: 'smtpHost', label: 'SMTP host', placeholder: 'smtp.example.com', secret: false },
      { name: 'smtpPort', label: 'SMTP port', placeholder: '587', secret: false },
    ],
  },
];

export function MessagingStep({
  answers,
  onNext,
}: {
  answers: WizardAnswers;
  onNext: (patch: Partial<WizardAnswers>) => void;
}) {
  const existingMessaging = answers.messaging;
  const [choice, setChoice] = useState<SetupChoice>(
    existingMessaging && !('skipped' in existingMessaging) ? 'setup' : 'skip',
  );
  const [platformId, setPlatformId] = useState<PlatformId>('telegram');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  const foundPlatform = PLATFORMS.find((p) => p.id === platformId);
  const platform = foundPlatform ??
    PLATFORMS[0] ?? { id: 'telegram' as PlatformId, label: 'Telegram', fields: [] };

  const saveMut = useMutation({
    mutationFn: () => rpc.platforms.set({ id: platformId, fields }),
    onSuccess: () => setSaved(true),
  });

  const handleContinue = () => {
    if (choice === 'skip') {
      onNext({ messaging: { skipped: true } });
    } else {
      onNext({ messaging: { platform: platformId, fields } });
    }
  };

  return (
    <section className="onboarding-step-content">
      <h1 className="onboarding-headline">Set up messaging.</h1>
      <p className="onboarding-supporting">
        Connect a platform so your agent can reach you outside the browser.
      </p>

      <div className="onboarding-mode-options" style={{ marginBottom: 16 }}>
        {(
          [
            { value: 'setup' as SetupChoice, label: 'Set up now' },
            { value: 'skip' as SetupChoice, label: 'Skip — chat in your browser' },
          ] as const
        ).map((opt) => (
          <label
            key={opt.value}
            className={`onboarding-mode-option${choice === opt.value ? ' active' : ''}`}
          >
            <input
              type="radio"
              name="messaging-choice"
              value={opt.value}
              checked={choice === opt.value}
              onChange={() => {
                setChoice(opt.value);
                setSaved(false);
              }}
            />
            <div className="onboarding-mode-option-body">
              <span className="onboarding-mode-option-name">{opt.label}</span>
            </div>
          </label>
        ))}
      </div>

      {choice === 'setup' ? (
        <>
          <div className="onboarding-section-label">PLATFORM</div>
          <div className="onboarding-providers" style={{ marginBottom: 16 }}>
            {PLATFORMS.map((p) => (
              <label
                key={p.id}
                className={`onboarding-provider${platformId === p.id ? ' active' : ''}`}
                style={{ gridTemplateColumns: '16px 1fr' }}
              >
                <input
                  type="radio"
                  name="platform"
                  value={p.id}
                  checked={platformId === p.id}
                  onChange={() => {
                    setPlatformId(p.id);
                    setFields({});
                    setSaved(false);
                  }}
                />
                <span className="onboarding-provider-label">{p.label}</span>
              </label>
            ))}
          </div>

          {platform.deepLink ? (
            <a
              href={platform.deepLink.url}
              target="_blank"
              rel="noopener noreferrer"
              className="onboarding-signup-link"
              style={{ marginBottom: 12, display: 'inline-block' }}
            >
              {platform.deepLink.label} →
            </a>
          ) : null}

          {platform.fields.map((f) => (
            <div key={f.name} className="onboarding-field">
              <label htmlFor={`msg-${f.name}`} className="onboarding-field-label">
                {f.label.toUpperCase()}
              </label>
              {f.secret ? (
                <Input.Password
                  id={`msg-${f.name}`}
                  value={fields[f.name] ?? ''}
                  onChange={(e) => {
                    setFields((prev) => ({ ...prev, [f.name]: e.target.value }));
                    setSaved(false);
                  }}
                  placeholder={f.placeholder}
                  autoComplete="off"
                />
              ) : (
                <Input
                  id={`msg-${f.name}`}
                  value={fields[f.name] ?? ''}
                  onChange={(e) => {
                    setFields((prev) => ({ ...prev, [f.name]: e.target.value }));
                    setSaved(false);
                  }}
                  placeholder={f.placeholder}
                  autoComplete="off"
                />
              )}
            </div>
          ))}

          {saved ? <div className="onboarding-validate-success">✓ Credentials saved</div> : null}
          {saveMut.isError ? (
            <div className="onboarding-error" role="alert">
              {saveMut.error instanceof Error ? saveMut.error.message : 'Save failed.'}
            </div>
          ) : null}

          <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button
              onClick={() => void saveMut.mutateAsync()}
              loading={saveMut.isPending}
              disabled={platform.fields.some((f) => !fields[f.name]?.trim())}
            >
              Save credentials
            </Button>
          </div>
        </>
      ) : null}

      <div className="onboarding-actions">
        <Button type="primary" onClick={handleContinue} disabled={choice === 'setup' && !saved}>
          Continue
        </Button>
      </div>
    </section>
  );
}

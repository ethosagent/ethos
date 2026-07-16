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

// Five-state machine (W2.1): idle → pending → ok | rejected | unreachable.
// `email-saved` is the probe-less exception. Only `ok`, `unreachable`, and
// `email-saved` unlock Continue; a definitively `rejected` token never saves.
type ProbeResult =
  | { status: 'ok'; label: string | null }
  | { status: 'rejected'; error: string | null }
  | { status: 'unreachable' }
  | { status: 'email-saved' };

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

  const foundPlatform = PLATFORMS.find((p) => p.id === platformId);
  const platform = foundPlatform ??
    PLATFORMS[0] ?? { id: 'telegram' as PlatformId, label: 'Telegram', fields: [] };
  const isEmail = platformId === 'email';

  const runMut = useMutation<ProbeResult, Error, void>({
    mutationFn: async (): Promise<ProbeResult> => {
      if (isEmail) {
        await rpc.platforms.set({ id: platformId, fields });
        return { status: 'email-saved' };
      }
      const verdict = await rpc.platforms.validate({ id: platformId, fields });
      // A definitively rejected token must never reach config — do not save.
      if (verdict.status === 'rejected') {
        return { status: 'rejected', error: verdict.error };
      }
      // ok or unreachable (W1.2 liveness) — persist and continue.
      await rpc.platforms.set({ id: platformId, fields });
      return verdict.status === 'ok'
        ? { status: 'ok', label: verdict.label }
        : { status: 'unreachable' };
    },
  });

  const result = runMut.data ?? null;
  const missingFields = platform.fields.some((f) => !fields[f.name]?.trim());
  const canContinue =
    choice === 'skip' ||
    result?.status === 'ok' ||
    result?.status === 'unreachable' ||
    result?.status === 'email-saved';

  const resetResult = () => runMut.reset();

  const handleContinue = () => {
    if (choice === 'skip') {
      onNext({ messaging: { skipped: true } });
    } else {
      onNext({ messaging: { platform: platformId, fields } });
    }
  };

  const disabledReason =
    choice === 'setup' && !canContinue
      ? result?.status === 'rejected'
        ? 'Token rejected — re-enter to continue.'
        : `Validate the ${platform.label} token to continue.`
      : null;

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
                resetResult();
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
                    resetResult();
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
                    resetResult();
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
                    resetResult();
                  }}
                  placeholder={f.placeholder}
                  autoComplete="off"
                />
              )}
            </div>
          ))}

          <div className="onboarding-messaging-result" aria-live="polite">
            {result?.status === 'ok' ? (
              <div className="onboarding-validate-success">
                ✓ Connected
                {result.label ? (
                  <>
                    {' · '}
                    <code>{result.label}</code>
                  </>
                ) : null}
              </div>
            ) : null}
            {result?.status === 'email-saved' ? (
              <div className="onboarding-validate-success">✓ Saved</div>
            ) : null}
            {result?.status === 'unreachable' ? (
              <div className="onboarding-warning" role="status">
                Couldn't reach {platform.label} — saved unverified.
              </div>
            ) : null}
            {result?.status === 'rejected' ? (
              <div className="onboarding-error" role="alert">
                Token rejected by {platform.label} — re-enter to continue.
              </div>
            ) : null}
            {runMut.isError ? (
              <div className="onboarding-error" role="alert">
                {runMut.error instanceof Error ? runMut.error.message : 'Validation failed.'}
              </div>
            ) : null}
          </div>

          <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button
              onClick={() => void runMut.mutateAsync().catch(() => {})}
              loading={runMut.isPending}
              disabled={missingFields}
            >
              {isEmail ? 'Save' : 'Validate & save'}
            </Button>
          </div>
        </>
      ) : null}

      <div className="onboarding-actions">
        <Button
          type="primary"
          onClick={handleContinue}
          disabled={!canContinue}
          aria-disabled={!canContinue}
        >
          Continue
        </Button>
        {disabledReason ? (
          <span className="onboarding-disabled-reason" aria-live="polite">
            {disabledReason}
          </span>
        ) : null}
      </div>
    </section>
  );
}

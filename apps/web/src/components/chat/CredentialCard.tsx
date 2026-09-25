import type { CredentialRequiredEvent } from '@ethosagent/web-contracts';
import { Button, Input } from 'antd';
import { useState } from 'react';
import { rpc } from '../../rpc';

// openclaw-9.5 item 1 — the masked credential prompt. The last turn was refused
// pre-turn because `request.pluginId` is missing `request.credentialKey`
// (`credential_required`, see `ChatService.send`'s `credentialPrompt: true`).
//
// Where the typed value may live: this component's local state, and the one
// `plugins.setCredential` call (→ `PluginLoader.setCredential`, the single
// writer). It is never dispatched into the chat reducer, never put in a URL or
// browser storage, never logged, and the field is emptied the moment Save is
// pressed — before the round trip, so a failure means retyping, not a secret
// sitting in state. Only after the store succeeds is `pendingUserMessage`
// resent through the normal send path; a refused store (e.g. `Plugin "<id>" is
// not loaded`) shows its error and resends nothing. Pinned by
// `apps/web/src/components/chat/__tests__/credential-card.test.ts`.

export interface SubmitCredentialDeps {
  setCredential: (input: { pluginId: string; key: string; value: string }) => Promise<unknown>;
  resend: (text: string) => Promise<void>;
}

/** Store the value, then resend. Returns the error text on failure, else null. */
export async function submitCredential(
  request: CredentialRequiredEvent,
  value: string,
  deps: SubmitCredentialDeps,
): Promise<string | null> {
  try {
    await deps.setCredential({
      pluginId: request.pluginId,
      key: request.credentialKey,
      value,
    });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  await deps.resend(request.pendingUserMessage);
  return null;
}

export interface CredentialCardProps {
  request: CredentialRequiredEvent;
  /** Resend the refused message through the chat's normal send path. */
  resend: (text: string) => Promise<void>;
  onDismiss: () => void;
}

export function CredentialCard({ request, resend, onDismiss }: CredentialCardProps) {
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const onSubmit = async () => {
    // Trimmed like the Plugins page's own credential row
    // (`PluginSettingsPanel`'s `handleSave`), so a pasted trailing newline is
    // not stored as part of the secret.
    const typed = value.trim();
    if (!typed) return;
    setValue('');
    setSubmitting(true);
    setSubmitError(null);
    const error = await submitCredential(request, typed, {
      setCredential: (input) => rpc.plugins.setCredential(input),
      resend,
    });
    setSubmitting(false);
    if (error !== null) setSubmitError(error);
  };

  return (
    <section className="credential-prompt" aria-labelledby="credential-prompt-title">
      <h2 id="credential-prompt-title" className="credential-prompt-title">
        {request.label}
      </h2>
      <p className="credential-prompt-sub">
        Plugin <code>{request.pluginId}</code> needs <code>{request.credentialKey}</code> before
        this message can run.
      </p>
      {request.description ? <p className="credential-prompt-sub">{request.description}</p> : null}
      {request.authUrl ? (
        <p className="credential-prompt-sub">
          <a href={request.authUrl} target="_blank" rel="noopener noreferrer">
            Open the sign-in page
          </a>
        </p>
      ) : null}
      <form
        className="credential-prompt-form"
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit();
        }}
      >
        <Input
          type="password"
          autoComplete="off"
          aria-label={request.label}
          value={value}
          disabled={submitting}
          placeholder={`Enter ${request.label}`}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button type="primary" htmlType="submit" loading={submitting} disabled={!value.trim()}>
          Save and resend
        </Button>
        <Button disabled={submitting} onClick={onDismiss}>
          Dismiss
        </Button>
      </form>
      {submitError ? (
        <div className="credential-prompt-error" role="alert">
          {submitError}
        </div>
      ) : null}
    </section>
  );
}

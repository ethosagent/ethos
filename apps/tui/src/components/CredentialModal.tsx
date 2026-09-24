// CredentialModal — a plugin needs a credential before this turn can run
// (`credential_required`, plan openclaw-9.5-adoption item 1). Opens over the
// App like ClarifyModal: typed characters render as `•`, Enter stores the
// value and resends the refused message, Esc cancels.
//
// The raw value lives only in this component's `value` state and is cleared
// the moment Enter is pressed. `CredentialPromptView` is handed the MASK, not
// the value, so nothing it renders can contain the secret (pinned by
// `apps/tui/src/__tests__/credential-prompt.test.ts`).

import { Box, Text, useInput } from 'ink';
import { useRef, useState } from 'react';
import {
  type CredentialRequest,
  credentialKeyStep,
  maskValue,
  type SubmitCredentialResult,
} from '../credential-prompt';
import { useSkin } from '../skin';

interface CredentialPromptViewProps {
  request: CredentialRequest;
  /** Already masked — see `maskValue`. The raw value never reaches the view. */
  masked: string;
  error: string | null;
  busy: boolean;
}

export function CredentialPromptView({ request, masked, error, busy }: CredentialPromptViewProps) {
  const tokens = useSkin();
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold color={tokens.semantic.warning}>
        {request.pluginId} needs {request.label}
      </Text>
      {request.description ? (
        <Text color={tokens.surface.textSecondary}>{request.description}</Text>
      ) : null}
      {request.authUrl ? (
        <Text color={tokens.surface.textSecondary}>Get it at {request.authUrl}</Text>
      ) : null}
      <Box marginTop={1} paddingLeft={1}>
        <Text>{masked || ' '}</Text>
        <Text inverse> </Text>
      </Box>
      {error ? (
        <Box marginTop={1}>
          <Text color={tokens.semantic.error}>{error}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>
          {busy ? 'saving…' : 'input is hidden · Enter save and resend · Esc cancel'}
        </Text>
      </Box>
    </Box>
  );
}

interface CredentialModalProps {
  request: CredentialRequest;
  /** Stores `value` and resends — `submitCredential` bound by the App. */
  onSubmit: (value: string) => Promise<SubmitCredentialResult>;
  onCancel: () => void;
}

export function CredentialModal({ request, onSubmit, onCancel }: CredentialModalProps) {
  // A ref, not only state: two keystrokes can land before a re-render (fast
  // typing, a split paste), and each must build on the one before.
  const valueRef = useRef('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useInput((input, key) => {
    if (busy) return;
    const step = credentialKeyStep(valueRef.current, input, key);
    valueRef.current = step.value;
    setValue(step.value);
    if (step.kind === 'cancel') {
      onCancel();
      return;
    }
    if (step.kind === 'submit') {
      setError(null);
      setBusy(true);
      void onSubmit(step.submitted).then((result) => {
        setBusy(false);
        if (!result.ok) setError(result.error);
      });
    }
  });

  return (
    <CredentialPromptView request={request} masked={maskValue(value)} error={error} busy={busy} />
  );
}

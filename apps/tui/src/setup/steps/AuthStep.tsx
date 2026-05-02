import { PROVIDER_CATALOG } from '@ethosagent/wiring/provider-catalog';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { DESIGN, GLYPHS } from '../../skin';
import { useWizardContext } from '../context';

export function AuthStep() {
  const { answers, dispatch } = useWizardContext();
  const [key, setKey] = useState(answers.apiKey ?? '');
  const [error, setError] = useState('');

  const provider = PROVIDER_CATALOG.find((p) => p.id === answers.provider);
  const isSelfHosted = provider?.authType === 'self-hosted';

  // Alias to avoid shadowing by the `key` parameter in useInput below
  const apiKeyValue = key;

  useInput((input, key: import('ink').Key) => {
    if (key.escape) {
      dispatch({ type: 'back' });
      return;
    }
    if (key.return) {
      if (!isSelfHosted && !apiKeyValue) {
        setError('API key is required');
        return;
      }
      dispatch({ type: 'next', patch: { apiKey: isSelfHosted ? '' : apiKeyValue } });
      return;
    }
    if (key.backspace || key.delete) {
      setKey((k) => k.slice(0, -1));
      setError('');
      return;
    }
    if (!key.ctrl && !key.meta && input) {
      setKey((k) => k + input);
      setError('');
    }
  });

  const signupNote = provider?.signupUrl ? `Get a key at ${provider.signupUrl}` : '';

  const maskedKey =
    apiKeyValue.length > 0
      ? `${'•'.repeat(Math.min(apiKeyValue.length, 20))}${apiKeyValue.length > 20 ? ` (${apiKeyValue.length} chars)` : ''}`
      : '';

  return (
    <Box flexDirection="column" gap={1}>
      <Text color={DESIGN.textPrimary} bold>
        {isSelfHosted
          ? 'Confirm endpoint:'
          : `Enter your ${provider?.label ?? answers.provider} API key:`}
      </Text>

      {isSelfHosted ? (
        <Box flexDirection="column">
          <Text
            color={DESIGN.textSecondary}
          >{`  Base URL: ${answers.baseUrl ?? 'http://localhost:11434/v1'}`}</Text>
          <Text color={DESIGN.textTertiary}>{'  No API key required for local models.'}</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {signupNote && <Text color={DESIGN.textTertiary}>{`  ${signupNote}`}</Text>}
          <Box flexDirection="row" gap={1} marginTop={1}>
            <Text color={DESIGN.textPrimary}>{`  ${GLYPHS.prompt} `}</Text>
            <Text color={maskedKey ? DESIGN.textPrimary : DESIGN.textTertiary}>
              {maskedKey || '(paste key — input is hidden)'}
            </Text>
          </Box>
          {!apiKeyValue && (
            <Text color={DESIGN.textTertiary}>
              {'  Tip: you can add a key later by editing ~/.ethos/config.yaml'}
            </Text>
          )}
          {error && <Text color={DESIGN.error}>{`  ${GLYPHS.toolFail} ${error}`}</Text>}
        </Box>
      )}

      <Text color={DESIGN.textTertiary}>{'  Enter confirm   Esc back'}</Text>
    </Box>
  );
}

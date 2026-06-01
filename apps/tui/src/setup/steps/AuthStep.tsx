import {
  exchangeForTokens,
  pollForAuthorization,
  requestDeviceCode,
  saveTokens,
} from '@ethosagent/llm-codex';
import { PROVIDER_CATALOG } from '@ethosagent/wiring/provider-catalog';
import { Box, Text, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { DESIGN, GLYPHS } from '../../skin';
import { useWizardContext } from '../context';

// ---------------------------------------------------------------------------
// Device auth flow (used for codex provider)
// ---------------------------------------------------------------------------

function DeviceAuthFlow() {
  const { dispatch } = useWizardContext();
  const [phase, setPhase] = useState<'loading' | 'waiting' | 'success' | 'error'>('loading');
  const [userCode, setUserCode] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  // Stable ref so cleanup can abort the in-flight controller.
  const abortRef = useRef<AbortController | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryCount is intentional — triggers re-run on user retry
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('loading');
    setErrorMsg('');
    setUserCode('');

    (async () => {
      try {
        const { deviceAuthId, userCode: code } = await requestDeviceCode(globalThis.fetch);
        if (controller.signal.aborted) return;
        setUserCode(code);
        setPhase('waiting');

        const { authorizationCode, codeVerifier } = await pollForAuthorization(
          globalThis.fetch,
          deviceAuthId,
          code,
          controller.signal,
        );
        if (controller.signal.aborted) return;

        const credentials = await exchangeForTokens(
          globalThis.fetch,
          authorizationCode,
          codeVerifier,
        );
        await saveTokens(credentials);

        setPhase('success');
        dispatch({ type: 'next', patch: { apiKey: '' } });
      } catch (err: unknown) {
        if (controller.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMsg(msg);
        setPhase('error');
      }
    })();

    return () => {
      controller.abort();
    };
  }, [dispatch, retryCount]);

  useInput((_input, key: import('ink').Key) => {
    if (key.escape) {
      abortRef.current?.abort();
      dispatch({ type: 'back' });
      return;
    }
    if (key.return && phase === 'error') {
      setRetryCount((n) => n + 1);
    }
  });

  return (
    <Box flexDirection="column" gap={1}>
      <Text color={DESIGN.textPrimary} bold>
        {'Sign in with your OpenAI / ChatGPT account'}
      </Text>

      {phase === 'loading' && (
        <Text color={DESIGN.textSecondary}>{'  Requesting device code...'}</Text>
      )}

      {phase === 'waiting' && (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text color={DESIGN.textSecondary}>{'  1. Open this link in your browser:'}</Text>
            <Text color={DESIGN.textTertiary}>{'     https://auth.openai.com/codex/device'}</Text>
          </Box>
          <Box flexDirection="column">
            <Text color={DESIGN.textSecondary}>{'  2. Enter this one-time code:'}</Text>
            <Text color={DESIGN.textPrimary} bold>{`     ${userCode}`}</Text>
          </Box>
          <Text color={DESIGN.textTertiary}>{'  Waiting for authorization... (Esc cancel)'}</Text>
        </Box>
      )}

      {phase === 'error' && (
        <Box flexDirection="column" gap={1}>
          <Text color={DESIGN.error}>{`  ${GLYPHS.toolFail} ${errorMsg}`}</Text>
          <Text color={DESIGN.textTertiary}>{'  Enter retry   Esc back'}</Text>
        </Box>
      )}

      {phase === 'success' && <Text color={DESIGN.success}>{`  ${GLYPHS.toolOk} Authorized`}</Text>}
    </Box>
  );
}

// ---------------------------------------------------------------------------

export function AuthStep() {
  const { answers, dispatch } = useWizardContext();
  const [key, setKey] = useState(answers.apiKey ?? '');
  const [error, setError] = useState('');

  const provider = PROVIDER_CATALOG.find((p) => p.id === answers.provider);
  const isDeviceAuth = provider?.authType === 'device-auth';
  const isSelfHosted = provider?.authType === 'self-hosted';
  // Azure needs both an endpoint and an API key — the endpoint is the user's
  // resource URL (e.g. https://my-resource.openai.azure.com), not a default.
  const isAzure = answers.provider === 'azure';

  // Azure-specific: phase machine inside the step. Endpoint first, then apiKey.
  const [azurePhase, setAzurePhase] = useState<'endpoint' | 'apiKey'>(() =>
    answers.baseUrl ? 'apiKey' : 'endpoint',
  );
  const [endpoint, setEndpoint] = useState(answers.baseUrl ?? '');

  // Alias to avoid shadowing by the `key` parameter in useInput below
  const apiKeyValue = key;

  useInput((input, key: import('ink').Key) => {
    // Device-auth input is handled by <DeviceAuthFlow> — skip here.
    if (isDeviceAuth) return;
    if (key.escape) {
      if (isAzure && azurePhase === 'apiKey') {
        // Step back to the endpoint field, not out of the step.
        setAzurePhase('endpoint');
        setError('');
        return;
      }
      dispatch({ type: 'back' });
      return;
    }
    if (key.return) {
      if (isAzure) {
        if (azurePhase === 'endpoint') {
          if (!endpoint.trim()) {
            setError('Azure endpoint is required');
            return;
          }
          if (!/^https?:\/\//i.test(endpoint.trim())) {
            setError('Endpoint must start with https:// or http://');
            return;
          }
          setAzurePhase('apiKey');
          setError('');
          return;
        }
        // azurePhase === 'apiKey'
        if (!apiKeyValue) {
          setError('API key is required');
          return;
        }
        dispatch({
          type: 'next',
          patch: { baseUrl: endpoint.trim(), apiKey: apiKeyValue },
        });
        return;
      }
      if (!isSelfHosted && !apiKeyValue) {
        setError('API key is required');
        return;
      }
      dispatch({ type: 'next', patch: { apiKey: isSelfHosted ? '' : apiKeyValue } });
      return;
    }
    if (key.backspace || key.delete) {
      if (isAzure && azurePhase === 'endpoint') {
        setEndpoint((v) => v.slice(0, -1));
      } else {
        setKey((k) => k.slice(0, -1));
      }
      setError('');
      return;
    }
    if (!key.ctrl && !key.meta && input) {
      if (isAzure && azurePhase === 'endpoint') {
        setEndpoint((v) => v + input);
      } else {
        setKey((k) => k + input);
      }
      setError('');
    }
  });

  const signupNote = provider?.signupUrl ? `Get a key at ${provider.signupUrl}` : '';

  const maskedKey =
    apiKeyValue.length > 0
      ? `${'•'.repeat(Math.min(apiKeyValue.length, 20))}${apiKeyValue.length > 20 ? ` (${apiKeyValue.length} chars)` : ''}`
      : '';

  if (isDeviceAuth) {
    return <DeviceAuthFlow />;
  }

  if (isAzure) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={DESIGN.textPrimary} bold>
          {azurePhase === 'endpoint'
            ? 'Enter your Azure OpenAI endpoint:'
            : 'Enter your Azure API key:'}
        </Text>

        {azurePhase === 'endpoint' ? (
          <Box flexDirection="column">
            <Text color={DESIGN.textTertiary}>
              {'  Resource URL from the Azure portal (Keys and Endpoint).'}
            </Text>
            <Box flexDirection="row" gap={1} marginTop={1}>
              <Text color={DESIGN.textPrimary}>{`  ${GLYPHS.prompt} `}</Text>
              <Text color={endpoint ? DESIGN.textPrimary : DESIGN.textTertiary}>
                {endpoint || 'https://my-resource.openai.azure.com'}
              </Text>
            </Box>
            {error && <Text color={DESIGN.error}>{`  ${GLYPHS.toolFail} ${error}`}</Text>}
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text color={DESIGN.textTertiary}>{`  Endpoint: ${endpoint}`}</Text>
            <Box flexDirection="row" gap={1} marginTop={1}>
              <Text color={DESIGN.textPrimary}>{`  ${GLYPHS.prompt} `}</Text>
              <Text color={maskedKey ? DESIGN.textPrimary : DESIGN.textTertiary}>
                {maskedKey || '(paste key — input is hidden)'}
              </Text>
            </Box>
            {error && <Text color={DESIGN.error}>{`  ${GLYPHS.toolFail} ${error}`}</Text>}
          </Box>
        )}

        <Text color={DESIGN.textTertiary}>
          {azurePhase === 'endpoint'
            ? '  Enter confirm   Esc back to provider'
            : '  Enter confirm   Esc edit endpoint'}
        </Text>
      </Box>
    );
  }

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

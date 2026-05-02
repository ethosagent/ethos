import { PROVIDER_CATALOG } from '@ethosagent/wiring/provider-catalog';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { DESIGN, GLYPHS } from '../../skin';
import { useWizardContext } from '../context';

interface ProviderEntry {
  provider: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

type Phase = 'list' | 'add-provider' | 'add-key';

export function MultiProviderStep() {
  const { answers, accent, dispatch } = useWizardContext();
  const [phase, setPhase] = useState<Phase>('list');
  const [providerIdx, setProviderIdx] = useState(0);
  const [apiKey, setApiKey] = useState('');
  const [providers, setProviders] = useState<ProviderEntry[]>(answers.providers ?? []);

  useInput((input, key) => {
    if (phase === 'list') {
      if (key.return) {
        dispatch({ type: 'next', patch: { providers } });
        return;
      }
      if (input === 'a') {
        setPhase('add-provider');
        setProviderIdx(0);
        return;
      }
      if (key.escape) {
        dispatch({ type: 'back' });
        return;
      }
    }

    if (phase === 'add-provider') {
      if (key.upArrow) setProviderIdx((i) => Math.max(0, i - 1));
      if (key.downArrow) setProviderIdx((i) => Math.min(PROVIDER_CATALOG.length - 1, i + 1));
      if (key.return) {
        setPhase('add-key');
        setApiKey('');
        return;
      }
      if (key.escape) {
        setPhase('list');
        return;
      }
    }

    if (phase === 'add-key') {
      if (key.escape) {
        setPhase('add-provider');
        return;
      }
      if (key.return) {
        const entry = PROVIDER_CATALOG[providerIdx];
        if (entry) {
          setProviders((p) => [
            ...p,
            { provider: entry.id, apiKey, baseUrl: entry.defaultBaseUrl },
          ]);
        }
        setPhase('list');
        return;
      }
      if (key.backspace || key.delete) {
        setApiKey((k) => k.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && input) {
        setApiKey((k) => k + input);
      }
    }
  });

  if (phase === 'add-provider') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={DESIGN.textPrimary} bold>
          Add a fallback provider:
        </Text>
        <Box flexDirection="column">
          {PROVIDER_CATALOG.map((p, i) => {
            const isSelected = i === providerIdx;
            const cursor = isSelected ? GLYPHS.prompt : ' ';
            return (
              <Box key={p.id} flexDirection="row" gap={1}>
                <Text color={isSelected ? accent : DESIGN.textTertiary}>{` ${cursor} `}</Text>
                <Text color={isSelected ? DESIGN.textPrimary : DESIGN.textSecondary}>
                  {p.label}
                </Text>
              </Box>
            );
          })}
        </Box>
        <Text color={DESIGN.textTertiary}>{'  ↑↓ select   Enter next   Esc back'}</Text>
      </Box>
    );
  }

  if (phase === 'add-key') {
    const entry = PROVIDER_CATALOG[providerIdx];
    const masked =
      apiKey.length > 0
        ? `${'•'.repeat(Math.min(apiKey.length, 20))}${apiKey.length > 20 ? ` (${apiKey.length} chars)` : ''}`
        : '';
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={DESIGN.textPrimary} bold>
          {`API key for ${entry?.label ?? ''}:`}
        </Text>
        <Box flexDirection="row" gap={1} marginLeft={2}>
          <Text color={accent}>{`${GLYPHS.prompt} `}</Text>
          <Text color={masked ? DESIGN.textPrimary : DESIGN.textTertiary}>
            {masked || '(paste key — input is hidden)'}
          </Text>
        </Box>
        <Text color={DESIGN.textTertiary}>{'  Enter confirm   Esc back'}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text color={DESIGN.textPrimary} bold>
        Fallback provider chain:
      </Text>
      <Box flexDirection="column" marginLeft={2}>
        <Box flexDirection="row" gap={1}>
          <Text color={DESIGN.success}>{`${GLYPHS.toolOk} `}</Text>
          <Text color={DESIGN.textPrimary}>{`${answers.provider ?? 'anthropic'}`}</Text>
          <Text color={DESIGN.textTertiary}>{'(primary)'}</Text>
        </Box>
        {providers.map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: list is append-only, index stable
          <Box key={`${p.provider}-${i}`} flexDirection="row" gap={1}>
            <Text color={DESIGN.textSecondary}>{`  ${i + 1}. `}</Text>
            <Text color={DESIGN.textSecondary}>{p.provider}</Text>
            <Text color={DESIGN.textTertiary}>{'(fallback)'}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={DESIGN.textTertiary}>{'  a — add fallback   Enter done   Esc back'}</Text>
      </Box>
    </Box>
  );
}

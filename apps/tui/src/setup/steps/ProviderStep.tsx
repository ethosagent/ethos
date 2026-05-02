import { PROVIDER_CATALOG, type ProviderCatalogEntry } from '@ethosagent/wiring/provider-catalog';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { DESIGN, GLYPHS } from '../../skin';
import { useWizardContext } from '../context';

function nextEnabled(entries: ProviderCatalogEntry[], from: number, dir: 1 | -1): number {
  let i = from + dir;
  while (i >= 0 && i < entries.length) {
    if (!entries[i]?.comingSoon) return i;
    i += dir;
  }
  return from;
}

export function ProviderStep() {
  const { answers, dispatch } = useWizardContext();

  const [selected, setSelected] = useState(() => {
    const idx = PROVIDER_CATALOG.findIndex((e) => e.id === (answers.provider ?? 'anthropic'));
    return idx >= 0 ? idx : 0;
  });

  useInput((input, key) => {
    if (key.upArrow) setSelected((s) => nextEnabled(PROVIDER_CATALOG, s, -1));
    if (key.downArrow) setSelected((s) => nextEnabled(PROVIDER_CATALOG, s, 1));
    if (key.return) {
      const entry = PROVIDER_CATALOG[selected];
      if (entry && !entry.comingSoon) {
        dispatch({ type: 'next', patch: { provider: entry.id, baseUrl: entry.defaultBaseUrl } });
      }
    }
    if (key.escape) dispatch({ type: 'back' });
    void input;
  });

  return (
    <Box flexDirection="column" gap={1}>
      <Text color={DESIGN.textPrimary} bold>
        Choose a provider:
      </Text>
      <Box flexDirection="column">
        {PROVIDER_CATALOG.map((entry, i) => {
          const isSelected = i === selected;
          const isDisabled = Boolean(entry.comingSoon);
          const cursor = isSelected && !isDisabled ? GLYPHS.prompt : ' ';
          const isCurrent = answers.provider === entry.id;
          const labelColor = isDisabled
            ? DESIGN.textTertiary
            : isSelected
              ? DESIGN.textPrimary
              : DESIGN.textSecondary;
          return (
            <Box key={entry.id} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Text color={isDisabled ? DESIGN.textTertiary : DESIGN.textPrimary}>
                  {` ${cursor} `}
                </Text>
                <Text color={labelColor} bold={isSelected && !isDisabled} dimColor={isDisabled}>
                  {entry.label}
                </Text>
                {isDisabled && (
                  <Text color={DESIGN.textTertiary} dimColor>
                    {'(coming soon)'}
                  </Text>
                )}
                {!isDisabled && isCurrent && <Text color={DESIGN.textTertiary}>{'(current)'}</Text>}
                {!isDisabled && <Text color={DESIGN.textTertiary}>{entry.costType}</Text>}
              </Box>
              {isSelected && !isDisabled && (
                <Text color={DESIGN.textTertiary}>{`      ${entry.description}`}</Text>
              )}
            </Box>
          );
        })}
      </Box>
      <Text color={DESIGN.textTertiary}>{'  ↑↓ select   Enter confirm   Esc back'}</Text>
    </Box>
  );
}

import { PROVIDER_CATALOG, type ProviderCatalogEntry } from '@ethosagent/wiring/provider-catalog';
import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';
import { DESIGN, GLYPHS } from '../../skin';
import { useWizardContext } from '../context';

export function ProviderStep() {
  const { answers, dispatch } = useWizardContext();
  const [expanded, setExpanded] = useState(false);

  const visibleEntries: ProviderCatalogEntry[] = useMemo(
    () => (expanded ? PROVIDER_CATALOG : PROVIDER_CATALOG.filter((p) => p.recommended)),
    [expanded],
  );

  const [selected, setSelected] = useState(() =>
    Math.max(
      0,
      visibleEntries.findIndex((e) => e.id === 'anthropic'),
    ),
  );

  useInput((input, key) => {
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelected((s) => Math.min(visibleEntries.length - 1, s + 1));
    if (key.return) {
      const entry = visibleEntries[selected];
      if (entry)
        dispatch({ type: 'next', patch: { provider: entry.id, baseUrl: entry.defaultBaseUrl } });
    }
    if (key.escape) dispatch({ type: 'back' });
    if (input === ' ') setExpanded((e) => !e);
  });

  return (
    <Box flexDirection="column" gap={1}>
      <Text color={DESIGN.textPrimary} bold>
        Choose a provider:
      </Text>
      <Box flexDirection="column">
        <Text color={DESIGN.textTertiary} bold>
          {'  '}
          {expanded ? 'ALL PROVIDERS' : 'RECOMMENDED'}
        </Text>
        {visibleEntries.map((entry, i) => {
          const isSelected = i === selected;
          const cursor = isSelected ? GLYPHS.prompt : ' ';
          const isCurrent = answers.provider === entry.id;
          return (
            <Box key={entry.id} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Text color={DESIGN.textPrimary}>{` ${cursor} `}</Text>
                <Text
                  color={isSelected ? DESIGN.textPrimary : DESIGN.textSecondary}
                  bold={isSelected}
                >
                  {entry.label}
                </Text>
                {isCurrent && <Text color={DESIGN.textTertiary}>{'(current)'}</Text>}
                <Text color={DESIGN.textTertiary}>{entry.costType}</Text>
              </Box>
              {isSelected && (
                <Text color={DESIGN.textTertiary}>{`      ${entry.description}`}</Text>
              )}
            </Box>
          );
        })}
        {!expanded && (
          <Box marginTop={1}>
            <Text
              color={DESIGN.textTertiary}
            >{`  Space — show all ${PROVIDER_CATALOG.length} providers`}</Text>
          </Box>
        )}
      </Box>
      <Text color={DESIGN.textTertiary}>{'  ↑↓ select   Enter confirm   Esc back'}</Text>
    </Box>
  );
}

import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { DESIGN, GLYPHS } from '../../skin';
import { useWizardContext } from '../context';

const OPTIONS = [
  {
    id: 'quick' as const,
    label: 'Quick setup',
    hint: 'provider · key · model · personality · messaging  (~2 min)',
  },
  {
    id: 'full' as const,
    label: 'Full setup',
    hint: 'adds fallback chain · key rotation · memory backend · daemon',
  },
];

export function SetupEntryStep() {
  const { dispatch } = useWizardContext();
  const [selected, setSelected] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelected((s) => Math.min(OPTIONS.length - 1, s + 1));
    if (key.return) {
      const choice = OPTIONS[selected];
      if (choice) dispatch({ type: 'next', patch: { mode: choice.id } });
    }
  });

  return (
    <Box flexDirection="column" gap={1}>
      <Text color={DESIGN.textPrimary} bold>
        How would you like to configure ethos?
      </Text>
      <Box flexDirection="column">
        {OPTIONS.map((opt, i) => {
          const isSelected = i === selected;
          const cursor = isSelected ? GLYPHS.prompt : ' ';
          return (
            <Box key={opt.id} flexDirection="row" gap={1}>
              <Text color={DESIGN.textPrimary}>{` ${cursor} `}</Text>
              <Box flexDirection="column">
                <Text
                  color={isSelected ? DESIGN.textPrimary : DESIGN.textSecondary}
                  bold={isSelected}
                >
                  {opt.label}
                </Text>
                <Text color={DESIGN.textTertiary}>{`    ${opt.hint}`}</Text>
              </Box>
            </Box>
          );
        })}
      </Box>
      <Text color={DESIGN.textTertiary}>{'  ↑↓ select   Enter confirm'}</Text>
    </Box>
  );
}

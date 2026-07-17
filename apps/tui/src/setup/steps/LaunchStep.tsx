import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { DESIGN, GLYPHS } from '../../skin';
import type { WizardAnswers } from '../context';
import { useWizardContext } from '../context';
import { type LaunchChoice, launchOptions } from './launch-options';

export interface LaunchStepProps {
  onComplete: (result: { answers: WizardAnswers; launch: LaunchChoice } | null) => void;
}

export function LaunchStep(_props: LaunchStepProps) {
  const { accent, answers, dispatch } = useWizardContext();
  const options = launchOptions(Boolean(answers.telegramUsername));
  const [selected, setSelected] = useState(0);

  useInput((input, key) => {
    if (key.upArrow || input === 'k') setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow || input === 'j') setSelected((s) => Math.min(options.length - 1, s + 1));
    if (key.return) {
      const choice = options[selected]?.id ?? 'done';
      dispatch({ type: 'next', patch: { launch: choice } });
    }
    if (key.escape) dispatch({ type: 'back' });
  });

  return (
    <Box flexDirection="column" gap={1}>
      <Text color={DESIGN.textPrimary} bold>
        What next?
      </Text>
      <Box flexDirection="column">
        {options.map((option, i) => {
          const isSelected = i === selected;
          const cursor = isSelected ? GLYPHS.prompt : ' ';
          return (
            <Box key={option.id} flexDirection="row" gap={1}>
              <Text color={isSelected ? accent : DESIGN.textTertiary}>{` ${cursor} `}</Text>
              <Text
                color={isSelected ? DESIGN.textPrimary : DESIGN.textSecondary}
                bold={isSelected}
              >
                {option.label}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Text color={DESIGN.textTertiary}>{'  ↑↓ select   Enter confirm   Esc back'}</Text>
    </Box>
  );
}

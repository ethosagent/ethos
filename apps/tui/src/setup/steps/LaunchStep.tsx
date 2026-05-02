import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { DESIGN, GLYPHS } from '../../skin';
import type { WizardAnswers } from '../context';
import { useWizardContext } from '../context';

export interface LaunchStepProps {
  onComplete: (result: { answers: WizardAnswers; launchChat: boolean } | null) => void;
}

export function LaunchStep(_props: LaunchStepProps) {
  const { accent, dispatch } = useWizardContext();
  const [choice, setChoice] = useState<'yes' | 'no'>('yes');

  useInput((input, key) => {
    if (key.leftArrow || input === 'h' || input === 'n') setChoice('no');
    if (key.rightArrow || input === 'l' || input === 'y') setChoice('yes');
    if (key.return) {
      dispatch({ type: 'next', patch: { launchChat: choice === 'yes' } });
    }
    if (key.escape) dispatch({ type: 'back' });
  });

  return (
    <Box flexDirection="column" gap={1}>
      <Text color={DESIGN.textPrimary} bold>
        Launch chat now?
      </Text>
      <Box flexDirection="row" gap={2} marginLeft={2}>
        <Text color={choice === 'yes' ? accent : DESIGN.textTertiary} bold={choice === 'yes'}>
          {choice === 'yes' ? `${GLYPHS.prompt} Y` : '  Y'}
        </Text>
        <Text color={DESIGN.textTertiary}>{'/'}</Text>
        <Text color={choice === 'no' ? accent : DESIGN.textTertiary} bold={choice === 'no'}>
          {choice === 'no' ? `${GLYPHS.prompt} n` : '  n'}
        </Text>
      </Box>
      <Text color={DESIGN.textTertiary}>{'  ←/→ or y/n   Enter confirm   Esc back'}</Text>
      {choice === 'no' && (
        <Text color={DESIGN.textTertiary}>{'  Run `ethos` to start chatting.'}</Text>
      )}
    </Box>
  );
}

import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { DESIGN, GLYPHS } from '../../skin';
import { useWizardContext } from '../context';

interface RotationKey {
  apiKey: string;
  priority: number;
}

type Phase = 'list' | 'add';

export function KeyRotationStep() {
  const { answers, accent, dispatch } = useWizardContext();
  const [phase, setPhase] = useState<Phase>('list');
  const [keys, setKeys] = useState<RotationKey[]>(answers.rotationKeys ?? []);
  const [input, setInput] = useState('');

  useInput((inputChar, key) => {
    if (phase === 'list') {
      if (key.return) {
        dispatch({ type: 'next', patch: { rotationKeys: keys } });
        return;
      }
      if (inputChar === 'a') {
        setPhase('add');
        setInput('');
        return;
      }
      if (key.escape) {
        dispatch({ type: 'back' });
        return;
      }
    }

    if (phase === 'add') {
      if (key.escape) {
        setPhase('list');
        return;
      }
      if (key.return) {
        if (input.trim()) {
          setKeys((k) => [...k, { apiKey: input.trim(), priority: k.length + 2 }]);
        }
        setPhase('list');
        return;
      }
      if (key.backspace || key.delete) {
        setInput((v) => v.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && inputChar) {
        setInput((v) => v + inputChar);
      }
    }
  });

  if (phase === 'add') {
    const masked =
      input.length > 0
        ? `${'•'.repeat(Math.min(input.length, 20))}${input.length > 20 ? ` (${input.length} chars)` : ''}`
        : '';
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={DESIGN.textPrimary} bold>
          Add a rotation key:
        </Text>
        <Box flexDirection="row" gap={1} marginLeft={2}>
          <Text color={accent}>{`${GLYPHS.prompt} `}</Text>
          <Text color={masked ? DESIGN.textPrimary : DESIGN.textTertiary}>
            {masked || '(paste key — input is hidden)'}
          </Text>
        </Box>
        <Text color={DESIGN.textTertiary}>{'  Enter save   Esc back'}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text color={DESIGN.textPrimary} bold>
        API key rotation pool:
      </Text>
      <Box flexDirection="column" marginLeft={2}>
        <Box flexDirection="row" gap={1}>
          <Text color={DESIGN.success}>{`${GLYPHS.toolOk} `}</Text>
          <Text color={DESIGN.textPrimary}>{'Primary key (already set)'}</Text>
          <Text color={DESIGN.textTertiary}>{'priority 1'}</Text>
        </Box>
        {keys.map((k, i) => (
          <Box key={k.priority} flexDirection="row" gap={1}>
            <Text color={DESIGN.textSecondary}>{`  ${GLYPHS.toolOk} `}</Text>
            <Text color={DESIGN.textSecondary}>{`Key ${i + 2}`}</Text>
            <Text color={DESIGN.textTertiary}>{`priority ${k.priority}`}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={DESIGN.textTertiary}>{'  a — add key   Enter done   Esc back'}</Text>
      </Box>
      <Text color={DESIGN.textTertiary}>
        {
          '  Key material is stored in ~/.ethos/secrets/ (chmod 0600); rotation order in ~/.ethos/keys.json'
        }
      </Text>
    </Box>
  );
}

import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { DESIGN, GLYPHS } from '../../skin';
import { useWizardContext } from '../context';

type MemoryBackend = 'markdown' | 'vector';

const OPTIONS: { id: MemoryBackend; label: string; hint: string }[] = [
  { id: 'markdown', label: 'Markdown (default)', hint: 'file-based, always available' },
  { id: 'vector', label: 'Vector (semantic)', hint: 'requires @ethosagent/memory-vector' },
];

export function MemoryStep() {
  const { answers, accent, dispatch } = useWizardContext();
  const [selected, setSelected] = useState<number>(() => {
    const idx = OPTIONS.findIndex((o) => o.id === answers.memory);
    return idx >= 0 ? idx : 0;
  });

  useInput((_input, key) => {
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelected((s) => Math.min(OPTIONS.length - 1, s + 1));
    if (key.return) {
      const opt = OPTIONS[selected];
      if (opt) dispatch({ type: 'next', patch: { memory: opt.id } });
    }
    if (key.escape) dispatch({ type: 'back' });
  });

  const selectedOpt = OPTIONS[selected];

  return (
    <Box flexDirection="column" gap={1}>
      <Text color={DESIGN.textPrimary} bold>
        Choose a memory backend:
      </Text>
      <Box flexDirection="column">
        {OPTIONS.map((opt, i) => {
          const isSelected = i === selected;
          const cursor = isSelected ? GLYPHS.prompt : ' ';
          return (
            <Box key={opt.id} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Text color={isSelected ? accent : DESIGN.textTertiary}>{` ${cursor} `}</Text>
                <Text
                  color={isSelected ? DESIGN.textPrimary : DESIGN.textSecondary}
                  bold={isSelected}
                >
                  {opt.label}
                </Text>
              </Box>
              {isSelected && <Text color={DESIGN.textTertiary}>{`      ${opt.hint}`}</Text>}
            </Box>
          );
        })}
      </Box>
      {selectedOpt?.id === 'vector' && (
        <Text color={DESIGN.textTertiary}>{'  Install: pnpm add @ethosagent/memory-vector'}</Text>
      )}
      <Text color={DESIGN.textTertiary}>{'  ↑↓ select   Enter confirm   Esc back'}</Text>
    </Box>
  );
}

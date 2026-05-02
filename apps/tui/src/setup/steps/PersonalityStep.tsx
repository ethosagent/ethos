import { generatePersonalityMark, personalityAccent } from '@ethosagent/web-contracts';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { DESIGN, GLYPHS } from '../../skin';
import { useWizardContext } from '../context';

interface PersonalityEntry {
  id: string;
  description: string;
}

const PERSONALITIES: PersonalityEntry[] = [
  { id: 'researcher', description: 'deep reads, slow takes, links sources' },
  { id: 'engineer', description: 'ship working code, terse, runs tests' },
  { id: 'reviewer', description: 'diff-aware, surfaces tradeoffs' },
  { id: 'coach', description: 'asks back, helps you think out loud' },
  { id: 'operator', description: 'plans, schedules, dispatches' },
  { id: 'coordinator', description: 'delegates across team meshes' },
];

function opacityToChar(opacity: number): string {
  if (opacity >= 0.93) return '█';
  if (opacity >= 0.81) return '▓';
  if (opacity >= 0.68) return '▒';
  if (opacity >= 0.55) return '░';
  return ' ';
}

function getMarkSlice(id: string): string {
  const spec = generatePersonalityMark(id);
  const row0 = Array(4).fill(' ');
  for (const cell of spec.cells) {
    if (cell.row === 0 && cell.col < 4) {
      row0[cell.col] = opacityToChar(cell.opacity);
    }
  }
  return row0.join('');
}

function FullMarkPreview({ id }: { id: string }) {
  const spec = generatePersonalityMark(id);
  const accent = personalityAccent(id);
  const grid: string[][] = Array.from({ length: 5 }, () => Array(5).fill(' '));
  for (const cell of spec.cells) {
    if (cell.row < 5 && cell.col < 5) {
      grid[cell.row][cell.col] = opacityToChar(cell.opacity);
    }
  }
  return (
    <Box flexDirection="column" marginLeft={4}>
      {grid.map((row, r) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static 5-row mark grid, never reordered
        <Text key={r} color={accent}>
          {row.join('')}
        </Text>
      ))}
    </Box>
  );
}

export function PersonalityStep() {
  const { answers, accent, dispatch } = useWizardContext();
  const [selected, setSelected] = useState(() => {
    const idx = PERSONALITIES.findIndex((p) => p.id === answers.personality);
    return idx >= 0 ? idx : 0;
  });
  const [previewing, setPreviewing] = useState(false);

  useInput((input, key) => {
    if (previewing) {
      if (key.escape || input === ' ') setPreviewing(false);
      return;
    }
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelected((s) => Math.min(PERSONALITIES.length - 1, s + 1));
    if (input === ' ') setPreviewing(true);
    if (key.return) {
      const p = PERSONALITIES[selected];
      if (p) dispatch({ type: 'next', patch: { personality: p.id } });
    }
    if (key.escape) dispatch({ type: 'back' });
  });

  const selectedEntry = PERSONALITIES[selected];
  const cursorAccent = selectedEntry ? personalityAccent(selectedEntry.id) : accent;

  if (previewing && selectedEntry) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={DESIGN.textPrimary} bold>
          {selectedEntry.id}
        </Text>
        <FullMarkPreview id={selectedEntry.id} />
        <Text color={DESIGN.textTertiary}>{'  Esc or Space to close preview'}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text color={DESIGN.textPrimary} bold>
        Choose a default personality:
      </Text>
      <Box flexDirection="column">
        {PERSONALITIES.map((p, i) => {
          const isSelected = i === selected;
          const pAccent = personalityAccent(p.id);
          const cursor = isSelected ? GLYPHS.prompt : ' ';
          const markSlice = getMarkSlice(p.id);
          return (
            <Box key={p.id} flexDirection="row" gap={1}>
              <Text color={isSelected ? cursorAccent : DESIGN.textTertiary}>{` ${cursor} `}</Text>
              <Text color={pAccent}>{markSlice}</Text>
              <Text color={pAccent}>{GLYPHS.accentStripe}</Text>
              <Text
                color={isSelected ? DESIGN.textPrimary : DESIGN.textSecondary}
                bold={isSelected}
              >
                {p.id.padEnd(12)}
              </Text>
              <Text color={DESIGN.textTertiary}>{p.description}</Text>
            </Box>
          );
        })}
      </Box>
      <Text color={DESIGN.textTertiary}>
        {'  ↑↓ select   Enter confirm   Space ▤ preview   Esc back'}
      </Text>
    </Box>
  );
}

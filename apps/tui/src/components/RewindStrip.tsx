import { REWIND_NOTICE } from '@ethosagent/surface-kit';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { type BacktrackKey, type BacktrackState, stepBacktrack } from '../rewind-backtrack';

export interface RewindStripPoint {
  turnsBack: number;
  messageId: string;
  text: string;
  hadAttachments: boolean;
}

interface RewindStripProps {
  points: RewindStripPoint[];
  onPick: (point: RewindStripPoint) => void;
  onCancel: () => void;
}

const PREVIEW_CHARS = 60;

function preview(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One-line picker for an earlier prompt. Owns the keyboard while it is shown. */
export function RewindStrip({ points, onPick, onCancel }: RewindStripProps) {
  const [state, setState] = useState<BacktrackState>({ index: 0, count: points.length });

  const apply = (k: BacktrackKey) => {
    const step = stepBacktrack(state, k);
    if ('state' in step) {
      setState(step.state);
      return;
    }
    if (step.done === 'cancel') {
      onCancel();
      return;
    }
    const point = points[step.index];
    if (point) onPick(point);
  };

  useInput((_input, key) => {
    if (key.ctrl && _input === 'c') return apply('cancel');
    if (key.escape || key.upArrow) return apply('older');
    if (key.downArrow) return apply('newer');
    if (key.return) return apply('pick');
  });

  const point = points[state.index];
  if (!point) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        {`↶ ${point.turnsBack} back · "${preview(point.text, PREVIEW_CHARS)}" · Esc/↑ older · ↓ newer · Enter edit`}
      </Text>
      <Text dimColor>{REWIND_NOTICE}</Text>
    </Box>
  );
}

import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import { DESIGN, GLYPHS } from '../skin';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  return <Text color={DESIGN.info}>{FRAMES[frame]}</Text>;
}

function ProgressBar({ percent }: { percent: number }) {
  const filled = Math.round(percent / 10);
  const bar = GLYPHS.barFill.repeat(filled) + GLYPHS.barEmpty.repeat(10 - filled);
  return <Text dimColor>{bar}</Text>;
}

export interface ActiveTool {
  toolCallId: string;
  toolName: string;
  message?: string;
  percent?: number;
}

export interface CompletedTool {
  id: string;
  toolName: string;
  ok: boolean;
  durationMs: number;
}

interface ToolSpinnerProps {
  activeTools: ActiveTool[];
  completedTools: CompletedTool[];
}

export function ToolSpinner({ activeTools, completedTools }: ToolSpinnerProps) {
  if (activeTools.length === 0 && completedTools.length === 0) return null;
  return (
    <Box flexDirection="column">
      {completedTools.map((t) => (
        <Box key={t.id} gap={1}>
          <Text color={t.ok ? DESIGN.success : DESIGN.error}>
            {t.ok ? GLYPHS.toolOk : GLYPHS.toolFail}
          </Text>
          <Text dimColor>
            {GLYPHS.toolStart} {t.toolName} {t.durationMs}ms
          </Text>
        </Box>
      ))}
      {activeTools.map((t) => (
        <Box key={t.toolCallId} gap={1}>
          <Spinner />
          <Text dimColor>
            {GLYPHS.toolStart} {t.toolName}
            {t.message ? ` — ${t.message}` : ''}
          </Text>
          {t.percent != null && <ProgressBar percent={t.percent} />}
        </Box>
      ))}
    </Box>
  );
}

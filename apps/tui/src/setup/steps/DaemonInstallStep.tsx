import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { DESIGN, GLYPHS } from '../../skin';
import { useWizardContext } from '../context';

const OPTIONS = [
  {
    id: 'install' as const,
    label: 'Install gateway daemon',
    hint: 'systemd (Linux) / LaunchAgent (macOS) — survives reboot',
  },
  {
    id: 'skip' as const,
    label: 'Skip',
    hint: 'run `ethos gateway start` manually',
  },
];

export function DaemonInstallStep() {
  const { accent, dispatch } = useWizardContext();
  const [selected, setSelected] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelected((s) => Math.min(OPTIONS.length - 1, s + 1));
    if (key.return) {
      // Daemon install happens post-wizard via CLI; we just record the intent.
      dispatch({ type: 'next', patch: {} });
    }
    if (key.escape) dispatch({ type: 'back' });
  });

  const platform = process.platform === 'darwin' ? 'macOS LaunchAgent' : 'systemd user unit';

  return (
    <Box flexDirection="column" gap={1}>
      <Text color={DESIGN.textPrimary} bold>
        Gateway daemon:
      </Text>
      <Text color={DESIGN.textTertiary}>{`  Detected: ${platform}`}</Text>
      <Box flexDirection="column" marginTop={1}>
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
      <Text color={DESIGN.textTertiary}>{'  ↑↓ select   Enter confirm   Esc back'}</Text>
    </Box>
  );
}

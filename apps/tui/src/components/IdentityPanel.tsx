import { Box, Text } from 'ink';
import { useSkin } from '../skin';
import { PersonalityMark } from './PersonalityMark';

type PanelStatus = 'idle' | 'thinking' | 'running' | 'interrupted';

interface IdentityPanelProps {
  personality: string;
  status: PanelStatus;
  delegationCount: number;
  accentColor: string;
  focused?: boolean;
  /** `display.emoji` — shown before the name, never in place of the mark. */
  emoji?: string;
}

function modeFromStatus(status: PanelStatus): string {
  switch (status) {
    case 'running':
      return 'execution';
    case 'thinking':
      return 'analysis';
    case 'interrupted':
      return 'paused';
    default:
      return 'ready';
  }
}

export function IdentityPanel({
  personality,
  status,
  delegationCount,
  accentColor,
  focused = false,
  emoji,
}: IdentityPanelProps) {
  const tokens = useSkin();
  return (
    <Box
      borderStyle="single"
      borderColor={focused ? tokens.semantic.info : tokens.surface.borderSubtle}
      paddingX={1}
      paddingY={1}
      flexDirection="column"
      marginRight={1}
    >
      <PersonalityMark personality={personality} accentColor={accentColor} />
      <Text bold color={accentColor}>
        {emoji ? `${emoji} ${personality}` : personality}
      </Text>
      <Text dimColor>mode: {modeFromStatus(status)}</Text>
      <Text dimColor>status: {status}</Text>
      <Text dimColor>delegations: {delegationCount}</Text>
      <Text dimColor>services: local bridge</Text>
    </Box>
  );
}

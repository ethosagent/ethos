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
        {personality}
      </Text>
      <Text dimColor>mode: {modeFromStatus(status)}</Text>
      <Text dimColor>status: {status}</Text>
      <Text dimColor>delegations: {delegationCount}</Text>
      <Text dimColor>services: local bridge</Text>
    </Box>
  );
}

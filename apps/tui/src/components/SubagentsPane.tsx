import { Box, Text } from 'ink';

export interface DelegationRecord {
  id: string;
  capability: string;
  status: 'pending' | 'done' | 'failed';
  durationMs?: number;
  error?: string;
}

interface SubagentsPaneProps {
  delegations: DelegationRecord[];
}

const MAX_VISIBLE = 16;

export function SubagentsPane({ delegations }: SubagentsPaneProps) {
  if (delegations.length === 0) return null;
  const visible = delegations.slice(-MAX_VISIBLE);
  return (
    <Box flexDirection="column">
      {visible.map((d) => (
        <Box key={d.id} flexDirection="column">
          <Box gap={1}>
            <Text color={d.status === 'done' ? 'green' : d.status === 'failed' ? 'red' : 'yellow'}>
              {d.status === 'done' ? '✓' : d.status === 'failed' ? '✗' : '…'}
            </Text>
            <Text dimColor>
              {d.capability}
              {d.durationMs != null ? ` ${d.durationMs}ms` : ''}
            </Text>
          </Box>
          {d.status === 'failed' && d.error && (
            <Text color="red"> reason: {d.error.slice(0, 96)}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}

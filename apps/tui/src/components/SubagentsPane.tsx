import { Box, Text } from 'ink';
import { DESIGN, GLYPHS } from '../skin';

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
            <Text
              color={
                d.status === 'done'
                  ? DESIGN.success
                  : d.status === 'failed'
                    ? DESIGN.error
                    : DESIGN.warning
              }
            >
              {d.status === 'done' ? GLYPHS.toolOk : d.status === 'failed' ? GLYPHS.toolFail : '…'}
            </Text>
            <Text dimColor>
              {d.capability}
              {d.durationMs != null ? ` ${d.durationMs}ms` : ''}
            </Text>
          </Box>
          {d.status === 'failed' && d.error && (
            <Text color={DESIGN.error}> reason: {d.error.slice(0, 96)}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}

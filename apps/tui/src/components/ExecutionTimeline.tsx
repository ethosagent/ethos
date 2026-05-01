import { Box, Text } from 'ink';
import { DESIGN } from '../skin';

export interface TimelineEvent {
  id: string;
  at: string;
  level: 'info' | 'success' | 'warning' | 'error';
  text: string;
}

interface ExecutionTimelineProps {
  events: TimelineEvent[];
  focused?: boolean;
}

const MAX_EVENTS = 24;

function colorFor(level: TimelineEvent['level']): string {
  switch (level) {
    case 'success':
      return DESIGN.success;
    case 'warning':
      return DESIGN.warning;
    case 'error':
      return DESIGN.error;
    default:
      return DESIGN.info;
  }
}

export function ExecutionTimeline({ events, focused = false }: ExecutionTimelineProps) {
  const visible = events.slice(-MAX_EVENTS);
  return (
    <Box flexDirection="column" marginLeft={1}>
      <Text dimColor color={focused ? DESIGN.info : undefined}>
        {'─── '}
        <Text bold color={focused ? DESIGN.info : DESIGN.textPrimary}>
          execution
        </Text>
        {' ───'}
      </Text>
      {visible.length === 0 ? (
        <Text dimColor>no activity yet</Text>
      ) : (
        visible.map((event) => (
          <Box key={event.id}>
            <Text dimColor>{event.at}</Text>
            <Text> </Text>
            <Text color={colorFor(event.level)}>{event.text}</Text>
          </Box>
        ))
      )}
    </Box>
  );
}

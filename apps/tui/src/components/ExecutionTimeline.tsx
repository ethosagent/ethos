import { Box, Text } from 'ink';
import { useSkin } from '../skin';

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

export function ExecutionTimeline({ events, focused = false }: ExecutionTimelineProps) {
  const tokens = useSkin();
  const colorFor = (level: TimelineEvent['level']): string => {
    switch (level) {
      case 'success':
        return tokens.semantic.success;
      case 'warning':
        return tokens.semantic.warning;
      case 'error':
        return tokens.semantic.error;
      default:
        return tokens.semantic.info;
    }
  };
  const visible = events.slice(-MAX_EVENTS);
  return (
    <Box flexDirection="column" marginLeft={1}>
      <Text dimColor color={focused ? tokens.semantic.info : undefined}>
        {'─── '}
        <Text bold color={focused ? tokens.semantic.info : tokens.surface.textPrimary}>
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

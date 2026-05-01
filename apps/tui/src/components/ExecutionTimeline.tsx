import { Box, Text } from 'ink';

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
      return 'green';
    case 'warning':
      return 'yellow';
    case 'error':
      return 'red';
    default:
      return 'cyan';
  }
}

export function ExecutionTimeline({ events, focused = false }: ExecutionTimelineProps) {
  const visible = events.slice(-MAX_EVENTS);
  return (
    <Box
      borderStyle="single"
      borderColor={focused ? 'cyan' : undefined}
      paddingX={1}
      flexDirection="column"
      marginLeft={1}
    >
      <Text bold>execution</Text>
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

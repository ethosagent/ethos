import { Box, Text } from 'ink';

export interface FileActivity {
  id: string;
  at: string;
  action: 'read' | 'write' | 'patch';
  path: string;
  status: 'active' | 'done' | 'error' | 'approval_required' | 'approved' | 'denied';
}

interface FileActivityPanelProps {
  entries: FileActivity[];
  focused?: boolean;
  selectedId?: string;
}

const MAX_ENTRIES = 20;

function colorFor(status: FileActivity['status']): string {
  switch (status) {
    case 'approval_required':
      return 'yellow';
    case 'approved':
      return 'green';
    case 'denied':
      return 'red';
    case 'done':
      return 'green';
    case 'error':
      return 'red';
    default:
      return 'yellow';
  }
}

export function FileActivityPanel({
  entries,
  focused = false,
  selectedId,
}: FileActivityPanelProps) {
  const visible = entries.slice(-MAX_ENTRIES);
  const pendingPatches = visible.filter((e) => e.status === 'approval_required').length;

  return (
    <Box
      borderStyle="single"
      borderColor={focused ? 'cyan' : undefined}
      paddingX={1}
      marginBottom={1}
      flexDirection="column"
    >
      <Text bold>file activity</Text>
      <Text dimColor>pending patches: {pendingPatches}</Text>
      <Text dimColor>a=approve d=deny (files focus)</Text>
      {visible.length === 0 ? (
        <Text dimColor>no file activity yet</Text>
      ) : (
        visible.map((entry) => (
          <Box key={entry.id}>
            <Text dimColor>{entry.at}</Text>
            <Text> </Text>
            <Text color={colorFor(entry.status)} inverse={entry.id === selectedId}>
              {entry.action} {entry.path} [{entry.status}]
            </Text>
          </Box>
        ))
      )}
    </Box>
  );
}

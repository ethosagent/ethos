import { Box, Text } from 'ink';
import { useSkin } from '../skin';

export interface FileActivity {
  id: string;
  at: string;
  action: 'read' | 'write' | 'patch';
  path: string;
  status: 'active' | 'done' | 'error' | 'approval_required' | 'approved' | 'denied';
  diff?: string;
}

interface FileActivityPanelProps {
  entries: FileActivity[];
  focused?: boolean;
  selectedId?: string;
}

const MAX_ENTRIES = 20;

function actionGlyph(action: FileActivity['action']): string {
  switch (action) {
    case 'write':
      return '✎';
    case 'patch':
      return '✏';
    default:
      return '◎';
  }
}

function InlineDiff({ diff, maxLines = 8 }: { diff: string; maxLines?: number }) {
  const tokens = useSkin();
  const lines = diff
    .split('\n')
    .filter((l) => l.startsWith('+') || l.startsWith('-') || l.startsWith('@'));
  const visible = lines.slice(0, maxLines);
  const truncated = lines.length > maxLines;
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {visible.map((line, i) => {
        const color = line.startsWith('+')
          ? tokens.semantic.success
          : line.startsWith('-')
            ? tokens.semantic.error
            : tokens.surface.textSecondary;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable diff lines
          <Text key={i} color={color}>
            {line.slice(0, 100)}
          </Text>
        );
      })}
      {truncated && <Text dimColor>({lines.length - maxLines} more lines)</Text>}
    </Box>
  );
}

export function FileActivityPanel({
  entries,
  focused = false,
  selectedId,
}: FileActivityPanelProps) {
  const tokens = useSkin();
  const colorFor = (status: FileActivity['status']): string => {
    switch (status) {
      case 'approval_required':
        return tokens.semantic.warning;
      case 'approved':
        return tokens.semantic.success;
      case 'denied':
        return tokens.semantic.error;
      case 'done':
        return tokens.semantic.success;
      case 'error':
        return tokens.semantic.error;
      default:
        return tokens.semantic.warning;
    }
  };
  const visible = entries.slice(-MAX_ENTRIES);
  const pendingPatches = visible.filter((e) => e.status === 'approval_required').length;

  return (
    <Box marginBottom={1} flexDirection="column">
      <Text dimColor color={focused ? tokens.semantic.info : undefined}>
        {'─── '}
        <Text bold color={focused ? tokens.semantic.info : tokens.surface.textPrimary}>
          file activity
        </Text>
        {' ───'}
      </Text>
      {pendingPatches > 0 && (
        <Text color={tokens.semantic.warning} dimColor>
          {pendingPatches} pending · a=approve d=deny
        </Text>
      )}
      {visible.length === 0 ? (
        <Text dimColor>no file activity yet</Text>
      ) : (
        visible.map((entry) => (
          <Box key={entry.id} flexDirection="column">
            <Box>
              <Text dimColor>{entry.at}</Text>
              <Text> </Text>
              <Text color={colorFor(entry.status)} inverse={entry.id === selectedId}>
                {actionGlyph(entry.action)} {entry.action} {entry.path} [{entry.status}]
              </Text>
            </Box>
            {entry.diff && entry.id === selectedId && <InlineDiff diff={entry.diff} />}
          </Box>
        ))
      )}
    </Box>
  );
}

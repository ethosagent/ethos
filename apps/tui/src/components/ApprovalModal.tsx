// ApprovalModal — a tool call is suspended in `before_tool_call` waiting for a
// human (the terminal approval gate, apps/ethos/src/terminal-approval.ts).
// Opens over the App like ClarifyModal. `y` allows; `n`, Esc or Enter deny —
// deny is the default, as on the readline prompt. Only the request at the head
// of the queue is shown; `queued` counts the ones waiting behind it.
//
// Reason and args arrive already redacted and truncated by the host
// (`createTerminalApprovalSource`); this component renders them as-is.

import type { BridgeApprovalRequest } from '@ethosagent/agent-bridge';
import { Box, Text, useInput } from 'ink';
import { useSkin } from '../skin';

interface ApprovalModalProps {
  request: BridgeApprovalRequest;
  /** Requests waiting behind this one. */
  queued: number;
  onDecide: (decision: 'allow' | 'deny') => void;
}

export function ApprovalModal({ request, queued, onDecide }: ApprovalModalProps) {
  const tokens = useSkin();

  useInput((input, key) => {
    if (key.escape || key.return) {
      onDecide('deny');
      return;
    }
    const ch = input.toLowerCase();
    if (ch === 'y') onDecide('allow');
    else if (ch === 'n') onDecide('deny');
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold color={tokens.semantic.warning}>
        approval needed · {request.toolName}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color={tokens.surface.textSecondary}>reason </Text>
          {request.reason}
        </Text>
        <Text>
          <Text color={tokens.surface.textSecondary}>args </Text>
          {request.argsPreview}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          y allow · n / Esc / Enter deny
          {queued > 0 ? ` · ${queued} more waiting` : ''}
        </Text>
      </Box>
    </Box>
  );
}

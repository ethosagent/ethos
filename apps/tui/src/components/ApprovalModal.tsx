// ApprovalModal — a tool call is suspended in `before_tool_call` waiting for a
// human (the terminal approval gate, apps/ethos/src/terminal-approval.ts).
// Opens over the App like ClarifyModal. `y` allows; `n`, Esc or Enter deny —
// deny is the default, as on the readline prompt. `r` opens note mode: the text
// typed there is sent with the deny so the model is told what to do instead. Only the request at the head
// of the queue is shown; `queued` counts the ones waiting behind it.
//
// Reason and args arrive already redacted and truncated by the host
// (`createTerminalApprovalSource`); this component renders them as-is.

import type { BridgeApprovalRequest } from '@ethosagent/agent-bridge';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { useSkin } from '../skin';

interface ApprovalModalProps {
  request: BridgeApprovalRequest;
  /** Requests waiting behind this one. */
  queued: number;
  onDecide: (decision: 'allow' | 'deny', note?: string) => void;
}

export function ApprovalModal({ request, queued, onDecide }: ApprovalModalProps) {
  const tokens = useSkin();
  const [noteMode, setNoteMode] = useState(false);
  const [text, setText] = useState('');

  useInput((input, key) => {
    if (noteMode) {
      if (key.escape) {
        setNoteMode(false);
        setText('');
        return;
      }
      if (key.return) {
        const note = text.trim();
        if (note) onDecide('deny', note);
        return;
      }
      if (key.backspace || key.delete) {
        setText((t) => t.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) setText((t) => t + input);
      return;
    }
    if (key.escape || key.return) {
      onDecide('deny');
      return;
    }
    const ch = input.toLowerCase();
    if (ch === 'y') onDecide('allow');
    else if (ch === 'n') onDecide('deny');
    else if (ch === 'r') setNoteMode(true);
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
      {request.hiddenChars !== undefined && request.hiddenChars > 0 ? (
        <Text color={tokens.semantic.warning}>
          {request.hiddenChars} hidden character(s) shown as ⟨U+…⟩ — what runs may differ from what
          you read.
        </Text>
      ) : null}
      {noteMode ? (
        <Box marginTop={1} flexDirection="column">
          <Text>
            <Text color={tokens.surface.textSecondary}>instead </Text>
            {text}
            <Text inverse> </Text>
          </Text>
          <Text dimColor>type what it should do instead · Enter deny with note · Esc back</Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text dimColor>
            y allow · n / Esc / Enter deny · r deny and redirect
            {queued > 0 ? ` · ${queued} more waiting` : ''}
          </Text>
        </Box>
      )}
    </Box>
  );
}

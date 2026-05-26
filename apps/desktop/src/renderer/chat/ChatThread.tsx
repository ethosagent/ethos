import type { StoredMessage } from '@ethosagent/web-contracts';
import { useCallback, useEffect, useRef } from 'react';
import { AssistantMessage } from './AssistantMessage';
import { MessageBubble } from './MessageBubble';
import type { ApprovalState, ClarifyState, ToolCallState, UsageState } from './types';

interface ChatThreadProps {
  messages: StoredMessage[];
  streamingText: string;
  streamingThinking: string;
  toolCalls: Map<string, ToolCallState>;
  pendingApproval: ApprovalState | null;
  pendingClarify: ClarifyState | null;
  usage: UsageState | null;
  streaming: boolean;
  onApprove: (approvalId: string) => void;
  onDeny: (approvalId: string) => void;
  onClarifyRespond: (requestId: string, answer: string) => void;
  onRetry: () => void;
}

export function ChatThread({
  messages,
  streamingText,
  streamingThinking,
  toolCalls,
  pendingApproval,
  pendingClarify,
  usage,
  streaming,
  onApprove,
  onDeny,
  onClarifyRespond,
  onRetry,
}: ChatThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    autoScrollRef.current = distFromBottom < 60;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are intentional scroll-to-bottom triggers
  useEffect(() => {
    const el = scrollRef.current;
    if (el && autoScrollRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, streamingText, streamingThinking, toolCalls.size, pendingApproval, pendingClarify]);

  const toolCallArray = Array.from(toolCalls.values());

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '24px 32px',
        maxWidth: 800,
        width: '100%',
        margin: '0 auto',
      }}
    >
      {messages.map((msg) => {
        if (msg.role === 'user' || msg.role === 'user_steer') {
          return <MessageBubble key={msg.id} content={msg.content} timestamp={msg.timestamp} />;
        }
        if (msg.role === 'assistant') {
          return <AssistantMessage key={msg.id} content={msg.content} />;
        }
        return null;
      })}

      {streaming && (
        <AssistantMessage
          content={streamingText}
          thinking={streamingThinking || undefined}
          toolCalls={toolCallArray.length > 0 ? toolCallArray : undefined}
          pendingApproval={pendingApproval ?? undefined}
          pendingClarify={pendingClarify ?? undefined}
          streaming
          onApprove={onApprove}
          onDeny={onDeny}
          onClarifyRespond={onClarifyRespond}
          onRetry={onRetry}
          usage={usage ?? undefined}
        />
      )}

      {!streaming && messages.length === 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'var(--text-tertiary)',
            fontFamily: 'var(--font-display)',
            fontSize: 14,
          }}
        >
          Start a conversation
        </div>
      )}
    </div>
  );
}

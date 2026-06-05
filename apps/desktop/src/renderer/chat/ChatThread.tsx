import type { StoredMessage } from '@ethosagent/web-contracts';
import { useCallback, useEffect, useRef } from 'react';
import { PersonalityRingAvatar } from '../ui/PersonalityRingAvatar';
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
  onSend?: (text: string) => void;
  error?: string | null;
  personalityId?: string | null;
  personalityName?: string | null;
  modelLabel?: string | null;
}

const SUGGESTION_PILLS = [
  'Summarize my last session',
  'What can you help with?',
  'Draft an email',
  'Explain a concept',
];

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
  onSend,
  error,
  personalityId,
  personalityName,
  modelLabel,
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
        padding: '24px 16px',
        maxWidth: 720,
        width: '100%',
        margin: '0 auto',
      }}
    >
      {messages.map((msg) => {
        if (msg.role === 'user' || msg.role === 'user_steer') {
          return (
            <MessageBubble
              key={msg.id}
              content={msg.content}
              timestamp={msg.timestamp}
              isSteer={msg.role === 'user_steer'}
            />
          );
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

      {!streaming && error && (
        <div
          style={{
            margin: '8px 0',
            padding: '10px 14px',
            backgroundColor: 'color-mix(in srgb, var(--error) 10%, transparent)',
            border: '1px solid color-mix(in srgb, var(--error) 30%, transparent)',
            borderRadius: 'var(--radius-sm)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <span style={{ fontSize: 13, color: 'var(--error)', fontFamily: 'var(--font-display)' }}>
            {error}
          </span>
          <button
            type="button"
            onClick={onRetry}
            style={{
              fontSize: 12,
              fontFamily: 'var(--font-display)',
              color: 'var(--error)',
              background: 'none',
              border: '1px solid var(--error)',
              borderRadius: 'var(--radius-sm)',
              padding: '3px 10px',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            Retry
          </button>
        </div>
      )}

      {!streaming && messages.length === 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            gap: 12,
          }}
        >
          <PersonalityRingAvatar
            personalityId={personalityId ?? 'default'}
            name={personalityName ?? 'Default'}
            size={56}
          />
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              fontWeight: 500,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--text-secondary)',
            }}
          >
            {personalityName ?? 'Default'}
          </span>
          {modelLabel && (
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'var(--text-tertiary)',
              }}
            >
              {modelLabel}
            </span>
          )}
          <span
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 14,
              color: 'var(--text-tertiary)',
              marginTop: 4,
            }}
          >
            Ready to help.
          </span>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              justifyContent: 'center',
              marginTop: 8,
              maxWidth: 400,
            }}
          >
            {SUGGESTION_PILLS.map((pill) => (
              <button
                key={pill}
                type="button"
                onClick={() => onSend?.(pill)}
                style={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-full)',
                  padding: '6px 14px',
                  fontFamily: 'var(--font-display)',
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  transition:
                    'border-color var(--motion-fast) var(--ease), color var(--motion-fast) var(--ease)',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.borderColor = 'var(--blue)';
                  (e.currentTarget as HTMLElement).style.color = 'var(--text-primary)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-subtle)';
                  (e.currentTarget as HTMLElement).style.color = 'var(--text-secondary)';
                }}
              >
                {pill}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef } from 'react';
import type { AssistantTurn, ChatMessage } from '../../lib/chat-reducer';
import { PersonalityRingAvatar } from '../ui/PersonalityRingAvatar';
import { AssistantBubble, UserBubble } from './MessageBubble';

// Scrollable history. Auto-scrolls to the bottom as content arrives —
// but only when the user was already pinned to the bottom, so reading
// older messages doesn't get yanked back down by every text_delta.

export interface MessageListProps {
  messages: ChatMessage[];
  /** In-flight assistant turn rendered at the tail of the list. */
  currentTurn: AssistantTurn | null;
  personalityId?: string;
  model?: string;
  /** Called when the user clicks a suggestion pill in the empty state. */
  onPillClick?: (text: string) => void;
}

export function MessageList({
  messages,
  currentTurn,
  personalityId,
  model,
  onPillClick,
}: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedToBottomRef.current = fromBottom < 32;
  };

  // Re-run on every visible change. The `currentTurn` reference is the
  // signal — its blocks update on every text_delta / tool_start /
  // tool_end. messages.length flips on done.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps trigger the effect intentionally — re-run on every new chunk so the scroll catches up
  useEffect(() => {
    if (!pinnedToBottomRef.current) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, currentTurn]);

  if (messages.length === 0 && !currentTurn) {
    return <EmptyState personalityId={personalityId} model={model} onPillClick={onPillClick} />;
  }

  // Derived "thinking" state: the user just sent a message, no SSE event
  // has arrived yet (currentTurn null), and there's no error. Shows a
  // pulsing placeholder bubble so the user sees the agent is alive even
  // before the first text_delta lands. The first event clears it (because
  // currentTurn becomes non-null and the live streaming bubble takes over).
  const lastMessage = messages[messages.length - 1];
  const isThinking = lastMessage?.role === 'user' && !currentTurn;

  return (
    <div ref={listRef} className="message-list" onScroll={onScroll}>
      {messages.map((m) =>
        m.role === 'user' ? (
          <UserBubble key={m.id} message={m} />
        ) : (
          <AssistantBubble key={m.id} turn={m} />
        ),
      )}
      {currentTurn ? <AssistantBubble turn={currentTurn} streaming /> : null}
      {isThinking ? <ThinkingBubble /> : null}
    </div>
  );
}

function ThinkingBubble() {
  return (
    <div className="message-row message-row-assistant">
      <div
        role="status"
        className="message-assistant message-thinking"
        aria-label="Agent is thinking"
      >
        <span className="thinking-dot" />
        <span className="thinking-dot" />
        <span className="thinking-dot" />
      </div>
    </div>
  );
}

const DEFAULT_PILLS = [
  'Explore a topic',
  'Explain this file',
  'Search memory',
  'Run a skill',
] as const;

function EmptyState({
  personalityId,
  model,
  onPillClick,
}: {
  personalityId?: string;
  model?: string;
  onPillClick?: (text: string) => void;
}) {
  const displayName = personalityId ? capitalize(personalityId) : '';
  return (
    <div className="message-list-empty">
      {personalityId ? (
        <PersonalityRingAvatar personalityId={personalityId} name={displayName} size={56} />
      ) : null}
      {personalityId ? <div className="empty-state-name">{personalityId.toUpperCase()}</div> : null}
      {model ? <div className="empty-state-model">{model}</div> : null}
      <div className="empty-state-tagline">Ready to help.</div>
      <div className="empty-state-pills">
        {DEFAULT_PILLS.map((p) => (
          <button
            key={p}
            type="button"
            className="empty-state-pill"
            onClick={() => onPillClick?.(p)}
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

function capitalize(s: string): string {
  return s ? s[0]?.toUpperCase() + s.slice(1) : '';
}

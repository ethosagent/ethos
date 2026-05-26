import { useEffect, useRef } from 'react';
import type { AssistantTurn, ChatMessage } from '../../lib/chat-reducer';
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
}

export function MessageList({ messages, currentTurn, personalityId, model }: MessageListProps) {
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
    return <EmptyState personalityId={personalityId} model={model} />;
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

function EmptyState({ personalityId, model }: { personalityId?: string; model?: string }) {
  return (
    <div className="message-list-empty">
      <PersonalityMark />
      {personalityId ? <div className="empty-state-name">{personalityId}</div> : null}
      {model ? <div className="empty-state-model">{model}</div> : null}
      <div className="empty-state-tagline">Ready to help.</div>
      <div className="empty-state-pills">
        {DEFAULT_PILLS.map((p) => (
          <button key={p} type="button" className="empty-state-pill">
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

function PersonalityMark() {
  return (
    <svg
      className="empty-state-mark"
      width="48"
      height="48"
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
    >
      <rect width="48" height="48" rx="7.68" fill="#4A9EFF" opacity="0.133" />
      <rect x="0" y="0" width="9.6" height="9.6" fill="#4A9EFF" opacity="0.93" />
      <rect x="38.4" y="0" width="9.6" height="9.6" fill="#4A9EFF" opacity="0.93" />
      <rect x="9.6" y="9.6" width="9.6" height="9.6" fill="#4A9EFF" opacity="0.81" />
      <rect x="28.8" y="9.6" width="9.6" height="9.6" fill="#4A9EFF" opacity="0.81" />
      <rect x="19.2" y="19.2" width="9.6" height="9.6" fill="#4A9EFF" opacity="0.55" />
      <rect x="9.6" y="28.8" width="9.6" height="9.6" fill="#4A9EFF" opacity="0.68" />
      <rect x="28.8" y="28.8" width="9.6" height="9.6" fill="#4A9EFF" opacity="0.68" />
      <rect x="0" y="38.4" width="9.6" height="9.6" fill="#4A9EFF" opacity="0.55" />
      <rect x="38.4" y="38.4" width="9.6" height="9.6" fill="#4A9EFF" opacity="0.55" />
    </svg>
  );
}

import { personalityAccent } from '@ethosagent/design-tokens';
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ChatErrorBanner } from '../components/chat/ChatErrorBanner';
import { StatusLine } from '../components/chat/StatusLine';
import { useActivePersonality } from '../hooks/useActivePersonality';
import { useChat } from '../hooks/useChat';
import type { ChatMessage } from '../lib/chat-reducer';
import { notifyQuickChatDone } from '../lib/desktop/quickChatBridge';

// The desktop QuickChat window (W3, ux-feedback plan) — no longer a black box:
//   • the chat status slot (`StatusLine`) says what the agent is doing,
//   • errors render through the shared A3 banner (`describeChatError`),
//   • Stop is bound to the same abort the main chat uses,
//   • Enter while streaming QUEUES the draft — it sends when the reply ends,
//   • a reply that finishes while the window is hidden raises an OS
//     notification through the desktop bridge (`quickChat.notifyDone` →
//     `showBackgroundNotification` → `navigate:session`).
// Styling is token classes in styles.css — no inline monospace, no raw
// white-alpha tints (W5).

/** Every block, not just text: an artifact-only reply must not read as empty. */
export function extractText(msg: ChatMessage): string {
  if (msg.role === 'user') return msg.content;
  return msg.blocks
    .map((b) => {
      if (b.kind === 'text') return b.content;
      if (b.kind === 'image') return '[image]';
      if (b.kind === 'html') return '[html]';
      if (b.kind === 'pdf') return '[pdf]';
      if (b.kind === 'card') return '[card]';
      return '[delegated run]';
    })
    .filter((part) => part !== '')
    .join(' ');
}

const NOTIFY_BODY_CHARS = 120;

export function QuickChat() {
  const { id: personalityId, model } = useActivePersonality();
  const accent = personalityAccent(personalityId);
  const [draft, setDraft] = useState('');
  // Enter pressed while a turn was streaming: the draft is queued and sends
  // itself the moment the turn ends, instead of the keypress doing nothing.
  const [queued, setQueued] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { state, currentSessionId, sendMessage, abortTurn, clearError } = useChat({
    personalityId,
  });

  // Esc closes the window (works in Electron for non-main windows).
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') window.close();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Auto-scroll on new messages.
  const messageCount = state.messages.length;
  const streamTurnId = state.currentTurn?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls on message change
  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messageCount, streamTurnId]);

  // Focus textarea on mount.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    if (state.isStreaming) {
      // Queue instead of dropping the keypress: the draft stays put and the
      // turn's end sends it (below).
      setQueued(true);
      return;
    }
    setQueued(false);
    setDraft('');
    await sendMessage(text);
  }, [draft, state.isStreaming, sendMessage]);

  // The queued draft goes out when the turn ends. Cancelled by editing the
  // draft to empty; kept across re-renders otherwise.
  const isStreaming = state.isStreaming;
  useEffect(() => {
    if (!queued || isStreaming) return;
    const text = draft.trim();
    setQueued(false);
    if (!text) return;
    setDraft('');
    void sendMessage(text);
  }, [queued, isStreaming, draft, sendMessage]);

  // W3 — a reply that finishes while this window is hidden becomes an OS
  // notification. `phase` is non-null for the whole turn and null once it
  // finalises, so the transition IS "done arrived".
  const phase = state.phase;
  const prevPhaseRef = useRef(phase);
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;
    if (prev === null || phase !== null) return;
    if (!document.hidden) return;
    const lastReply = [...state.messages].reverse().find((m) => m.role === 'assistant');
    const body = lastReply ? extractText(lastReply).slice(0, NOTIFY_BODY_CHARS) : 'Reply ready.';
    notifyQuickChatDone({
      sessionId: currentSessionId,
      title: `${personalityId} replied`,
      body,
    });
  }, [phase, state.messages, currentSessionId, personalityId]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  const handleOpenInMain = useCallback(() => {
    window.postMessage({ type: 'quick-chat:open-in-main' }, '*');
    window.close();
  }, []);

  // Show last ~3 pairs (6 messages) plus the in-flight turn.
  const recent = state.messages.slice(-6);
  const streamTurn = state.currentTurn;

  return (
    <div className="quickchat-root">
      {/* Accent stripe + model tag */}
      <div className="quickchat-accent" style={{ background: accent }} />
      <div className="quickchat-header">
        <span className="quickchat-model">{model}</span>
        <div className="quickchat-header-actions">
          {state.isStreaming ? (
            <button
              type="button"
              className="quickchat-stop-btn"
              onClick={() => void abortTurn()}
              aria-label="Stop"
            >
              Stop
            </button>
          ) : null}
          <button type="button" className="quickchat-open-main" onClick={handleOpenInMain}>
            open in main
          </button>
        </div>
      </div>

      {/* Mini-transcript */}
      <div ref={scrollRef} className="quickchat-transcript">
        {recent.map((msg) => (
          <div key={msg.id} className={`quickchat-msg quickchat-msg-${msg.role}`}>
            <span className="quickchat-msg-role">{msg.role === 'user' ? 'you' : 'agent'}:</span>
            {extractText(msg)}
          </div>
        ))}
        {streamTurn ? (
          <div className="quickchat-msg quickchat-msg-assistant">
            <span className="quickchat-msg-role">agent:</span>
            {extractText(streamTurn)}
          </div>
        ) : null}
      </div>

      {/* The chat status slot, reused — the words are the feedback. */}
      <StatusLine
        phase={state.phase}
        label={state.currentOp}
        elapsedMs={0}
        stalled={false}
        thinking={state.thinking}
        reconnecting={state.connection === 'reconnecting'}
      />
      {state.error ? <ChatErrorBanner error={state.error} onDismiss={clearError} /> : null}

      {/* Composer */}
      <div className="quickchat-composer">
        {queued ? (
          <div className="quickchat-queued" role="status">
            queued — sends when the current reply finishes
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (e.target.value.trim() === '') setQueued(false);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Ask something..."
          rows={2}
        />
      </div>
    </div>
  );
}

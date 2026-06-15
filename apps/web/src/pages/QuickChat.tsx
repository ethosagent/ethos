import { personalityAccent } from '@ethosagent/design-tokens';
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useActivePersonality } from '../hooks/useActivePersonality';
import { useChat } from '../hooks/useChat';
import type { AssistantTurn, ChatMessage, UserMessage } from '../lib/chat-reducer';

function extractText(msg: ChatMessage): string {
  if (msg.role === 'user') return (msg as UserMessage).content;
  const turn = msg as AssistantTurn;
  return turn.blocks
    .filter((b) => b.kind === 'text')
    .map((b) => b.content)
    .join('');
}

export function QuickChat() {
  const { id: personalityId, model } = useActivePersonality();
  const accent = personalityAccent(personalityId);
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { state, sendMessage } = useChat({ personalityId });

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
    if (!text || state.isStreaming) return;
    setDraft('');
    await sendMessage(text);
  }, [draft, state.isStreaming, sendMessage]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Accent stripe + model tag */}
      <div style={{ background: accent, height: 3, flexShrink: 0 }} />
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '4px 8px',
          flexShrink: 0,
        }}
      >
        <span style={{ fontFamily: 'monospace', fontSize: 11, opacity: 0.6 }}>{model}</span>
        <button
          type="button"
          onClick={handleOpenInMain}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 11,
            opacity: 0.6,
            color: 'inherit',
          }}
        >
          open in main
        </button>
      </div>

      {/* Mini-transcript */}
      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: '4px 8px' }}>
        {recent.map((msg) => (
          <div
            key={msg.id}
            style={{
              marginBottom: 6,
              fontSize: 13,
              opacity: msg.role === 'user' ? 0.85 : 1,
            }}
          >
            <span style={{ fontWeight: 600, marginRight: 4 }}>
              {msg.role === 'user' ? 'you' : 'agent'}:
            </span>
            {extractText(msg)}
          </div>
        ))}
        {streamTurn && (
          <div style={{ marginBottom: 6, fontSize: 13 }}>
            <span style={{ fontWeight: 600, marginRight: 4 }}>agent:</span>
            {extractText(streamTurn)}
          </div>
        )}
      </div>

      {/* Composer */}
      <div style={{ flexShrink: 0, padding: '4px 8px 8px' }}>
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask something..."
          rows={2}
          style={{
            width: '100%',
            resize: 'none',
            fontFamily: 'inherit',
            fontSize: 13,
            padding: '6px 8px',
            borderRadius: 4,
            border: '1px solid rgba(255,255,255,0.15)',
            background: 'rgba(255,255,255,0.05)',
            color: 'inherit',
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
      </div>
    </div>
  );
}

import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useDebugChat } from '../hooks/useDebugChat';

export interface DebugPanelProps {
  sessionId: string | null;
}

export function DebugPanel({ sessionId }: DebugPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [input, setInput] = useState('');
  const { messages, loading, sendMessage, clearMessages } = useDebugChat(sessionId);
  const scrollRef = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages triggers scroll to bottom on new arrivals
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleSend = useCallback(() => {
    if (!input.trim() || loading) return;
    void sendMessage(input);
    setInput('');
  }, [input, loading, sendMessage]);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <section className={`debug-panel${collapsed ? ' debug-panel--collapsed' : ''}`}>
      <button type="button" className="debug-panel-header" onClick={() => setCollapsed((c) => !c)}>
        <span className="debug-panel-title">Debug</span>
        <span style={{ display: 'flex', gap: 4 }}>
          {messages.length > 0 && (
            <button
              type="button"
              className="debug-panel-clear"
              onClick={(e) => {
                e.stopPropagation();
                clearMessages();
              }}
              aria-label="Clear"
            >
              ×
            </button>
          )}
          <span className="debug-panel-chevron">{collapsed ? '▼' : '▲'}</span>
        </span>
      </button>

      {!collapsed && (
        <div className="debug-panel-body">
          <div className="debug-panel-messages" ref={scrollRef}>
            {!sessionId ? (
              <div className="debug-panel-empty">Start a conversation to enable the debugger.</div>
            ) : messages.length === 0 ? (
              <div className="debug-panel-empty">Ask about this session...</div>
            ) : (
              messages.map((msg) => (
                <div key={msg.id} className={`debug-msg debug-msg--${msg.role}`}>
                  {msg.content}
                </div>
              ))
            )}
          </div>

          <div className="debug-panel-input-row">
            <input
              type="text"
              className="debug-panel-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about this session..."
              disabled={!sessionId || loading}
            />
            <button
              type="button"
              className="debug-panel-send"
              onClick={handleSend}
              disabled={!sessionId || loading || !input.trim()}
            >
              ↵
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

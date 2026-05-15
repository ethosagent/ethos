'use client';

import { EventStream } from '@ethosagent/sdk';
import type { SseEvent } from '@ethosagent/web-contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { baseUrl, ethos } from '@/lib/ethos';

interface ChatPanelProps {
  sessionId: string | null;
  personalityId: string | null;
  onSessionCreated: (id: string) => void;
}

let nextId = 0;

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  done?: boolean;
}

export function ChatPanel({ sessionId, personalityId, onSessionCreated }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const subscriptionRef = useRef<ReturnType<typeof EventStream> | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every message change
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Subscribe to SSE when session changes
  useEffect(() => {
    if (subscriptionRef.current) {
      subscriptionRef.current.close();
      subscriptionRef.current = null;
    }

    if (!sessionId) return;

    const handleEvent = (event: SseEvent) => {
      switch (event.type) {
        case 'text_delta':
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant' && !last.done) {
              return [...prev.slice(0, -1), { ...last, content: last.content + event.text }];
            }
            return [...prev, { id: nextId++, role: 'assistant', content: event.text }];
          });
          break;

        case 'tool_start':
          setMessages((prev) => [
            ...prev,
            { id: nextId++, role: 'tool', content: `Using tool: ${event.toolName}...`, done: true },
          ]);
          break;

        case 'tool_end':
          setMessages((prev) => [
            ...prev,
            {
              role: 'tool',
              id: nextId++,
              content: `Tool ${event.toolName}: ${event.ok ? 'completed' : 'failed'} (${event.durationMs}ms)`,
              done: true,
            },
          ]);
          break;

        case 'done':
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant' && !last.done) {
              return [...prev.slice(0, -1), { ...last, done: true }];
            }
            return prev;
          });
          setSending(false);
          break;

        case 'error':
          setMessages((prev) => [
            ...prev,
            { id: nextId++, role: 'tool', content: `Error: ${event.error}`, done: true },
          ]);
          setSending(false);
          break;
      }
    };

    const sub = EventStream({
      baseUrl,
      apiKey: process.env.NEXT_PUBLIC_ETHOS_API_KEY ?? '',
      sessionId,
      onEvent: handleEvent,
      onError: (err) => console.error('SSE error:', err),
    });

    subscriptionRef.current = sub;

    return () => {
      sub.close();
    };
  }, [sessionId]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;

    setInput('');
    setSending(true);
    setMessages((prev) => [...prev, { id: nextId++, role: 'user', content: text, done: true }]);

    try {
      const res = await ethos.rpc.chat.send({
        sessionId: sessionId ?? undefined,
        clientId: 'mission-control',
        text,
        personalityId: personalityId ?? undefined,
      });

      if (!sessionId) {
        onSessionCreated(res.sessionId);
      }
    } catch (err) {
      console.error('Failed to send:', err);
      setMessages((prev) => [
        ...prev,
        { id: nextId++, role: 'tool', content: `Send failed: ${String(err)}`, done: true },
      ]);
      setSending(false);
    }
  }, [input, sending, sessionId, personalityId, onSessionCreated]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <div className="flex flex-col border-r border-gray-200 dark:border-gray-800">
      <div className="border-b border-gray-200 p-3 dark:border-gray-800">
        <h2 className="text-sm font-semibold">
          Chat{sessionId ? ` — ${sessionId.slice(0, 8)}` : ''}
        </h2>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="text-sm text-gray-500">
            {sessionId ? 'No messages yet.' : 'Type a message to start a new session.'}
          </p>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`rounded px-3 py-2 text-sm ${
              msg.role === 'user'
                ? 'ml-8 bg-blue-100 dark:bg-blue-900'
                : msg.role === 'tool'
                  ? 'bg-gray-100 font-mono text-xs dark:bg-gray-800'
                  : 'mr-8 bg-gray-50 dark:bg-gray-900'
            }`}
          >
            <p className="mb-1 text-xs font-semibold text-gray-500">
              {msg.role === 'user' ? 'You' : msg.role === 'tool' ? 'Tool' : 'Assistant'}
            </p>
            <p className="whitespace-pre-wrap">{msg.content}</p>
          </div>
        ))}
        {sending && <p className="animate-pulse text-xs text-gray-400">Thinking...</p>}
      </div>

      <div className="border-t border-gray-200 p-3 dark:border-gray-800">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            disabled={sending}
            className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-400 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900"
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={sending || !input.trim()}
            className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

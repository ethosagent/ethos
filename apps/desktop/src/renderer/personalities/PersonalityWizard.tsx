import { createEthosClient, EventStream } from '@ethosagent/sdk';
import type { SseEvent } from '@ethosagent/web-contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AssistantMessage } from '../chat/AssistantMessage';
import { Composer } from '../chat/Composer';
import { MessageBubble } from '../chat/MessageBubble';
import type { ToolCallState } from '../chat/types';
import { useServerUrl } from '../shell/ServerUrl';

interface PersonalityWizardProps {
  onClose: () => void;
  onCreated: (personalityId: string) => void;
}

interface WizardMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCallState[];
}

const CLIENT_ID = `wizard-${Math.random().toString(36).slice(2)}`;

export function PersonalityWizard({ onClose, onCreated }: PersonalityWizardProps) {
  const baseUrl = useServerUrl();
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [messages, setMessages] = useState<WizardMessage[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [streamingThinking, setStreamingThinking] = useState('');
  const [toolCalls, setToolCalls] = useState<Map<string, ToolCallState>>(new Map());
  const [streaming, setStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [scaffoldedId, setScaffoldedId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep a ref to streamingText for use inside the 'done' event handler
  const streamingTextRef = useRef(streamingText);
  streamingTextRef.current = streamingText;

  // Auto-scroll to bottom when messages or streaming text changes
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  // Subscribe to SSE events for the wizard session
  useEffect(() => {
    if (!sessionId) return;

    const sub = EventStream({
      baseUrl,
      sessionId,
      onEvent: (event: SseEvent) => {
        switch (event.type) {
          case 'text_delta':
            setStreaming(true);
            setStreamingText((prev) => prev + event.text);
            break;

          case 'thinking_delta':
            setStreamingThinking((prev) => prev + event.thinking);
            break;

          case 'tool_start':
            setToolCalls((prev) => {
              const next = new Map(prev);
              next.set(event.toolCallId, {
                name: event.toolName,
                args: event.args,
                status: 'running',
              });
              return next;
            });
            break;

          case 'tool_end':
            setToolCalls((prev) => {
              const next = new Map(prev);
              const existing = next.get(event.toolCallId);
              if (existing) {
                next.set(event.toolCallId, {
                  ...existing,
                  status: event.ok ? 'ok' : 'error',
                  durationMs: event.durationMs,
                  result: event.result,
                });
              }
              return next;
            });
            break;

          case 'done': {
            const finalText = streamingTextRef.current;
            if (finalText) {
              setMessages((prev) => [
                ...prev,
                { id: `asst-${Date.now()}`, role: 'assistant', content: finalText },
              ]);
              // Detect scaffold completion
              const match = finalText.match(/Personality "([^"]+)" scaffolded successfully/);
              if (match?.[1]) {
                setScaffoldedId(match[1]);
              }
            }
            setStreamingText('');
            setStreamingThinking('');
            setToolCalls(new Map());
            setStreaming(false);
            break;
          }

          default:
            break;
        }
      },
      onError: () => {
        setStreaming(false);
      },
    });

    return () => sub.close();
  }, [sessionId, baseUrl]);

  const handleSend = useCallback(
    async (text: string) => {
      setMessages((prev) => [...prev, { id: `user-${Date.now()}`, role: 'user', content: text }]);
      setStreamingText('');
      setStreamingThinking('');
      setToolCalls(new Map());
      setStreaming(true);

      try {
        const res = await client.rpc.chat.send({
          text,
          sessionId: sessionId ?? undefined,
          clientId: CLIENT_ID,
          personalityId: 'personality-architect',
        });
        if (!sessionId) {
          setSessionId(res.sessionId);
        }
      } catch {
        setStreaming(false);
      }
    },
    [client, sessionId],
  );

  const handleAbort = useCallback(async () => {
    if (!sessionId) return;
    try {
      await client.rpc.chat.abort({ sessionId });
    } catch {
      // best-effort
    }
  }, [client, sessionId]);

  const toolCallsArray = toolCalls.size > 0 ? Array.from(toolCalls.values()) : undefined;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 500,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* Dialog */}
      <div
        style={{
          width: 680,
          height: '80vh',
          background: 'var(--bg-elevated)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border-subtle)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 16px',
            borderBottom: '1px solid var(--border-subtle)',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--text-primary)',
            }}
          >
            Personality Architect
          </span>
          <span
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 12,
              color: 'var(--text-secondary)',
            }}
          >
            {scaffoldedId ? 'Complete' : 'Define your personality'}
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-tertiary)',
              fontSize: 18,
              cursor: 'pointer',
              padding: '0 4px',
              marginLeft: 8,
            }}
          >
            ×
          </button>
        </div>

        {/* Message thread */}
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px',
          }}
        >
          {messages.map((msg) =>
            msg.role === 'user' ? (
              <MessageBubble
                key={msg.id}
                content={msg.content}
                timestamp={new Date().toISOString()}
              />
            ) : (
              <AssistantMessage key={msg.id} content={msg.content} />
            ),
          )}

          {streaming && (
            <AssistantMessage
              content={streamingText}
              thinking={streamingThinking || undefined}
              toolCalls={toolCallsArray}
              streaming
            />
          )}

          {messages.length === 0 && !streaming && (
            <div
              style={{
                padding: '32px 0',
                textAlign: 'center',
                fontFamily: 'var(--font-display)',
                fontSize: 13,
                color: 'var(--text-tertiary)',
              }}
            >
              Say hello to begin. The architect will guide you through creating a new personality.
            </div>
          )}
        </div>

        {/* Footer: success state or composer */}
        {scaffoldedId ? (
          <div
            style={{
              padding: '20px 16px',
              borderTop: '1px solid var(--border-subtle)',
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <div
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 14,
                color: 'var(--success)',
              }}
            >
              ✓ Personality &quot;{scaffoldedId}&quot; created successfully
            </div>
            <button
              type="button"
              onClick={() => {
                onCreated(scaffoldedId);
                onClose();
              }}
              style={{
                background: 'var(--accent)',
                border: 'none',
                color: '#fff',
                borderRadius: 'var(--radius-sm)',
                padding: '8px 20px',
                fontFamily: 'var(--font-display)',
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Done
            </button>
          </div>
        ) : (
          <Composer onSend={handleSend} onAbort={handleAbort} streaming={streaming} />
        )}
      </div>
    </div>
  );
}

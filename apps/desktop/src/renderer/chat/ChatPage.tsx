import { createEthosClient } from '@ethosagent/sdk';
import type { SseEvent, StoredMessage } from '@ethosagent/web-contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppState } from '../state/AppContext';
import { ChatThread } from './ChatThread';
import { Composer } from './Composer';
import { PersonalityBar } from './PersonalityBar';
import { SessionsPanel } from './SessionsPanel';
import type { ApprovalState, ClarifyState, ToolCallState, UsageState } from './types';
import { useSessionList } from './useSessionList';
import { useSSEStream } from './useSSEStream';

const CLIENT_ID = crypto.randomUUID();

export function ChatPage() {
  const { state, setActiveSessionId } = useAppState();
  const { port, activeSessionId, activePersonalityId, desktopUserId } = state;

  const baseUrl = `http://localhost:${port}`;

  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  // Session list
  const sessionList = useSessionList({ baseUrl });

  // Chat state
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [streamingThinking, setStreamingThinking] = useState('');
  const [toolCalls, setToolCalls] = useState<Map<string, ToolCallState>>(new Map());
  const [pendingApproval, setPendingApproval] = useState<ApprovalState | null>(null);
  const [pendingClarify, setPendingClarify] = useState<ClarifyState | null>(null);
  const [usage, setUsage] = useState<UsageState | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [_error, setError] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);

  // Layout state
  const [showSessionsPanel, setShowSessionsPanel] = useState(true);
  const [windowWidth, setWindowWidth] = useState(
    typeof window !== 'undefined' ? window.innerWidth : 1200,
  );

  const isNarrow = windowWidth < 1100;
  const showPanel = showSessionsPanel && !isNarrow;

  useEffect(() => {
    function handleResize() {
      setWindowWidth(window.innerWidth);
    }
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // SSE event handler
  const handleSSEEvent = useCallback(
    (event: SseEvent) => {
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

        case 'tool_progress':
          if (event.audience !== 'user') break;
          setToolCalls((prev) => {
            const next = new Map(prev);
            // Find the most recent running tool with this name
            for (const [id, tc] of next) {
              if (tc.name === event.toolName && tc.status === 'running') {
                next.set(id, { ...tc, progressMessage: event.message });
                break;
              }
            }
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
                progressMessage: undefined,
              });
            }
            return next;
          });
          break;

        case 'usage':
          setUsage({
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            estimatedCostUsd: event.estimatedCostUsd,
          });
          break;

        case 'done': {
          const finalText = streamingTextRef.current;
          if (finalText) {
            const assistantMsg: StoredMessage = {
              id: `stream-${Date.now()}`,
              sessionId: activeSessionId ?? '',
              role: 'assistant',
              content: finalText,
              toolCallId: null,
              toolName: null,
              toolCalls: null,
              timestamp: new Date().toISOString(),
            };
            setMessages((prev) => [...prev, assistantMsg]);
          }
          setStreamingText('');
          setStreamingThinking('');
          setToolCalls(new Map());
          setStreaming(false);
          setError(null);
          break;
        }

        case 'error':
          setError(event.error);
          setStreaming(false);
          break;

        case 'tool.approval_required':
          setPendingApproval({
            approvalId: event.request.approvalId,
            toolName: event.request.toolName,
            args: event.request.args,
            reason: event.request.reason,
          });
          break;

        case 'approval.resolved':
          setPendingApproval(null);
          break;

        case 'clarify.request':
          setPendingClarify({
            requestId: event.requestId,
            question: event.question,
            options: event.options,
            defaultAnswer: event.default,
          });
          break;

        case 'clarify.resolved':
          setPendingClarify(null);
          break;

        default:
          break;
      }
    },
    [activeSessionId],
  );

  // Keep a ref to streamingText for use inside handleSSEEvent's 'done' case
  const streamingTextRef = useRef(streamingText);
  streamingTextRef.current = streamingText;

  // SSE stream
  useSSEStream({
    baseUrl,
    sessionId: activeSessionId,
    onEvent: handleSSEEvent,
  });

  // Load session history when activeSessionId changes
  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      setSessionTitle(null);
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        const res = await client.rpc.sessions.get({ id: activeSessionId as string });
        if (cancelled) return;
        setMessages(res.messages);
        setSessionTitle(res.session.title);
      } catch {
        if (cancelled) return;
        setMessages([]);
        setSessionTitle(null);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, client]);

  // Send message
  const handleSend = useCallback(
    async (text: string) => {
      // Add optimistic user message
      const userMsg: StoredMessage = {
        id: `user-${Date.now()}`,
        sessionId: activeSessionId ?? '',
        role: 'user',
        content: text,
        toolCallId: null,
        toolName: null,
        toolCalls: null,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);

      // Clear previous stream state
      setStreamingText('');
      setStreamingThinking('');
      setToolCalls(new Map());
      setUsage(null);
      setError(null);
      setStreaming(true);

      try {
        const res = await client.rpc.chat.send({
          text,
          sessionId: activeSessionId ?? undefined,
          clientId: CLIENT_ID,
          personalityId: activePersonalityId ?? undefined,
          userId: desktopUserId ?? undefined,
        });

        // If this was a new session, set the active session and refresh list
        if (!activeSessionId) {
          setActiveSessionId(res.sessionId);
          sessionList.refresh();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setStreaming(false);
      }
    },
    [activeSessionId, activePersonalityId, client, setActiveSessionId, sessionList, desktopUserId],
  );

  // Abort
  const handleAbort = useCallback(async () => {
    if (!activeSessionId) return;
    try {
      await client.rpc.chat.abort({ sessionId: activeSessionId });
    } catch {
      // best-effort
    }
  }, [activeSessionId, client]);

  // Approve / deny
  const handleApprove = useCallback(
    async (approvalId: string) => {
      try {
        await client.rpc.tools.approve({
          approvalId,
          clientId: CLIENT_ID,
          scope: 'once',
        });
      } catch {
        // best-effort
      }
    },
    [client],
  );

  const handleDeny = useCallback(
    async (approvalId: string) => {
      try {
        await client.rpc.tools.deny({
          approvalId,
          clientId: CLIENT_ID,
        });
      } catch {
        // best-effort
      }
    },
    [client],
  );

  // Clarify respond
  const handleClarifyRespond = useCallback(
    async (requestId: string, answer: string) => {
      try {
        await client.rpc.clarify.respond({
          requestId,
          answer,
          source: 'user',
        });
      } catch {
        // best-effort
      }
    },
    [client],
  );

  // Retry
  const handleRetry = useCallback(() => {
    // Re-send the last user message
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUserMsg) {
      setError(null);
      handleSend(lastUserMsg.content);
    }
  }, [messages, handleSend]);

  // New chat
  const handleNewChat = useCallback(() => {
    setActiveSessionId(null);
    setMessages([]);
    setStreamingText('');
    setStreamingThinking('');
    setToolCalls(new Map());
    setUsage(null);
    setError(null);
    setStreaming(false);
    setSessionTitle(null);
    setPendingApproval(null);
    setPendingClarify(null);
  }, [setActiveSessionId]);

  // Select session
  const handleSelectSession = useCallback(
    (id: string) => {
      if (id === activeSessionId) return;
      setActiveSessionId(id);
      setStreamingText('');
      setStreamingThinking('');
      setToolCalls(new Map());
      setUsage(null);
      setError(null);
      setStreaming(false);
      setPendingApproval(null);
      setPendingClarify(null);
    },
    [activeSessionId, setActiveSessionId],
  );

  // Subscribe to system events so session titles update in the sidebar
  // and PersonalityBar without requiring a manual refresh.
  useEffect(() => {
    const url = `http://localhost:${port}/sse/system`;
    const source = new EventSource(url, { withCredentials: true });

    source.onmessage = (raw) => {
      try {
        const data = JSON.parse(raw.data as string) as {
          type: string;
          sessionId?: string;
          title?: string;
        };
        if (data.type === 'session.titled' && data.sessionId && data.title) {
          sessionList.refresh();
          if (data.sessionId === activeSessionId) {
            setSessionTitle(data.title);
          }
        }
      } catch {
        // ignore
      }
    };

    return () => source.close();
  }, [port, activeSessionId, sessionList]);

  // Session title change
  const handleTitleChange = useCallback(
    async (title: string) => {
      if (!activeSessionId) return;
      setSessionTitle(title);
      try {
        await client.rpc.sessions.update({ id: activeSessionId, title });
        sessionList.refresh();
      } catch {
        // best-effort
      }
    },
    [activeSessionId, client, sessionList],
  );

  // Session rename from panel
  const handleRenameSession = useCallback(
    async (id: string, title: string) => {
      try {
        await client.rpc.sessions.update({ id, title });
        if (id === activeSessionId) setSessionTitle(title);
        sessionList.refresh();
      } catch {
        // best-effort
      }
    },
    [client, activeSessionId, sessionList],
  );

  // Fork session
  const handleForkSession = useCallback(
    async (id?: string) => {
      const targetId = id ?? activeSessionId;
      if (!targetId) return;
      try {
        const res = await client.rpc.sessions.fork({ id: targetId });
        setActiveSessionId(res.session.id);
        sessionList.refresh();
      } catch {
        // best-effort
      }
    },
    [activeSessionId, client, setActiveSessionId, sessionList],
  );

  // Delete session
  const handleDeleteSession = useCallback(
    async (id: string) => {
      try {
        await client.rpc.sessions.delete({ id });
        if (id === activeSessionId) {
          handleNewChat();
        }
        sessionList.refresh();
      } catch {
        // best-effort
      }
    },
    [activeSessionId, client, sessionList, handleNewChat],
  );

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100%' }}>
      {showPanel && (
        <SessionsPanel
          sessions={sessionList.sessions}
          loading={sessionList.loading}
          search={sessionList.search}
          setSearch={sessionList.setSearch}
          activeSessionId={activeSessionId}
          onSelectSession={handleSelectSession}
          onNewChat={handleNewChat}
          loadMore={sessionList.loadMore}
          hasMore={sessionList.hasMore}
          onRenameSession={handleRenameSession}
          onForkSession={(id) => handleForkSession(id)}
          onDeleteSession={handleDeleteSession}
        />
      )}

      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
        }}
      >
        <PersonalityBar
          personalityId={activePersonalityId}
          sessionTitle={sessionTitle}
          onTitleChange={handleTitleChange}
          onNewSession={handleNewChat}
          onForkSession={() => handleForkSession()}
          streaming={streaming}
          showSessionsButton={isNarrow}
          onToggleSessions={() => setShowSessionsPanel((v) => !v)}
        />

        <ChatThread
          messages={messages}
          streamingText={streamingText}
          streamingThinking={streamingThinking}
          toolCalls={toolCalls}
          pendingApproval={pendingApproval}
          pendingClarify={pendingClarify}
          usage={usage}
          streaming={streaming}
          onApprove={handleApprove}
          onDeny={handleDeny}
          onClarifyRespond={handleClarifyRespond}
          onRetry={handleRetry}
        />

        <Composer
          onSend={handleSend}
          onAbort={handleAbort}
          streaming={streaming}
          personalityName={activePersonalityId ?? undefined}
        />
      </div>
    </div>
  );
}

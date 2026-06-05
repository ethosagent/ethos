import { createEthosClient } from '@ethosagent/sdk';
import { TurnStatusBar } from '@ethosagent/ui-components';
import type { SseEvent, StoredMessage } from '@ethosagent/web-contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppState } from '../state/AppContext';
import { ChatThread } from './ChatThread';
import { Composer } from './Composer';
import { PersonalityBar } from './PersonalityBar';
import type { ApprovalState, ClarifyState, ToolCallState, UsageState } from './types';
import { useSSEStream } from './useSSEStream';

const CLIENT_ID = crypto.randomUUID();

interface ChatPageProps {
  onSessionListDirty?: () => void;
  onForkSession?: (id?: string) => void;
}

export function ChatPage({ onSessionListDirty, onForkSession }: ChatPageProps) {
  const { state, setActiveSessionId, setActivePersonalityId, setLastTitledSession } = useAppState();
  const { port, activeSessionId, activePersonalityId, desktopUserId, lastTitledSession } = state;

  const baseUrl = `http://localhost:${port}`;

  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [streamingThinking, setStreamingThinking] = useState('');
  const [toolCalls, setToolCalls] = useState<Map<string, ToolCallState>>(new Map());
  const [pendingApproval, setPendingApproval] = useState<ApprovalState | null>(null);
  const [pendingClarify, setPendingClarify] = useState<ClarifyState | null>(null);
  const [usage, setUsage] = useState<UsageState | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [currentOp, setCurrentOp] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);

  const isNewSessionAssignment = useRef(false);
  const lastManualTitleRef = useRef<{ sessionId: string; title: string } | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem('ethos:lastPersonalityId');
    if (saved && !state.activePersonalityId) {
      setActivePersonalityId(saved);
    }
  }, [state.activePersonalityId, setActivePersonalityId]);

  const resetChatState = useCallback(() => {
    setMessages([]);
    setStreamingText('');
    setStreamingThinking('');
    setToolCalls(new Map());
    setUsage(null);
    setError(null);
    setStreaming(false);
    setPendingApproval(null);
    setPendingClarify(null);
    setTurnStartedAt(null);
    setCurrentOp(null);
    setElapsedMs(0);
    setSessionTitle(null);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on session switch
  useEffect(() => {
    if (isNewSessionAssignment.current) {
      isNewSessionAssignment.current = false;
      return;
    }
    lastManualTitleRef.current = null;
    resetChatState();
  }, [activeSessionId, resetChatState]);

  const lastStreamEventAtRef = useRef<number | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!streaming) return;
    lastStreamEventAtRef.current = lastStreamEventAtRef.current ?? Date.now();
    const id = setInterval(() => setTick((n) => n + 1), 5_000);
    return () => clearInterval(id);
  }, [streaming]);

  const isStalled =
    streaming &&
    lastStreamEventAtRef.current !== null &&
    Date.now() - lastStreamEventAtRef.current > 30_000;

  useEffect(() => {
    if (!turnStartedAt) return;
    const id = setInterval(() => {
      setElapsedMs(Date.now() - turnStartedAt);
    }, 1000);
    return () => clearInterval(id);
  }, [turnStartedAt]);

  const handleSSEEvent = useCallback(
    (event: SseEvent) => {
      switch (event.type) {
        case 'text_delta':
          lastStreamEventAtRef.current = Date.now();
          setStreaming(true);
          setStreamingText((prev) => prev + event.text);
          break;

        case 'thinking_delta':
          setStreamingThinking((prev) => prev + event.thinking);
          break;

        case 'tool_start':
          lastStreamEventAtRef.current = Date.now();
          setToolCalls((prev) => {
            const next = new Map(prev);
            next.set(event.toolCallId, {
              name: event.toolName,
              args: event.args,
              status: 'running',
            });
            return next;
          });
          setCurrentOp(`⚙ ${event.toolName}`);
          break;

        case 'tool_progress':
          if (event.audience !== 'user') break;
          setToolCalls((prev) => {
            const next = new Map(prev);
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
          lastStreamEventAtRef.current = Date.now();
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
          setCurrentOp('\u{1F4AD} Thinking…');
          break;

        case 'usage':
          setUsage({
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            estimatedCostUsd: event.estimatedCostUsd,
          });
          break;

        case 'done': {
          lastStreamEventAtRef.current = null;
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
          setTurnStartedAt(null);
          setCurrentOp(null);
          setElapsedMs(0);
          break;
        }

        case 'error':
          lastStreamEventAtRef.current = null;
          setError(event.error);
          setStreaming(false);
          setTurnStartedAt(null);
          setCurrentOp(null);
          setElapsedMs(0);
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

        case 'run_start':
          setTurnStartedAt(Date.now());
          setCurrentOp('\u{1F4AD} Thinking…');
          setElapsedMs(0);
          break;

        default:
          break;
      }
    },
    [activeSessionId],
  );

  const streamingTextRef = useRef(streamingText);
  streamingTextRef.current = streamingText;

  useSSEStream({
    baseUrl,
    sessionId: activeSessionId,
    onEvent: handleSSEEvent,
    onError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[sse] connection error:', msg, err);
      setError((prev) => prev ?? (streaming ? `Connection error: ${msg}` : null));
    },
  });

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
        if (res.session.personalityId) {
          setActivePersonalityId(res.session.personalityId);
        }
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
  }, [activeSessionId, client, setActivePersonalityId]);

  const handleSend = useCallback(
    async (text: string) => {
      if (streaming) {
        try {
          const res = await client.rpc.chat.steer({
            sessionId: activeSessionId ?? '',
            text,
          });
          if (res.ok) {
            const steerMsg: StoredMessage = {
              id: `steer-${Date.now()}`,
              sessionId: activeSessionId ?? '',
              role: 'user_steer',
              content: text,
              toolCallId: null,
              toolName: null,
              toolCalls: null,
              timestamp: new Date().toISOString(),
            };
            setMessages((prev) => [...prev, steerMsg]);
            return;
          }
        } catch {
          // Fall through to normal send
        }
      }

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

        if (!activeSessionId) {
          isNewSessionAssignment.current = true;
          setActiveSessionId(res.sessionId);
          onSessionListDirty?.();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[chat] send error:', msg);
        lastStreamEventAtRef.current = null;
        setError(msg);
        setStreaming(false);
      }
    },
    [
      activeSessionId,
      activePersonalityId,
      client,
      setActiveSessionId,
      desktopUserId,
      streaming,
      onSessionListDirty,
    ],
  );

  const handleAbort = useCallback(async () => {
    if (!activeSessionId) return;
    try {
      await client.rpc.chat.abort({ sessionId: activeSessionId });
    } catch {
      // best-effort
    }
  }, [activeSessionId, client]);

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

  const handleRetry = useCallback(() => {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUserMsg) {
      setError(null);
      handleSend(lastUserMsg.content);
    }
  }, [messages, handleSend]);

  const handleNewChat = useCallback(() => {
    setActiveSessionId(null);
    resetChatState();
    onSessionListDirty?.();
  }, [setActiveSessionId, resetChatState, onSessionListDirty]);

  const handleForkSession = useCallback(
    (id?: string) => {
      if (onForkSession) {
        onForkSession(id);
      }
    },
    [onForkSession],
  );

  useEffect(() => {
    if (!lastTitledSession) return;
    if (lastTitledSession.sessionId === activeSessionId) {
      const manual = lastManualTitleRef.current;
      if (manual && manual.sessionId === activeSessionId) {
        lastManualTitleRef.current = null;
        return;
      }
      setSessionTitle(lastTitledSession.title);
    }
  }, [lastTitledSession, activeSessionId]);

  const handleTitleChange = useCallback(
    async (title: string) => {
      setSessionTitle(title);
      if (!activeSessionId) return;
      lastManualTitleRef.current = { sessionId: activeSessionId, title };
      try {
        await client.rpc.sessions.update({ id: activeSessionId, title });
        setLastTitledSession({ sessionId: activeSessionId, title });
        onSessionListDirty?.();
      } catch {
        // best-effort
      }
    },
    [activeSessionId, client, onSessionListDirty, setLastTitledSession],
  );

  const handleSwitchPersonality = useCallback(
    (id: string | null) => {
      setActivePersonalityId(id);
      if (id) localStorage.setItem('ethos:lastPersonalityId', id);
      else localStorage.removeItem('ethos:lastPersonalityId');
    },
    [setActivePersonalityId],
  );

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        height: '100%',
      }}
    >
      <PersonalityBar
        personalityId={activePersonalityId}
        port={port}
        onSwitchPersonality={handleSwitchPersonality}
        sessionTitle={sessionTitle}
        onTitleChange={handleTitleChange}
        onNewSession={handleNewChat}
        onForkSession={() => handleForkSession()}
        streaming={streaming}
        currentOp={currentOp}
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
        onSend={handleSend}
        error={error}
        personalityId={activePersonalityId}
        personalityName={activePersonalityId}
      />

      <TurnStatusBar isStreaming={streaming} currentOp={currentOp} elapsedMs={elapsedMs} />

      {isStalled ? (
        <div className="chat-stall-notice">Still working — this is taking longer than usual…</div>
      ) : null}

      <Composer
        onSend={handleSend}
        onAbort={handleAbort}
        streaming={streaming}
        personalityName={activePersonalityId ?? undefined}
        steerMode={streaming}
      />
    </div>
  );
}

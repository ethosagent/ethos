import type { FenceRendererResolver } from '@ethosagent/ui-components';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useFenceResolver } from '../../features/renderers/resolver';
import type { OlderHistoryStatus } from '../../hooks/useChat';
import type { AssistantTurn, ChatMessage, TurnRunMeta } from '../../lib/chat-reducer';
import type { TrailEntry, TrailState } from '../../lib/trail';
import { SaveToDashboardContextMenu } from '../dashboard/SaveToDashboardContextMenu';
import { SaveToDashboardModal } from '../dashboard/SaveToDashboardModal';
import { PersonalityMark } from '../ui/PersonalityMark';
import { TeamRing } from '../ui/TeamRing';
import { AssistantBubble, UserBubble } from './MessageBubble';
import type { RunSurface } from './RunCard';
import { RowState } from './Trail';

// Scrollable history. Auto-scrolls to the bottom as content arrives —
// but only when the user was already pinned to the bottom, so reading
// older messages doesn't get yanked back down by every text_delta.
//
// History is paged (useChat `loadOlder`): a sentinel at the top asks for the
// next-older page as it scrolls into view, and a prepend keeps the reader's
// place. Finished bubbles are memoized, so a streamed token re-renders only
// the live one — which holds only while every prop they get stays
// referentially stable across a streaming update.

/** The team Chat pane's empty state (plan/phases/teams-as-a-scope.md §8):
 *  the team's ring and name, and who answers for it. */
export interface MessageListTeamContext {
  teamName: string;
  /** Member accents in manifest order — what the ring is built from. */
  accents: string[];
  coordinatorName: string;
}

export interface MessageListProps {
  messages: ChatMessage[];
  /** In-flight assistant turn rendered at the tail of the list. */
  currentTurn: AssistantTurn | null;
  personalityId?: string;
  /** Display name for the empty state; falls back to the id. */
  personalityName?: string;
  model?: string;
  sessionId?: string;
  /** A4 — per-turn run meta (`ChatState.turnMeta` plus the live turn's). */
  turnMeta?: Record<string, TurnRunMeta>;
  /** W1 — re-send a failed message. Must be referentially stable. */
  onRetryMessage?: (messageId: string) => void;
  /** W1 — discard a failed message's bubble. Must be referentially stable. */
  onDiscardMessage?: (messageId: string) => void;
  /** Puts a suggested prompt in the composer (`recommend_actions` pills).
   *  Must be referentially stable, or every history bubble re-renders. */
  onSuggestPrompt?: (prompt: string) => void;
  /** Starts talk-mode from the empty state. Absent = no "Try voice" pill. */
  onTryVoice?: () => void;
  /** Live delegated-run state for the transcript's run anchors (§4.1). */
  runSurface?: RunSurface;
  /** Per-turn activity trails — the footer under each bubble (contract §3). */
  trail?: TrailState;
  /** Turns the user stopped; their footer reads `✗ stopped`. */
  stoppedTurnIds?: string[];
  /** Present on the team Chat pane — swaps the empty state for the team's. */
  teamContext?: MessageListTeamContext;
  /** The session has history older than `messages`. */
  hasOlder?: boolean;
  /** Where the next-older page stands; drives the row at the top of the list. */
  olderStatus?: OlderHistoryStatus;
  /** Fetch and prepend the next-older page — the top sentinel and Retry call it. */
  onLoadOlder?: () => void;
}

export function MessageList({
  messages,
  currentTurn,
  personalityId,
  personalityName,
  model,
  sessionId,
  turnMeta,
  onRetryMessage,
  onDiscardMessage,
  onSuggestPrompt,
  onTryVoice,
  runSurface,
  trail,
  stoppedTurnIds,
  teamContext,
  hasOlder = false,
  olderStatus = 'idle',
  onLoadOlder,
}: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveModalUserMessage, setSaveModalUserMessage] = useState<string | undefined>();
  const [showScrollDown, setShowScrollDown] = useState(false);
  // One resolver for the whole list, derived from the personality actually
  // being rendered with. History re-decides live on a personality switch —
  // nothing is stamped onto a message.
  const fenceRenderers = useFenceResolver(personalityId ?? '');

  const firstMessageId = messages[0]?.id;
  const lastMessageId = messages[messages.length - 1]?.id;

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedToBottomRef.current = fromBottom < 32;
    setShowScrollDown(fromBottom >= 100);
  };

  const scrollToBottom = () => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  // Keep the reader's place across a prepend. Every commit records the list's
  // first row and height. A commit whose first row changed while the previous
  // first row is still present further down is a prepend: scrollTop grows by
  // exactly the height added above, so nothing on screen moves. A previous
  // first row that is gone (a session switch, a replaced history) is not a
  // prepend; the first rows of a session start pinned to the bottom instead.
  const anchorRef = useRef<{ firstId: string | undefined; scrollHeight: number }>({
    firstId: undefined,
    scrollHeight: 0,
  });
  useLayoutEffect(() => {
    const el = listRef.current;
    const prev = anchorRef.current;
    if (el && prev.firstId !== undefined && firstMessageId !== prev.firstId) {
      const prevFirstId = prev.firstId;
      if (messages.findIndex((m) => m.id === prevFirstId) > 0) {
        el.scrollTop += el.scrollHeight - prev.scrollHeight;
      }
    }
    if (prev.firstId === undefined && firstMessageId !== undefined) {
      pinnedToBottomRef.current = true;
    }
    anchorRef.current = { firstId: firstMessageId, scrollHeight: el?.scrollHeight ?? 0 };
  });

  // Re-run on every visible change at the TAIL. The `currentTurn` reference
  // is the signal while streaming — its blocks update on every text_delta /
  // tool_start / tool_end — and the last row's id flips on send and on done.
  // Not `messages.length`: a prepended page changes that too, and would yank a
  // reader who is pinned down to the bottom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps trigger the effect intentionally — re-run on every new chunk so the scroll catches up
  useEffect(() => {
    if (!pinnedToBottomRef.current) return;
    const el = listRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [lastMessageId, currentTurn]);

  // The observer outlives renders; it reads the paging props from here.
  const olderRef = useRef({ hasOlder, olderStatus, onLoadOlder });
  useEffect(() => {
    olderRef.current = { hasOlder, olderStatus, onLoadOlder };
  });

  // The top sentinel. Re-armed after every prepend: `observe()` reports the
  // sentinel's current intersection, so a page too short to push it out of view
  // asks for the next one. Not re-armed on a failure — Retry is the retry, and
  // re-arming there would loop against a server that keeps failing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: firstMessageId re-arms the observer after a prepend, as described above
  useEffect(() => {
    const root = listRef.current;
    const sentinel = sentinelRef.current;
    if (!hasOlder || !root || !sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        const older = olderRef.current;
        if (!older.hasOlder || older.olderStatus === 'loading') return;
        older.onLoadOlder?.();
      },
      { root },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasOlder, firstMessageId]);

  // Stable for the life of the list, so the memoized rows never see a new
  // closure. It looks the turn up by id in the latest messages at click time.
  const messagesRef = useRef(messages);
  useLayoutEffect(() => {
    messagesRef.current = messages;
  });
  const openSaveModal = useCallback((turnId: string) => {
    const list = messagesRef.current;
    const msgIndex = list.findIndex((m) => m.id === turnId);
    // Walk backwards to find the preceding user message for this assistant turn.
    let userMsg: string | undefined;
    for (let i = msgIndex - 1; i >= 0; i--) {
      const prev = list[i];
      if (prev?.role === 'user') {
        userMsg = prev.content;
        break;
      }
    }
    setSaveModalUserMessage(userMsg);
    setSaveModalOpen(true);
  }, []);

  if (messages.length === 0 && !currentTurn) {
    if (teamContext) {
      return <TeamEmptyState teamContext={teamContext} onSuggestPrompt={onSuggestPrompt} />;
    }
    return (
      <EmptyState
        personalityId={personalityId}
        personalityName={personalityName}
        model={model}
        onSuggestPrompt={onSuggestPrompt}
        {...(onTryVoice ? { onTryVoice } : {})}
      />
    );
  }

  // No placeholder bubble before the first token: the status line above the
  // composer already announces `received` / `thinking` in its reserved slot
  // (contract §2), and two waiting indicators on one screen is one too many
  // (ux-feedback W5 — ThinkingBubble removed).

  return (
    <div ref={listRef} className="message-list" onScroll={onScroll}>
      {hasOlder ? (
        // The reserved slot for older history: the sentinel, and one feedback
        // row while a page loads or after one failed (DESIGN.md "Feedback &
        // activity" §6 — a row, never a toast).
        <div className="message-list-older">
          <div ref={sentinelRef} className="message-list-older-sentinel" aria-hidden="true" />
          <div role="status">
            {olderStatus === 'loading' ? (
              <div className="activity-row activity-row-running">
                <RowState status="running" />
                <span className="activity-row-result">Loading earlier messages…</span>
              </div>
            ) : null}
            {olderStatus === 'error' ? (
              <div className="activity-row activity-row-failed">
                <RowState status="failed" />
                <span className="activity-row-result">Earlier messages did not load</span>
                <button type="button" className="message-list-older-retry" onClick={onLoadOlder}>
                  Retry
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {messages.map((m) =>
        m.role === 'user' ? (
          <UserBubble
            key={m.id}
            message={m}
            {...(onRetryMessage ? { onRetry: onRetryMessage } : {})}
            {...(onDiscardMessage ? { onDiscard: onDiscardMessage } : {})}
          />
        ) : (
          <AssistantHistoryRow
            key={m.id}
            turn={m}
            onSaveToDashboard={openSaveModal}
            fenceRenderers={fenceRenderers}
            onSuggestPrompt={onSuggestPrompt}
            {...(personalityId ? { personalityId } : {})}
            {...(runSurface ? { runSurface } : {})}
            {...(trail?.[m.id] ? { trail: trail[m.id] } : {})}
            {...(stoppedTurnIds?.includes(m.id) ? { stopped: true } : {})}
            {...(turnMeta?.[m.id] ? { runMeta: turnMeta[m.id] } : {})}
          />
        ),
      )}
      {currentTurn ? (
        <AssistantBubble
          turn={currentTurn}
          streaming
          fenceRenderers={fenceRenderers}
          onSuggestPrompt={onSuggestPrompt}
          {...(personalityId ? { personalityId } : {})}
          {...(runSurface ? { runSurface } : {})}
          {...(trail?.[currentTurn.id] ? { trail: trail[currentTurn.id] } : {})}
          {...(stoppedTurnIds?.includes(currentTurn.id) ? { stopped: true } : {})}
          {...(turnMeta?.[currentTurn.id] ? { runMeta: turnMeta[currentTurn.id] } : {})}
        />
      ) : null}
      <SaveToDashboardModal
        open={saveModalOpen}
        onClose={() => setSaveModalOpen(false)}
        userMessage={saveModalUserMessage}
        sessionId={sessionId}
      />
      {showScrollDown && (
        <button
          type="button"
          className="scroll-to-bottom-btn"
          onClick={scrollToBottom}
          aria-label="Scroll to latest message"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M8 3v10M4 9l4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

interface AssistantHistoryRowProps {
  turn: AssistantTurn;
  /** Stable handler; the row binds its own turn id. */
  onSaveToDashboard: (turnId: string) => void;
  fenceRenderers: FenceRendererResolver;
  onSuggestPrompt?: (prompt: string) => void;
  personalityId?: string;
  runSurface?: RunSurface;
  trail?: TrailEntry[];
  stopped?: boolean;
  runMeta?: TurnRunMeta;
}

/**
 * One finished assistant turn inside its context menu. Memoized as a whole:
 * the menu wrapper is a fresh element on every list render, so memoizing only
 * the bubble would still re-render an antd Dropdown per row per streamed token.
 */
const AssistantHistoryRow = memo(function AssistantHistoryRow({
  turn,
  onSaveToDashboard,
  ...bubble
}: AssistantHistoryRowProps) {
  const save = useCallback(() => onSaveToDashboard(turn.id), [onSaveToDashboard, turn.id]);
  return (
    <SaveToDashboardContextMenu onSaveToDashboard={save}>
      <AssistantBubble turn={turn} {...bubble} />
    </SaveToDashboardContextMenu>
  );
});

const DEFAULT_PILLS = [
  'Explore a topic',
  'Explain this file',
  'Search memory',
  'Run a skill',
] as const;

// Team-shaped suggestions: questions you ask a team's coordinator, not a
// single agent (§8 "Chat").
const TEAM_PILLS = [
  'Who is on what right now?',
  'What needs me?',
  'What did we decide this week?',
  "Give me today's summary",
] as const;

function TeamEmptyState({
  teamContext,
  onSuggestPrompt,
}: {
  teamContext: MessageListTeamContext;
  onSuggestPrompt?: (prompt: string) => void;
}) {
  return (
    <div className="message-list-empty team-chat-empty">
      <TeamRing accents={teamContext.accents} size={48} title={teamContext.teamName} />
      <div className="empty-state-name">{teamContext.teamName}</div>
      <div className="empty-state-model">{teamContext.coordinatorName} answers for the team</div>
      <div className="empty-state-tagline">Ready.</div>
      <div className="empty-state-pills">
        {TEAM_PILLS.map((p) => (
          <button
            key={p}
            type="button"
            className="empty-state-pill"
            onClick={() => onSuggestPrompt?.(p)}
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

function EmptyState({
  personalityId,
  personalityName,
  model,
  onSuggestPrompt,
  onTryVoice,
}: {
  personalityId?: string;
  personalityName?: string;
  model?: string;
  onSuggestPrompt?: (prompt: string) => void;
  onTryVoice?: () => void;
}) {
  // DESIGN.md § Empty chat state: the agent's own 48px generative mark and
  // display name — never a hardcoded brand hue or a raw id (ux-feedback W5).
  return (
    <div className="message-list-empty">
      {personalityId ? <PersonalityMark personalityId={personalityId} size={48} /> : null}
      {personalityId || personalityName ? (
        <div className="empty-state-name">{personalityName ?? personalityId}</div>
      ) : null}
      {model ? <div className="empty-state-model">{model}</div> : null}
      <div className="empty-state-tagline">Ready to help.</div>
      <div className="empty-state-pills">
        {DEFAULT_PILLS.map((p) => (
          <button
            key={p}
            type="button"
            className="empty-state-pill"
            onClick={() => onSuggestPrompt?.(p)}
          >
            {p}
          </button>
        ))}
        {/* The one pill that does not pre-fill the composer — it starts a call
            (DR2 first-conversation moment). Rendered only where talk-mode is
            actually available, so it is never a dead end. */}
        {onTryVoice ? (
          <button type="button" className="empty-state-pill" onClick={onTryVoice}>
            Try voice
          </button>
        ) : null}
      </div>
    </div>
  );
}

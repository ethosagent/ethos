import type { ContextAnatomyWire } from '@ethosagent/web-contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  type CompactNotifier,
  type CompactResult,
  notifyCompactResult,
} from '../lib/notify-compact-result';
import { rpc } from '../rpc';

export interface UseContextAnatomy {
  anatomy: ContextAnatomyWire | null;
  /** Post-compact estimate ?? the anatomy's provider-measured size; the live chip size without an anatomy. */
  usedTokens: number | null;
  /** True while a compaction started from this hook is in flight. */
  compacting: boolean;
  /** Compact (the meter button passes no focus, D12; typed `/compact [focus]` may), then toast. */
  runCompact: (focus?: string) => Promise<void>;
}

interface Override {
  sessionId: string;
  llmCallCount: number;
  tokens: number;
}

const REFETCH_DEBOUNCE_MS = 300;

// Same query key as the Activity tab so the cache is shared. The ring's
// numerator is `anatomy.total`, the provider-measured prompt of the latest
// model call: cache-semantics-neutral, unlike input+cache sums (Codex/xAI
// report cached tokens inside inputTokens, Anthropic outside). A usage event
// means a model call finished streaming, so it (and turn end) refetches.
// Manual compaction writes no llm_call span, so the post-compact estimate
// stands in until the session changes or a new llm_call lands.
export function useContextAnatomy(
  sessionId: string | null,
  opts: {
    turnBusy: boolean;
    liveTokens: number | null;
    compact: (focus?: string) => Promise<CompactResult>;
    notification: CompactNotifier;
  },
): UseContextAnatomy {
  const { turnBusy, liveTokens, compact, notification } = opts;
  const { data, refetch } = useQuery({
    queryKey: ['sessions', 'contextAnatomy', sessionId],
    queryFn: () => rpc.sessions.contextAnatomy({ id: sessionId ?? '' }),
    enabled: sessionId !== null,
    staleTime: 30_000,
  });
  const anatomy = data?.anatomy ?? null;

  // A usage event or a turn end means a new llm_call span may exist. Both often
  // land together, so a trailing debounce collapses them into one RPC. refetch
  // with cancelRefetch:false joins an in-flight request instead of restarting it.
  const prev = useRef({ sessionId, turnBusy, liveTokens });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const p = prev.current;
    prev.current = { sessionId, turnBusy, liveTokens };
    clearTimeout(timer.current);
    // The query key already refetches on a session change; null is a reset, not a call.
    if (sessionId === null || p.sessionId !== sessionId) return;
    const turnEnded = p.turnBusy && !turnBusy;
    const callLanded = liveTokens !== null && liveTokens !== p.liveTokens;
    if (turnEnded || callLanded) {
      timer.current = setTimeout(() => void refetch({ cancelRefetch: false }), REFETCH_DEBOUNCE_MS);
    }
  }, [turnBusy, liveTokens, sessionId, refetch]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const [override, setOverride] = useState<Override | null>(null);
  const [compacting, setCompacting] = useState(false);
  // Closes the same-tick double-click window that `compacting` state (one render late) cannot.
  const inFlight = useRef(false);

  const runCompact = async (focus?: string): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setCompacting(true);
    try {
      const result = await compact(focus);
      notifyCompactResult(notification, result);
      if (result?.ok && sessionId !== null && Number.isFinite(result.postTotalTokens)) {
        setOverride({
          sessionId,
          llmCallCount: anatomy?.llmCallCount ?? 0,
          tokens: result.postTotalTokens,
        });
      }
    } finally {
      inFlight.current = false;
      setCompacting(false);
    }
  };

  const postCompact =
    override?.sessionId === sessionId && override.llmCallCount === (anatomy?.llmCallCount ?? 0)
      ? override.tokens
      : null;

  return {
    anatomy,
    usedTokens: postCompact ?? anatomy?.total ?? liveTokens,
    compacting,
    runCompact,
  };
}

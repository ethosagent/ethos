import type { ContextAnatomyWire } from '@ethosagent/web-contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { CompactResult } from '../lib/notify-compact-result';
import { rpc } from '../rpc';

export interface UseContextAnatomy {
  anatomy: ContextAnatomyWire | null;
  /** Override ?? live usage ?? the anatomy's own prompt size. */
  usedTokens: number | null;
  /** Feed the result of a manual compaction: refetch + show the post-compact estimate. */
  afterCompact: (result: CompactResult) => void;
}

// Same query key as the Activity tab so the cache is shared. Manual compaction
// writes no llm_call span, so the anatomy does not change after it — the
// override stands in until the next usage event moves `liveTokens`.
export function useContextAnatomy(
  sessionId: string | null,
  opts: { turnBusy: boolean; liveTokens: number | null },
): UseContextAnatomy {
  const { turnBusy, liveTokens } = opts;
  const { data, refetch } = useQuery({
    queryKey: ['sessions', 'contextAnatomy', sessionId],
    queryFn: () => rpc.sessions.contextAnatomy({ id: sessionId ?? '' }),
    enabled: sessionId !== null,
    staleTime: 30_000,
  });
  const anatomy = data?.anatomy ?? null;

  const wasBusy = useRef(turnBusy);
  useEffect(() => {
    if (wasBusy.current && !turnBusy && sessionId !== null) void refetch();
    wasBusy.current = turnBusy;
  }, [turnBusy, sessionId, refetch]);

  const [override, setOverride] = useState<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new usage reading supersedes the override
  useEffect(() => {
    setOverride(null);
  }, [liveTokens]);

  const afterCompact = (result: CompactResult): void => {
    if (!result?.ok) return;
    setOverride(result.postTotalTokens);
    if (sessionId !== null) void refetch();
  };

  return {
    anatomy,
    usedTokens: override ?? liveTokens ?? anatomy?.promptTokens ?? null,
    afterCompact,
  };
}

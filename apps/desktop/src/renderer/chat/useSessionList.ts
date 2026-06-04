import { createEthosClient } from '@ethosagent/sdk';
import type { Session } from '@ethosagent/web-contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface UseSessionListOptions {
  baseUrl: string;
  enabled?: boolean;
}

interface UseSessionListResult {
  sessions: Session[];
  loading: boolean;
  error: string | null;
  search: string;
  setSearch: (q: string) => void;
  loadMore: () => void;
  hasMore: boolean;
  refresh: () => void;
}

const PAGE_SIZE = 50;
const DEBOUNCE_MS = 200;

export function useSessionList(opts: UseSessionListOptions): UseSessionListResult {
  const { baseUrl, enabled = true } = opts;

  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearchRaw] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState('');

  const setSearch = useCallback((q: string) => {
    setSearchRaw(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(q);
    }, DEBOUNCE_MS);
  }, []);

  const fetchSessions = useCallback(
    async (q: string, pageCursor: string | null, append: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const res = await client.rpc.sessions.list({
          q: q || undefined,
          limit: PAGE_SIZE,
          cursor: pageCursor,
        });
        setSessions((prev) => (append ? [...prev, ...res.items] : res.items));
        setCursor(res.nextCursor);
        setHasMore(res.nextCursor !== null);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    if (enabled === false) return;
    setCursor(null);
    fetchSessions(debouncedSearch, null, false);
  }, [debouncedSearch, fetchSessions, enabled]);

  const loadMore = useCallback(() => {
    if (loading || !hasMore || !cursor) return;
    fetchSessions(debouncedSearch, cursor, true);
  }, [loading, hasMore, cursor, debouncedSearch, fetchSessions]);

  const refresh = useCallback(() => {
    setCursor(null);
    fetchSessions(debouncedSearch, null, false);
  }, [debouncedSearch, fetchSessions]);

  return {
    sessions,
    loading,
    error,
    search,
    setSearch,
    loadMore,
    hasMore,
    refresh,
  };
}

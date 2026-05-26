import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppState } from '../state/AppContext';

interface MemoryState {
  content: string;
  modifiedAt: string | null;
  loading: boolean;
  error: string | null;
}

interface UseMemoryReturn extends MemoryState {
  reload: () => Promise<void>;
  save: (content: string) => Promise<boolean>;
}

export function useMemory(
  store: 'memory' | 'user',
  personalityId: string | null,
  userId?: string | null,
): UseMemoryReturn {
  const { state } = useAppState();
  const { port } = state;

  const client = useMemo(
    () => createEthosClient({ baseUrl: `http://localhost:${port}`, fetch: globalThis.fetch }),
    [port],
  );

  const [memState, setMemState] = useState<MemoryState>({
    content: '',
    modifiedAt: null,
    loading: false,
    error: null,
  });

  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!personalityId) return;
    const thisRequest = ++requestIdRef.current;
    setMemState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await client.rpc.memory.get({
        store,
        personalityId,
        ...(userId ? { userId } : {}),
      });
      if (requestIdRef.current !== thisRequest) return;
      setMemState({
        content: res.file.content,
        modifiedAt: res.file.modifiedAt,
        loading: false,
        error: null,
      });
    } catch (err) {
      if (requestIdRef.current !== thisRequest) return;
      setMemState((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load memory',
      }));
    }
  }, [client, store, personalityId, userId]);

  useEffect(() => {
    load();
    return () => {
      requestIdRef.current++;
    };
  }, [load]);

  const save = useCallback(
    async (content: string): Promise<boolean> => {
      if (!personalityId) return false;
      try {
        const res = await client.rpc.memory.write({
          store,
          content,
          personalityId,
          ...(userId ? { userId } : {}),
        });
        if (mountedRef.current) {
          setMemState({
            content: res.file.content,
            modifiedAt: res.file.modifiedAt,
            loading: false,
            error: null,
          });
        }
        return true;
      } catch (err) {
        if (mountedRef.current) {
          setMemState((s) => ({
            ...s,
            error: err instanceof Error ? err.message : 'Failed to save memory',
          }));
        }
        return false;
      }
    },
    [client, store, personalityId, userId],
  );

  return {
    ...memState,
    reload: load,
    save,
  };
}

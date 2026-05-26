import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

export function useSessionTitleSync() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const base = import.meta.env.VITE_API_URL ?? '';
    const url = `${base}/sse/system`;
    const source = new EventSource(url, { withCredentials: true });

    source.onmessage = (raw) => {
      try {
        const data = JSON.parse(raw.data) as { type: string; sessionId?: string; title?: string };
        if (data.type === 'session.titled' && data.sessionId) {
          void queryClient.invalidateQueries({ queryKey: ['sessions', 'get', data.sessionId] });
          void queryClient.invalidateQueries({ queryKey: ['sessions', 'list'] });
        }
      } catch {
        // ignore parse errors
      }
    };

    return () => source.close();
  }, [queryClient]);
}

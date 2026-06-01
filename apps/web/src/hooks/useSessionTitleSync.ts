import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { z } from 'zod';

/** Narrow schema for the `session.titled` event from the `/sse/system` stream.
 *  This endpoint uses `SystemEvent` (defined in web-api), not the session-level
 *  `SseEventSchema` from web-contracts. We validate only the variant we act on. */
const SessionTitledSchema = z.object({
  type: z.literal('session.titled'),
  sessionId: z.string(),
  title: z.string(),
});

export function useSessionTitleSync() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const base = import.meta.env.VITE_API_URL ?? '';
    const url = `${base}/sse/system`;
    const source = new EventSource(url, { withCredentials: true });

    source.onmessage = (raw) => {
      try {
        const json: unknown = JSON.parse(raw.data);
        const result = SessionTitledSchema.safeParse(json);
        if (result.success) {
          void queryClient.invalidateQueries({
            queryKey: ['sessions', 'get', result.data.sessionId],
          });
          void queryClient.invalidateQueries({ queryKey: ['sessions', 'list'] });
        }
        // Other system event types (ping, health, etc.) are silently ignored.
      } catch {
        // ignore parse errors
      }
    };

    return () => source.close();
  }, [queryClient]);
}

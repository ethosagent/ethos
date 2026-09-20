import type { EthosClient } from '@ethosagent/sdk';
import { MutationCache, QueryCache, QueryClient, useQuery } from '@tanstack/react-query';
import { useConnection } from '../state/connection';
import { isUnauthorized } from './errors';

// A revoked key surfaces as UNAUTHORIZED on whatever call comes next (§11):
// forget the key, keep the URL — the root gate returns to Connect.
const onError = (err: unknown) => {
  if (isUnauthorized(err)) void useConnection.getState().disconnect();
};

/** Nothing is persisted: approvals are always refetched, never restored (R7). */
export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: { queries: { retry: 1, staleTime: 10_000 } },
});

/** The connected client's RPC. Only rendered under the connection gate, so a
 *  missing client means the gate is wrong — fail loudly into the ErrorBoundary. */
export function useRpc(): EthosClient['rpc'] {
  const client = useConnection((s) => s.client);
  if (!client) throw new Error('Not connected');
  return client.rpc;
}

export function usePersonalities() {
  const rpc = useRpc();
  return useQuery({ queryKey: ['personalities'], queryFn: () => rpc.personalities.list({}) });
}

/** A personality's model as the bar shows it — a tier config has no one name. */
export function modelName(model: unknown): string | null {
  return typeof model === 'string' ? model : null;
}

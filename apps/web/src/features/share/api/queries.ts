import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { shareKeys } from './keys';

export interface ShareInclude {
  includeToolNames: boolean;
  pii: boolean;
}

export function useShareList() {
  return useQuery({
    queryKey: shareKeys.list(),
    queryFn: () => rpc.shares.list({}),
    staleTime: 30_000,
  });
}

/**
 * `Share…` is offered only once `shares.list` has answered `enabled: true`:
 * while loading, on error, and when off it stays hidden (plan share-links D11).
 */
export function useShareEnabled(): boolean {
  return useShareList().data?.enabled === true;
}

/**
 * The redacted transcript a link would publish (plan D15). `gcTime: 0`: a
 * transcript is not kept in the query cache once the dialog closes.
 */
export function useSharePreview(sessionId: string, include: ShareInclude) {
  return useQuery({
    queryKey: shareKeys.preview(sessionId, include.includeToolNames, include.pii),
    queryFn: () => rpc.shares.preview({ sessionId, ...include }),
    gcTime: 0,
    staleTime: 0,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

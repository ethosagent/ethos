import type { MemoryStoreId } from '@ethosagent/web-contracts';
import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { memoryKeys } from './keys';

export function useMemoryList(
  personalityId: string | null,
  activeStore: MemoryStoreId,
  userId: string | null,
) {
  return useQuery({
    queryKey: memoryKeys.list(personalityId, activeStore === 'user' ? userId : null),
    queryFn: () =>
      rpc.memory.list({
        personalityId: personalityId as string,
        ...(activeStore === 'user' && userId ? { userId } : {}),
      }),
    enabled: !!personalityId,
  });
}

export function useMemoryUsers() {
  return useQuery({
    queryKey: memoryKeys.listUsers(),
    queryFn: () => rpc.memory.listUsers({}),
  });
}

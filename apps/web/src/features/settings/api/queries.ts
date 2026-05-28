import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { apiKeyKeys, toolCatalogKeys } from './keys';

export function useApiKeysList() {
  return useQuery({
    queryKey: apiKeyKeys.all(),
    queryFn: () => rpc.apiKeys.list({}),
  });
}

export function useToolCatalog() {
  return useQuery({
    queryKey: toolCatalogKeys.catalog(),
    queryFn: () => rpc.tools.catalog({}),
  });
}

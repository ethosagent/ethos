import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { apiKeyKeys, namedSecretKeys, toolCatalogKeys, toolSettingsKeys } from './keys';

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

/** Global named secrets — masked previews only. */
export function useNamedSecretsList() {
  return useQuery({
    queryKey: namedSecretKeys.all(),
    queryFn: () => rpc.namedSecrets.list(),
  });
}

/** Every configurable tool's `settingsSchema` (drives the config forms). */
export function useToolSettingsSchemas() {
  return useQuery({
    queryKey: toolSettingsKeys.schemas(),
    queryFn: () => rpc.toolSettings.schemas(),
  });
}

/** Global default tool binding (`toolSettings._default`). */
export function useToolSettingsDefault() {
  return useQuery({
    queryKey: toolSettingsKeys.default(),
    queryFn: () => rpc.toolSettings.getDefault(),
  });
}

/** A personality's effective tool binding + which store owns it. */
export function useToolSettingsForPersonality(personalityId: string) {
  return useQuery({
    queryKey: toolSettingsKeys.forPersonality(personalityId),
    queryFn: () => rpc.toolSettings.getForPersonality({ personalityId }),
    enabled: personalityId.length > 0,
  });
}

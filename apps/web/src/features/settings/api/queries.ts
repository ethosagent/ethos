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

/** The provider namespaces the vault accepts, derived server-side from the
 *  registered tools' capability grants. The browser cannot compute this — the
 *  derivation needs the live tool registry. */
export function useNamedSecretProviders() {
  return useQuery({
    queryKey: namedSecretKeys.providers(),
    queryFn: () => rpc.namedSecrets.providers(),
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

/** Read-only credential resolution probe for a personality (PR3). */
export function useToolSettingsProbeCredentials(personalityId: string) {
  return useQuery({
    queryKey: toolSettingsKeys.probeCredentials(personalityId),
    queryFn: () => rpc.toolSettings.probeCredentials({ personalityId }),
    enabled: personalityId.length > 0,
  });
}

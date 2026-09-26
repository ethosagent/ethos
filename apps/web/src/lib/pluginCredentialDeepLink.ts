import { z } from 'zod';

// openclaw-9.5 item 1 — the gateway links users to
// `/plugins?pluginId=<id>&key=<KEY>` to set a missing credential. The query is
// untrusted input: nothing here builds a request from it. The plugin id is
// honoured only when it names a plugin `plugins.list` returned, and the key
// only when it names a credential `plugins.listCredentialKeys` returned for
// that plugin — so a hostile value selects nothing and causes no I/O. (The RPC
// path refuses a bad key on its own too: `credentialRef()` in
// extensions/plugin-loader/src/index.ts.) Pinned by
// `apps/web/src/lib/__tests__/pluginCredentialDeepLink.test.ts`.

const DeepLinkSchema = z.object({
  pluginId: z.string().min(1),
  key: z.string().min(1).optional(),
});

export type PluginCredentialDeepLink = z.infer<typeof DeepLinkSchema>;

/** The deep link, if the query carries a `pluginId` naming a listed plugin. */
export function parsePluginCredentialDeepLink(
  params: URLSearchParams,
  listedPluginIds: readonly string[],
): PluginCredentialDeepLink | null {
  const parsed = DeepLinkSchema.safeParse({
    pluginId: params.get('pluginId') ?? undefined,
    key: params.get('key') ?? undefined,
  });
  if (!parsed.success) return null;
  if (!listedPluginIds.includes(parsed.data.pluginId)) return null;
  return parsed.data;
}

/** The credential to focus: the link's key, only if the plugin lists it. */
export function credentialToFocus(
  key: string | undefined,
  listedCredentialRefs: readonly string[],
): string | undefined {
  if (key === undefined) return undefined;
  return listedCredentialRefs.includes(key) ? key : undefined;
}

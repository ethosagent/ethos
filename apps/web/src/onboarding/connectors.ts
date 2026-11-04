// Pure logic for the onboarding Connectors step (plan keyless-first-run §5.2).
// No JSX, no DOM: the order guarantees live here so a test can pin them.

/**
 * D20: for OAuth the attach comes AFTER the connect. `useMcpOAuthPopup` calls
 * its `onSuccess` only when the sign-in finished, and `onError` otherwise, so
 * wiring `attach` into `onSuccess` alone means a failed sign-in leaves no
 * grant behind. Pinned by apps/web/src/onboarding/__tests__/connectors.test.ts
 * ("oauth attach is called only after connected").
 */
export async function attachAfterConnect(input: {
  serverName: string;
  personalityId: string;
  attach: (args: { serverName: string; personalityIds: string[] }) => Promise<{
    updated: string[];
    failed: { id: string; error: string }[];
  }>;
}): Promise<{ ok: true } | { ok: false; detail: string }> {
  const { updated, failed } = await input.attach({
    serverName: input.serverName,
    personalityIds: [input.personalityId],
  });
  if (updated.includes(input.personalityId)) return { ok: true };
  const reason = failed.find((f) => f.id === input.personalityId)?.error;
  return { ok: false, detail: reason ?? 'Could not grant the server to this agent.' };
}

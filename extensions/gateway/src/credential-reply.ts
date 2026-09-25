// openclaw-9.5 item 1 (D14) — what a channel lane says when a turn is refused
// pre-turn for a missing plugin credential.
//
// A channel lane NEVER accepts a secret as message text, DM or group: the
// platform keeps its own history of every message, DMs included, whatever
// Ethos does afterwards. So the reply points somewhere else — the web UI's
// plugin-credentials page when `webBaseUrl` is configured, otherwise the CLI
// command — and the gateway has no code path that treats a message as a
// credential value (it never calls `PluginLoader.setCredential`). Pinned by
// `extensions/gateway/src/__tests__/credential-required.test.ts`.

import { webPageUrlFor } from '@ethosagent/core';
import { credentialSetCommand } from '@ethosagent/surface-kit';

export interface CredentialReplyRequest {
  pluginId: string;
  credentialKey: string;
  label: string;
}

/**
 * The reply text. With a usable `webBaseUrl` (an absolute http(s) URL, checked
 * by `webPageUrlFor`) it links `/plugins?pluginId=<id>&key=<KEY>`, which the
 * web Plugins page reads to open that plugin's credentials and focus the
 * field; without one it names `ethos plugin credentials <id> --set <KEY>`. It
 * never guesses a URL, and it never quotes the user's message.
 */
export function credentialRequiredReply(
  req: CredentialReplyRequest,
  webBaseUrl: string | undefined,
): string {
  const lead = `Plugin "${req.pluginId}" needs ${req.label} before I can answer.`;
  const noChat = "For your safety I don't accept credentials in chat — please don't paste it here.";
  const page = webPageUrlFor(webBaseUrl, '/plugins');
  if (page) {
    const url = new URL(page);
    url.searchParams.set('pluginId', req.pluginId);
    url.searchParams.set('key', req.credentialKey);
    return `${lead} ${noChat} Set it here: ${url.toString()} — then send your message again.`;
  }
  return (
    `${lead} ${noChat} On the machine running Ethos, run ` +
    `\`${credentialSetCommand(req.pluginId, req.credentialKey)}\`, then send your message again.`
  );
}

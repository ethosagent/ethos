// Remote MCP server presets — a DERIVED VIEW over the catalog index.
//
// The entries live in packages/catalog/src/entries/mcp/<id>.ts, and so do the
// per-entry verification notes (live `initialize` handshakes, the OAuth
// walk, and why several urls are deliberately not the shape you would guess).
// Do not "correct" a url from memory. This file builds `MCP_REMOTE_PRESETS`
// from the entries whose pin is `remote`; names and shapes are unchanged. The
// pinning tests in __tests__/remote-presets.test.ts and the frozen
// remote-presets-golden.json exist for exactly that reason.

import { catalogEntriesOfKind } from '@ethosagent/catalog';

export interface McpRemotePreset {
  name: string;
  label: string;
  url: string;
  transport: 'streamable-http';
  authType: 'oauth' | 'none' | 'bearer';
  description: string;
  /** Grouping label for the catalog UI, e.g. "Developer tools". */
  category: string;
  docsUrl?: string;
}

// Deliberately absent: `github`. https://api.githubcopilot.com/mcp/ is a real
// OAuth MCP server, but its authorization server (https://github.com/login/oauth)
// publishes no `registration_endpoint` in either its RFC 8414 metadata or its
// OpenID configuration. Ethos's install flow registers a client via DCR
// (`registerOAuthClient` in ./oauth.ts, which throws `DcrUnsupported`), so a
// one-click catalog install could only ever fail. GitHub needs a pre-registered
// GitHub App, which is the `ethos mcp add --url` CLI path, not a catalog path.
//
// Also evaluated and excluded: `supabase`. Its authorization server advertises
// only `client_secret_basic` / `client_secret_post` and not `"none"` — i.e.
// confidential clients only, which Ethos rejects with
// `ConfidentialClientUnsupported`.

function deriveRemotePresets(): Record<string, McpRemotePreset> {
  const presets: Record<string, McpRemotePreset> = {};
  for (const entry of catalogEntriesOfKind('mcp')) {
    const { pin, capabilities } = entry;
    if (pin.type !== 'remote') continue;
    if (capabilities.auth === 'env') {
      throw new Error(`remote catalog entry '${entry.id}' cannot use env auth`);
    }
    presets[entry.id] = {
      name: entry.id,
      label: entry.name,
      url: pin.url,
      transport: pin.transport,
      authType: capabilities.auth,
      description: entry.description,
      category: entry.category,
      ...(entry.homepage ? { docsUrl: entry.homepage } : {}),
    };
  }
  return presets;
}

export const MCP_REMOTE_PRESETS: Record<string, McpRemotePreset> = deriveRemotePresets();

export function getRemotePreset(name: string): McpRemotePreset | undefined {
  return MCP_REMOTE_PRESETS[name];
}

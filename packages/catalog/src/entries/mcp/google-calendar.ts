import type { CatalogEntry } from '@ethosagent/types';

// Community server, not Google-official (publisher is the `cocal` npm scope;
// repository nspady/google-calendar-mcp). Verified 2026-09-04 against the npm
// registry (bin `google-calendar-mcp` -> build/index.js, so `npx -y`
// resolves); re-pinned and relaunched 2026-11-05.
// Licence: npm `license` is "MIT".
//
// Not one-click, and the description has to say so: the user creates an
// OAuth client in their own Google Cloud project and points
// GOOGLE_OAUTH_CREDENTIALS at the downloaded client JSON. The server then
// runs a one-time browser consent on first use.
//
// toolCount is absent: the server exits at startup without a real OAuth
// client JSON (2026-11-05: "Credentials file: ... ENOENT"), so no tools/list
// handshake was possible without a Google Cloud project. Never guessed.
//
// capabilities, checked 2026-11-05 by reading the pinned tarball
// (`npm pack @cocal/google-calendar-mcp@2.8.1`, grep over build/):
//  - network: the package's own code names only https://www.googleapis.com
//    (Calendar API). The OAuth token exchange host, https://oauth2.googleapis.com
//    (token, revoke, tokeninfo), comes from its dependency google-auth-library
//    (read at 10.5.0; the package declares ^10.5.0, so the version resolved at
//    first launch can differ). The consent page (accounts.google.com) is opened
//    in the user's browser, not contacted by the server; a localhost callback
//    port is used during consent and is not listed.
//  - filesystem 'own-state': it writes OAuth tokens (mode 0600, temp file then
//    write) to $GOOGLE_CALENDAR_MCP_TOKEN_PATH, else
//    $XDG_CONFIG_HOME/google-calendar-mcp/tokens.json (default
//    ~/.config/...), and reads GOOGLE_OAUTH_CREDENTIALS. It never reads or
//    writes user paths for tool calls.
//  - shell false: no exec/spawn in the package; only the `open` dependency
//    launches the browser for consent.
//
// category is 'Utilities', not the remote catalog's 'Productivity': the local
// presets render in their own dropdown (AddMcpModal's stdio mode) with their
// own three-label scheme, so borrowing a remote label would add a fourth stdio
// category without ever putting the two lists side by side.
export const googleCalendar: CatalogEntry = {
  id: 'google-calendar',
  kind: 'mcp',
  name: 'google-calendar',
  description:
    'Read and manage Google Calendar events (set GOOGLE_OAUTH_CREDENTIALS to your Google Cloud OAuth client JSON)',
  category: 'Utilities',
  publisher: 'cocal (community)',
  tier: 'community',
  pin: {
    type: 'npm',
    package: '@cocal/google-calendar-mcp',
    version: '2.8.1',
    integrity:
      'sha512-NQdZ/OdJJ8CQJtpg/GhMI2k8Mq0TaaAcagE9WOzI9xtR9SBB5DGeNc8D4kwNB5KqXMdjI5q+U6dx+bkFwaWzJg==',
  },
  capabilities: {
    network: ['www.googleapis.com', 'oauth2.googleapis.com'],
    auth: 'env',
    env: ['GOOGLE_OAUTH_CREDENTIALS'],
    filesystem: 'own-state',
    shell: false,
  },
  license: 'MIT',
  reviewedAt: '2026-11-05',
  mcp: { argsAfterSpec: [], argVars: [], envVars: ['GOOGLE_OAUTH_CREDENTIALS'] },
};

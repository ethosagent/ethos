// MCP server presets — well-known community servers with sensible defaults.

export interface McpPreset {
  name: string;
  description: string;
  command: string;
  args: string[];
  envVars: string[]; // env vars this preset expects
}

export const MCP_PRESETS: Record<string, McpPreset> = {
  filesystem: {
    name: 'filesystem',
    description: 'Read/write local files with path restrictions',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    envVars: ['ALLOWED_PATHS'],
  },
  git: {
    name: 'git',
    description: 'Git repository operations',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-git'],
    envVars: ['GIT_REPO_PATH'],
  },
  sqlite: {
    name: 'sqlite',
    description: 'SQLite database queries',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite'],
    envVars: ['SQLITE_DB_PATH'],
  },
  fetch: {
    name: 'fetch',
    description: 'HTTP fetch operations',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    envVars: [],
  },
  memory: {
    name: 'memory',
    description: 'Key-value memory store',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    envVars: [],
  },
};

/** Look up a preset by name. Returns undefined for unknown names. */
export function getPreset(name: string): McpPreset | undefined {
  return MCP_PRESETS[name];
}

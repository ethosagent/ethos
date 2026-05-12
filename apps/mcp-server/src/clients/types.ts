export interface ClientAdapter {
  name: string;
  displayName: string;
  /** Returns the path to the client's MCP config file on the current OS. */
  configPath(): string;
  /** Reads and parses the existing config, or returns an empty base object. */
  readConfig(path: string): Record<string, unknown>;
  /** Injects the Ethos MCP entry and returns the updated config. */
  injectEntry(config: Record<string, unknown>, entry: McpEntry): Record<string, unknown>;
  /** Serialises the config for writing back to disk. */
  serialise(config: Record<string, unknown>): string;
}

export interface McpEntry {
  command: string;
  args: string[];
}

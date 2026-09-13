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
  /**
   * The key (or `name` field, for array-shaped configs) this entry is written
   * under. Defaults to `ethos` — the global operator console.
   *
   * A personality export is written under `ethos-<id>` instead
   * (`ethos mcp install <client> --personality <id>`, M-T7), which is the whole
   * reason this field exists: the two servers are different surfaces with
   * different trust (M-D14), so installing an export must ADD an entry rather
   * than replace whatever `ethos` the user already has. Every adapter keys off
   * this value and nothing else, so neither can clobber the other.
   */
  name?: string;
  /**
   * Environment variables for the spawned process. Used to carry
   * `ETHOS_MCP_KEY` — the bearer secret a stdio export client presents — into
   * the client's own config file, which is where such a secret belongs: the
   * client stores it, and it never reaches the terminal scrollback.
   *
   * Omitted entirely when empty, so a `localhost` export's entry is
   * byte-identical to one written before this field existed.
   */
  env?: Record<string, string>;
}

/** The entry key when none is given. The global console's server name. */
export const DEFAULT_ENTRY_NAME = 'ethos';

/** `entry.name`, defaulted. One helper so five adapters cannot disagree. */
export function entryName(entry: McpEntry): string {
  return entry.name ?? DEFAULT_ENTRY_NAME;
}

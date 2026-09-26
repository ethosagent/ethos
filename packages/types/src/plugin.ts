export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  extensions: string[];
  compat?: {
    pluginApi: string;
  };
  dataSources?: string[];
  hasWidgets?: boolean;
}

export interface WidgetTemplate {
  id: string;
  pluginId: string;
  title: string;
  description?: string;
  queryType: 'sql' | 'prompt';
  dataSource?: string;
  sql?: string;
  prompt?: string;
  outputType?: 'table' | 'html' | 'image' | 'text';
  defaultCron?: string;
}

export interface SlashCommandContext {
  sessionId: string;
  personalityId?: string;
  platform: string;
  send(text: string): Promise<void>;
  /**
   * Who ran the command, so a handler can refuse non-owners. `isOwner` is
   * true when `userId` equals `channel_filter.<platform>.ownerUserId`
   * (false when the platform has no owner configured); `isDm` is false in a
   * group chat, where the command affects people who did not run it. Filled
   * by the gateway (`Gateway.handleMessage`, plugin slash branch) and by the
   * local CLI surfaces (`chat.ts` readline, `makeTuiSlashCommands`) as
   * `{ userId: 'cli', isOwner: true, isDm: true }`. Absent means the host
   * does not know the sender — treat it as not the owner.
   */
  sender?: { userId: string; isOwner: boolean; isDm: boolean };
  toolRegistry?: import('./tool').ToolRegistry;
  storage?: import('./storage').Storage;
}

export interface CliSubcommandContext {
  argv: string[];
  cwd: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  storage?: import('./storage').Storage;
}

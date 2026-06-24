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

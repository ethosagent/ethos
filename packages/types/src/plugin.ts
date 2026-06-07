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

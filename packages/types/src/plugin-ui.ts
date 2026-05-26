/**
 * A section within a plugin's dedicated page.
 * Each section is backed by a tool call that fetches its data.
 */
export type PluginPageSection =
  | {
      type: 'tool-output';
      toolName: string;
      toolArgs?: Record<string, unknown>;
      label: string;
      autoRefreshMs?: number;
    }
  | {
      type: 'data-table';
      toolName: string;
      toolArgs?: Record<string, unknown>;
      label: string;
      columns: string[];
      autoRefreshMs?: number;
    }
  | {
      type: 'chart';
      toolName: string;
      toolArgs?: Record<string, unknown>;
      label: string;
      chartType: 'line' | 'bar' | 'candlestick';
      dataField: string;
      autoRefreshMs?: number;
    }
  | {
      type: 'metric';
      toolName: string;
      toolArgs?: Record<string, unknown>;
      label: string;
      valueField: string;
      unit?: string;
      autoRefreshMs?: number;
    }
  | {
      type: 'notification-feed';
      label: string;
      maxItems?: number;
    }
  | {
      type: 'custom';
      bundleExport: string;
      props?: Record<string, unknown>;
      label: string;
    };

export interface PluginPageSpec {
  title: string;
  icon?: string;
  sections: PluginPageSection[];
  showInSidebar?: boolean;
}

export interface PluginRendererSpec {
  type: string;
  template?: 'table' | 'chart' | 'card' | 'metric';
  bundleExport?: string;
}

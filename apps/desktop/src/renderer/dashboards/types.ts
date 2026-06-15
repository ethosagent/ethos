import type { createEthosClient } from '@ethosagent/sdk';

export type DashboardsClient = ReturnType<typeof createEthosClient>;

export interface ParamDef {
  key: string;
  label: string;
  type: 'select' | 'options' | 'date-range';
  options?: string[];
  default: string;
}

export interface EmitRule {
  on: 'rowClick';
  param: string;
  column: string;
  default: string;
}

export interface Dashboard {
  id: string;
  userId: string;
  personalityId: string;
  title: string;
  description: string | null;
  cronSchedule: string | null;
  paramsSchema: ParamDef[];
  paramsCurrent: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface Panel {
  id: string;
  dashboardId: string;
  queryType: 'static' | 'prompt' | 'sql' | 'header';
  blockType: 'html' | 'image' | 'pdf' | 'text' | 'table';
  content: string;
  metadata: Record<string, unknown> | null;
  title: string | null;
  prompt: string | null;
  sqlQuery: string | null;
  pluginId: string | null;
  dataSourceId: string | null;
  renderHint: string | null;
  cronSchedule: string | null;
  htmlTemplate: string | null;
  emitConfig: EmitRule[] | null;
  dependsOn: string[] | null;
  paramDefaults: Record<string, string>;
  lastRunAt: number | null;
  lastError: string | null;
  sourceConversationId: string | null;
  sourceMessageSeq: number | null;
  col: number;
  row: number;
  w: number;
  h: number;
  createdAt: number;
  updatedAt: number;
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

export interface Personality {
  id: string;
  name: string;
}

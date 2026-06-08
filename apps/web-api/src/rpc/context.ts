import type { AgentLoop, ClarifyBridge } from '@ethosagent/core';
import type { PluginLoader } from '@ethosagent/plugin-loader';
import type { ToolRegistry, WidgetTemplate } from '@ethosagent/types';
import { contract } from '@ethosagent/web-contracts';
import { implement } from '@orpc/server';
import type { ChatService } from '../features/chat/service';
import type { DebugService } from '../features/debug/service';
import type { SessionsService } from '../features/sessions/service';
import type { ApiKeysService } from '../services/api-keys.service';
import type { ApprovalsService } from '../services/approvals.service';
import type { ConfigService } from '../services/config.service';
import type { CronService } from '../services/cron.service';
import type {
  AddPanelInput,
  Dashboard,
  DashboardPanel,
  EmitRule,
  ParamDef,
} from '../services/dashboards.service';
import type { EvolverService } from '../services/evolver.service';
import type { KanbanService } from '../services/kanban.service';
import type { LabService } from '../services/lab.service';
import type { McpService } from '../services/mcp.service';
import type { MemoryService } from '../services/memory.service';
import type { MeshService } from '../services/mesh.service';
import type { OnboardingService } from '../services/onboarding.service';
import type { PersonalitiesService } from '../services/personalities.service';
import type { PlatformsService } from '../services/platforms.service';
import type { PluginsService } from '../services/plugins.service';
import type { SkillsService } from '../services/skills.service';

// Shared context type for every oRPC handler in the web-api. Each namespace
// file imports `os` from here (not from `@orpc/server` directly) so TypeScript
// sees one consistent context shape across the merged router.
//
// Adding a service: add the field here, register it in `createWebApi` →
// `createRoutes` → `RpcRoutesOptions.services`, and the new namespace's
// handlers can reach it via `({ context }) => context.<name>`.

export interface RpcContext {
  sessions: SessionsService;
  chat: ChatService;
  debug: DebugService;
  personalities: PersonalitiesService;
  config: ConfigService;
  onboarding: OnboardingService;
  approvals: ApprovalsService;
  /** Bridge backing the `clarify` tool — undefined when the loop has none. */
  clarifyBridge?: ClarifyBridge;
  cron: CronService;
  skills: SkillsService;
  evolver: EvolverService;
  mesh: MeshService;
  memory: MemoryService;
  plugins: PluginsService;
  mcp: McpService;
  platforms: PlatformsService;
  lab: LabService;
  kanban: KanbanService;
  apiKeys: ApiKeysService;
  toolRegistry?: ToolRegistry;
  dashboards?: DashboardsService;
  pluginLoader?: PluginLoader;
  agentLoop?: AgentLoop;
}

export interface DashboardsService {
  listWidgetTemplates(): Promise<WidgetTemplate[]>;
  create(userId: string, title: string, personalityId: string, description?: string): Dashboard;
  list(userId: string): Dashboard[];
  get(id: string): { dashboard: Dashboard; panels: DashboardPanel[] } | null;
  update(
    id: string,
    patch: {
      title?: string;
      description?: string;
      cronSchedule?: string | null;
      paramsSchema?: ParamDef[];
    },
  ): void;
  delete(id: string): void;
  addPanel(dashboardId: string, panel: AddPanelInput): DashboardPanel;
  updatePanel(
    panelId: string,
    patch: {
      title?: string;
      cronSchedule?: string | null;
      queryType?: 'static' | 'prompt' | 'sql' | 'header';
      prompt?: string | null;
      sqlQuery?: string | null;
      pluginId?: string | null;
      dataSourceId?: string | null;
      htmlTemplate?: string | null;
      emitConfig?: EmitRule[] | null;
      dependsOn?: string[] | null;
      paramDefaults?: Record<string, string>;
    },
  ): void;
  updatePanelLayout(
    panelId: string,
    layout: { col: number; row: number; w: number; h: number },
  ): void;
  deletePanel(panelId: string): void;
  getPanel(panelId: string): DashboardPanel | null;
  listLivePanels(dashboardId: string): DashboardPanel[];
  updatePanelContent(panelId: string, content: string, blockType?: string): void;
  setPanelError(panelId: string, error: string): void;
  clearPanelError(panelId: string): void;
  updateDashboardParams(id: string, paramsCurrent: Record<string, string>): void;
  updatePanelParamDefaults(panelId: string, values: Record<string, string>): void;
  exportDashboard(id: string): object | null;
  importDashboard(
    data: {
      version: number;
      title: string;
      paramsSchema?: ParamDef[];
      paramsCurrent?: Record<string, string>;
      cronSchedule?: string | null;
      panels: Array<{
        title: string | null;
        queryType: string;
        blockType: string;
        content: string;
        prompt: string | null;
        sqlQuery: string | null;
        pluginId: string | null;
        dataSourceId: string | null;
        cronSchedule: string | null;
        htmlTemplate: string | null;
        emitConfig: EmitRule[] | null;
        dependsOnIndices: number[];
        paramDefaults?: Record<string, string>;
        col: number;
        row: number;
        w: number;
        h: number;
      }>;
    },
    userId: string,
    personalityId: string,
  ): { dashboardId: string; warnings: string[] };
}

export const os = implement(contract).$context<RpcContext>();

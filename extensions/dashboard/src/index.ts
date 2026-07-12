// Public API for `@ethosagent/dashboard` — the dashboard subsystem extracted
// from `apps/web-api`. Owns the SQLite data layer (service + agent-tool store),
// the panel-refresh runner, the param-interpolation/validation helpers, and the
// cron-driven refresh scheduler.

export type {
  RefreshablePanelData,
  RefreshDashboardsHandle,
  RefreshOrchestratorDeps,
} from './dashboard-refresh';
// --- Panel refresh ---------------------------------------------------------
export {
  buildRefreshLayers,
  refreshAllPanels,
  refreshPanelById,
  refreshSinglePanel,
} from './dashboard-refresh';
export type { AddPanelParams, CreateDashboardParams } from './dashboard-store';
// --- Agent-tool store ------------------------------------------------------
export { DashboardStore } from './dashboard-store';
export type {
  AddPanelInput,
  Dashboard,
  DashboardPanel,
  DashboardsServiceOptions,
  EmitRule,
  ParamDef,
  ParamType,
} from './dashboards.service';
// --- SQLite data layer -----------------------------------------------------
export {
  buildPromptSummary,
  DashboardsService,
  runPluginQuery,
} from './dashboards.service';
export type { DashboardImportPayload } from './interpolate-params';
// --- Param interpolation + validation --------------------------------------
export {
  assertSelectOnlySql,
  DashboardImportPayloadSchema,
  expandDateRangeParams,
  extractParamRefs,
  findInvalidParamKeys,
  interpolateParams,
  parseImportPayload,
  validateParamValue,
} from './interpolate-params';
export type {
  DashboardRefreshSchedulerConfig,
  DashboardRefreshSource,
} from './refresh-scheduler';
// --- Cron-driven refresh scheduler -----------------------------------------
export { DashboardRefreshScheduler } from './refresh-scheduler';

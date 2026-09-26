// The web-api's one door onto `@ethosagent/dashboard`.
//
// `rpc/dashboards.ts` and `rpc/context.ts` are thin oRPC shells and do not
// import extension packages (architecture.config.ts `web-api-rpc-is-thin`,
// apps/web-api/src/__tests__/layering.test.ts). They reach the dashboard
// extension through this module instead, the same way every other rpc shell
// reaches its extension through a file under `services/`. The store itself is
// constructed by the app entry (`createWebApi` in apps/web-api/src/index.ts)
// and arrives on `RpcContext.dashboards`.
export {
  buildPromptSummary,
  type DashboardsService,
  refreshAllPanels,
  refreshPanelById,
  runPluginQuery,
} from '@ethosagent/dashboard';

import { oc } from '@orpc/contract';
import { z } from 'zod';
import {
  BackgroundJobDetailSchema,
  BackgroundJobSummarySchema,
  DigestLatestSchema,
  GoalAttemptSchema,
  GoalEventSchema,
  GoalSchema,
  GoalStatusSchema,
} from '../schemas';

// ---------------------------------------------------------------------------
// Dashboards — widget templates from plugins + dashboard/panel CRUD
// ---------------------------------------------------------------------------

const WidgetTemplateSchema = z.object({
  id: z.string(),
  pluginId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  queryType: z.enum(['sql', 'prompt']),
  dataSource: z.string().optional(),
  sql: z.string().optional(),
  prompt: z.string().optional(),
  outputType: z.enum(['table', 'html', 'image', 'text']).optional(),
  defaultCron: z.string().optional(),
});

const DashboardsListWidgetTemplatesOutput = z.object({
  templates: z.array(WidgetTemplateSchema),
});

const ParamDefSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['select', 'options', 'date-range']),
  options: z.array(z.string()).optional(),
  default: z.string(),
});

const EmitRuleSchema = z.object({
  on: z.enum(['rowClick']),
  param: z.string(),
  column: z.string(),
  default: z.string(),
});

// Dashboard schemas
const DashboardSchema = z.object({
  id: z.string(),
  userId: z.string(),
  personalityId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  cronSchedule: z.string().nullable(),
  paramsSchema: z.array(ParamDefSchema),
  paramsCurrent: z.record(z.string(), z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const DashboardPanelSchema = z.object({
  id: z.string(),
  dashboardId: z.string(),
  queryType: z.enum(['static', 'prompt', 'sql', 'header']),
  blockType: z.enum(['html', 'image', 'pdf', 'text', 'table']),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  title: z.string().nullable(),
  prompt: z.string().nullable(),
  sqlQuery: z.string().nullable(),
  pluginId: z.string().nullable(),
  dataSourceId: z.string().nullable(),
  renderHint: z.string().nullable(),
  cronSchedule: z.string().nullable(),
  htmlTemplate: z.string().nullable(),
  emitConfig: z.array(EmitRuleSchema).nullable(),
  dependsOn: z.array(z.string()).nullable(),
  paramDefaults: z.record(z.string(), z.string()),
  lastRunAt: z.number().nullable(),
  lastError: z.string().nullable(),
  sourceConversationId: z.string().nullable(),
  sourceMessageSeq: z.number().nullable(),
  col: z.number(),
  row: z.number(),
  w: z.number(),
  h: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

// Input schemas
const DashboardsCreateInput = z.object({
  title: z.string().min(1),
  personalityId: z.string().min(1),
  description: z.string().optional(),
});

const DashboardsGetInput = z.object({ id: z.string().min(1) });
const DashboardsUpdateInput = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  cronSchedule: z.string().nullable().optional(),
  paramsSchema: z.array(ParamDefSchema).optional(),
});
const DashboardsDeleteInput = z.object({ id: z.string().min(1) });

const DashboardsAddPanelInput = z.object({
  dashboardId: z.string().nullable(),
  newDashboardTitle: z.string().optional(),
  personalityId: z.string().optional(),
  paramsSchema: z.array(ParamDefSchema).optional(),
  panel: z.object({
    queryType: z.enum(['static', 'prompt', 'sql', 'header']),
    blockType: z.enum(['html', 'image', 'pdf', 'text', 'table']),
    content: z.string(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    title: z.string().optional(),
    prompt: z.string().optional(),
    sqlQuery: z.string().optional(),
    pluginId: z.string().optional(),
    dataSourceId: z.string().optional(),
    htmlTemplate: z.string().optional(),
    renderHint: z.string().optional(),
    cronSchedule: z.string().optional(),
    sourceConversationId: z.string().optional(),
    sourceMessageSeq: z.number().optional(),
  }),
});

const DashboardsUpdatePanelInput = z.object({
  panelId: z.string().min(1),
  title: z.string().optional(),
  cronSchedule: z.string().nullable().optional(),
  queryType: z.enum(['static', 'prompt', 'sql', 'header']).optional(),
  prompt: z.string().nullable().optional(),
  sqlQuery: z.string().nullable().optional(),
  pluginId: z.string().nullable().optional(),
  dataSourceId: z.string().nullable().optional(),
  htmlTemplate: z.string().nullable().optional(),
  emitConfig: z.array(EmitRuleSchema).nullable().optional(),
  dependsOn: z.array(z.string()).nullable().optional(),
  paramDefaults: z.record(z.string(), z.string()).optional(),
});

const DashboardsUpdatePanelLayoutInput = z.object({
  panelId: z.string().min(1),
  col: z.number(),
  row: z.number(),
  w: z.number(),
  h: z.number(),
});

const DashboardsDeletePanelInput = z.object({ panelId: z.string().min(1) });

const DashboardsRefreshPanelInput = z.object({ panelId: z.string().min(1) });
const DashboardsRefreshAllInput = z.object({ dashboardId: z.string().min(1) });

const DashboardsUpdateParamsInput = z.object({
  id: z.string().min(1),
  paramsCurrent: z.record(z.string(), z.string()),
});

const DashboardsExportInput = z.object({
  id: z.string().min(1),
});

const DashboardsImportInput = z.object({
  exportJson: z.string(),
  titleOverride: z.string().optional(),
});

/** @experimental */
export const dashboards = {
  create: oc.input(DashboardsCreateInput).output(z.object({ dashboard: DashboardSchema })),
  list: oc.output(z.object({ dashboards: z.array(DashboardSchema) })),
  get: oc.input(DashboardsGetInput).output(
    z.object({
      dashboard: DashboardSchema,
      panels: z.array(DashboardPanelSchema),
    }),
  ),
  update: oc.input(DashboardsUpdateInput).output(z.object({ ok: z.literal(true) })),
  delete: oc.input(DashboardsDeleteInput).output(z.object({ ok: z.literal(true) })),
  addPanel: oc.input(DashboardsAddPanelInput).output(z.object({ panel: DashboardPanelSchema })),
  updatePanel: oc.input(DashboardsUpdatePanelInput).output(z.object({ ok: z.literal(true) })),
  updatePanelLayout: oc
    .input(DashboardsUpdatePanelLayoutInput)
    .output(z.object({ ok: z.literal(true) })),
  deletePanel: oc.input(DashboardsDeletePanelInput).output(z.object({ ok: z.literal(true) })),
  refreshPanel: oc.input(DashboardsRefreshPanelInput).output(z.object({ ok: z.literal(true) })),
  refreshAll: oc.input(DashboardsRefreshAllInput).output(z.object({ ok: z.literal(true) })),
  summarizePrompt: oc
    .input(z.object({ sessionId: z.string().min(1) }))
    .output(z.object({ summary: z.string() })),
  listWidgetTemplates: oc.output(DashboardsListWidgetTemplatesOutput),
  runQuery: oc
    .input(
      z.object({
        pluginId: z.string().min(1),
        sourceId: z.string().min(1),
        sql: z.string().min(1),
      }),
    )
    .output(
      z.object({
        columns: z.array(z.string()),
        rows: z.array(z.record(z.string(), z.unknown())),
      }),
    ),
  updateParams: oc.input(DashboardsUpdateParamsInput).output(z.object({ ok: z.literal(true) })),
  exportDashboard: oc
    .input(DashboardsExportInput)
    .output(z.object({ json: z.string(), panelCount: z.number(), title: z.string() })),
  importDashboard: oc.input(DashboardsImportInput).output(
    z.object({
      dashboardId: z.string(),
      title: z.string(),
      warnings: z.array(z.string()),
    }),
  ),
};

// ---------------------------------------------------------------------------
// Admin — unified status view for channels, providers, and MCP servers
// ---------------------------------------------------------------------------

export const admin = {
  getStatus: oc.output(
    z.object({
      channels: z.array(
        z.object({
          id: z.string(),
          platform: z.string(),
          status: z.enum(['connected', 'disconnected', 'error']),
          webhookUrl: z.string().optional(),
        }),
      ),
      providers: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          hasKey: z.boolean(),
          healthy: z.boolean().optional(),
          latencyMs: z.number().optional(),
        }),
      ),
      mcpServers: z.array(
        z.object({
          name: z.string(),
          status: z.enum(['connected', 'disconnected', 'error']),
          toolCount: z.number().optional(),
        }),
      ),
      /**
       * The remote execution backend, when this deployment declares one
       * (`execution.ssh.host`). Null when it does not — a fresh install has no
       * remote target and must not be told anything is wrong with it.
       *
       * `resolved: false` is the boot-failure state
       * (plan/phases/remote-execution-routing.md §6): the backend the posture
       * NAMES could not be constructed in this process, so nothing routed to it
       * will run. It is deliberately NOT a reachability answer — resolving a
       * backend opens no connection, and this panel must not spend an ssh
       * round trip on every status poll. Reachability is `execution.probeSsh`.
       */
      executionBackend: z
        .object({
          name: z.literal('ssh'),
          resolved: z.boolean(),
          /** Why resolution failed, verbatim. Null when it did not. */
          error: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
  rotateKey: oc
    .input(
      z.object({
        provider: z.string(),
        key: z.string(),
      }),
    )
    .output(z.object({ ok: z.literal(true) })),
  checkProvider: oc
    .input(
      z.object({
        provider: z.string(),
      }),
    )
    .output(z.object({ ok: z.boolean(), latencyMs: z.number() })),
  testSend: oc
    .input(
      z.object({
        channel: z.string(),
      }),
    )
    .output(z.object({ ok: z.boolean(), error: z.string().optional() })),
  addMcpServer: oc
    .input(
      z.object({
        name: z.string(),
        url: z.string(),
        authType: z.enum(['none', 'bearer', 'oauth']),
      }),
    )
    .output(z.object({ ok: z.literal(true) })),
  removeMcpServer: oc
    .input(
      z.object({
        name: z.string(),
      }),
    )
    .output(z.object({ ok: z.literal(true) })),
};

// ---------------------------------------------------------------------------
// Context — resolve @file / @url inline references (Gap 4)
// ---------------------------------------------------------------------------

export const context = {
  resolve: oc.input(z.object({ refs: z.array(z.string()) })).output(
    z.object({
      resolved: z.array(
        z.object({
          ref: z.string(),
          content: z.string(),
          lang: z.string(),
        }),
      ),
    }),
  ),
};

// ---------------------------------------------------------------------------
// Files — list workspace files for @-mention autocomplete (Gap 4)
// ---------------------------------------------------------------------------

export const files = {
  list: oc.input(z.object({ prefix: z.string().optional() })).output(
    z.object({
      paths: z.array(z.string()),
    }),
  ),
};

// ---------------------------------------------------------------------------
// Slash commands (v3 — plugin-registered dynamic commands)
// ---------------------------------------------------------------------------

const SlashCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  usage: z.string(),
  pluginId: z.string().optional(),
});

export const slashCommands = {
  list: oc.output(z.object({ commands: z.array(SlashCommandSchema) })),
};

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

const GoalGetInput = z.object({ id: z.string().min(1) });
const GoalGetOutput = z.object({
  goal: GoalSchema,
  events: z.array(GoalEventSchema),
  attempts: z.array(GoalAttemptSchema),
});

const GoalListInput = z.object({
  status: GoalStatusSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
const GoalListOutput = z.object({ goals: z.array(GoalSchema) });

const GoalSteerInput = z.object({ id: z.string().min(1), message: z.string().min(1) });
const GoalSteerOutput = z.object({ ok: z.boolean() });

const GoalCancelInput = z.object({ id: z.string().min(1) });
const GoalCancelOutput = z.object({ ok: z.boolean() });

const GoalResumeInput = z.object({ id: z.string().min(1) });
const GoalResumeOutput = z.object({ ok: z.boolean() });

const GoalCreateInput = z.object({
  personalityId: z.string().min(1),
  goalText: z.string().min(1),
  title: z.string().optional(),
  acceptanceCriteria: z
    .object({
      // `command` runs as the goal personality's `terminal` would when the
      // goal is judged (`createAcceptanceCheckExecutor`, packages/wiring); the
      // server refuses it unless `goals.allowCheckCommands: true`
      // (`GoalsService.create`, apps/web-api/src/services/goals.service.ts).
      checks: z
        .array(z.object({ description: z.string(), command: z.string().optional() }))
        .optional(),
      rubric: z.array(z.object({ description: z.string(), weight: z.number() })).optional(),
      threshold: z.number().optional(),
    })
    .optional(),
  maxAttempts: z.number().int().min(1).optional(),
  maxCostUsd: z.number().optional(),
  maxToolCallsPerTurn: z.number().int().min(1).optional(),
  maxIdenticalToolCalls: z.number().int().min(1).optional(),
  allowDangerousToolCalls: z.boolean().optional(),
  maxRecoveryAttempts: z.number().int().min(0).optional(),
  deadline: z.string().optional(),
});
const GoalCreateOutput = z.object({ goal: GoalSchema });

const GoalSettingsOutput = z.object({ allowCheckCommands: z.boolean() });

const GoalToolResultInput = z.object({
  goalId: z.string().min(1),
  toolCallId: z.string().min(1),
});
const GoalToolResultOutput = z.object({
  found: z.boolean(),
  toolName: z.string().optional(),
  input: z.string().optional(),
  output: z.string().optional(),
});

/** @experimental */
export const goals = {
  get: oc.input(GoalGetInput).output(GoalGetOutput),
  list: oc.input(GoalListInput).output(GoalListOutput),
  steer: oc.input(GoalSteerInput).output(GoalSteerOutput),
  cancel: oc.input(GoalCancelInput).output(GoalCancelOutput),
  resume: oc.input(GoalResumeInput).output(GoalResumeOutput),
  create: oc.input(GoalCreateInput).output(GoalCreateOutput),
  settings: oc.output(GoalSettingsOutput),
  toolResult: oc.input(GoalToolResultInput).output(GoalToolResultOutput),
};

// ---------------------------------------------------------------------------
// Tasks — background-job (detached spawn-and-continue) surface
//
// Read-only plus one cancel: `list` enumerates jobs (optionally scoped to a
// root session), `get` reads one job with its ordered event trail (null when
// absent), `cancel` requests cancellation. The JobStore is the source of
// truth; the server maps rows to the wire schemas in `schemas.ts`.
// ---------------------------------------------------------------------------

const TasksListInput = z.object({ rootSessionKey: z.string().optional() });
const TasksListOutput = z.array(BackgroundJobSummarySchema);

const TasksGetInput = z.object({ id: z.string().min(1) });
const TasksGetOutput = BackgroundJobDetailSchema.nullable();

const TasksCancelInput = z.object({ id: z.string().min(1) });
const TasksCancelOutput = z.object({ ok: z.boolean() });

/** @experimental */
export const tasks = {
  list: oc.input(TasksListInput).output(TasksListOutput),
  get: oc.input(TasksGetInput).output(TasksGetOutput),
  cancel: oc.input(TasksCancelInput).output(TasksCancelOutput),
};

// ---------------------------------------------------------------------------
// Digest — read-only view of the most recent weekly governed-learning digest
//
// The weekly digest writes Markdown to `~/.ethos/digests/<ISO-week>.md`.
// `digest.latest` returns the newest file (or null when none exist).
// `digest.generate` builds + writes the current ISO week's digest on demand
// (the same generator the weekly cron / `ethos digest run` drives), returning
// it — or null when there are no user personalities to report on.
// ---------------------------------------------------------------------------

/** @experimental */
export const digest = {
  latest: oc.output(DigestLatestSchema.nullable()),
  generate: oc.output(DigestLatestSchema.nullable()),
};

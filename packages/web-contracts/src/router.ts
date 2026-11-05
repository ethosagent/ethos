import { backup, execution } from './routes/backup-execution';
import { catalog } from './routes/catalog';
import { approvals, chat, clarify, onboarding, tools } from './routes/chat-tools';
import { config } from './routes/config';
import { cron, debug, evolver, skills } from './routes/cron-skills';
import { a2a, amendments, channels, deliveries, learning, outbox, usage } from './routes/delivery';
import { documents, recipes } from './routes/docs-recipes';
import { apiKeys, credentials, keys, namedSecrets, toolSettings } from './routes/keys';
import { batch, evalNs, kanban, memory, mesh, teams } from './routes/memory-lab';
import { decisions, meta, modelRegistry, models } from './routes/models';
import {
  admin,
  context,
  dashboards,
  digest,
  files,
  goals,
  slashCommands,
  tasks,
} from './routes/ops';
import { personalities } from './routes/personalities';
import { mcp, platforms, plugins } from './routes/platforms-plugins-mcp';
import { activity, sessions } from './routes/sessions-activity';
import { voice } from './routes/voice';

export { type ModelRegistryAdoptedModel, ModelRegistryAdoptedModelSchema } from './routes/_shared';
export type {
  BackupArchive,
  BackupCreateResult,
  BackupLastRun,
  BackupRestoreResult,
  BackupSchedule,
  BackupScopeName,
  BackupStatus,
  BackupStoreRow,
  ExecutionProbeResult,
  ExecutionProbeState,
} from './routes/backup-execution';
export { type KeyBlobDetails, KeyBlobDetailsSchema } from './routes/keys';
export {
  type DecisionProviderType,
  DecisionProviderTypeSchema,
  type DecisionProviderUser,
  DecisionProviderUserSchema,
  type DecisionProviderView,
  DecisionProviderViewSchema,
  DecisionsListOutput,
  type DecisionsListResult,
  DecisionsTestInput,
  DecisionsTestOutput,
  type DecisionsTestResult,
  type DecisionTestErrorCode,
  DecisionTestErrorCodeSchema,
  ModelCatalogOutput,
  type ModelCredentialStatus,
  ModelCredentialStatusSchema,
  type ModelProviderEntryView,
  ModelProviderEntryViewSchema,
  type ModelReferent,
  ModelReferentSchema,
  ModelRegistryAddProviderInput,
  ModelRegistryAddProviderOutput,
  type ModelRegistryAddProviderRequest,
  type ModelRegistryAddProviderResult,
  ModelRegistryBindableRoleSchema,
  type ModelRegistryChainModel,
  ModelRegistryChainModelSchema,
  type ModelRegistryEntryView,
  ModelRegistryEntryViewSchema,
  ModelRegistryImportChainInput,
  ModelRegistryImportChainOutput,
  type ModelRegistryImportChainResult,
  ModelRegistryListOutput,
  type ModelRegistryListResult,
  ModelRegistryProblemSchema,
  type ModelRegistryProblemView,
  type ModelRegistryProviderRefusal,
  ModelRegistryProviderRefusalSchema,
  ModelRegistryProviderWriteOutput,
  type ModelRegistryProviderWriteResult,
  type ModelRegistryRefusal,
  ModelRegistryRefusalSchema,
  ModelRegistryRemoveInput,
  ModelRegistryRemoveOutput,
  type ModelRegistryRemoveResult,
  ModelRegistryTestAllOutput,
  type ModelRegistryTestAllResult,
  ModelRegistryTestInput,
  ModelRegistryTestOutput,
  type ModelRegistryTestResult,
  ModelRegistryUpdateProviderInput,
  ModelRegistryUpsertInput,
  type ModelRegistryUpsertRequest,
  ModelRegistryWriteOutput,
  type ModelRegistryWriteResult,
} from './routes/models';
export type { DockerAbsentWire, ExecutionPostureWire } from './routes/personalities';
export type { ActivityHistoryItemWire, ContextAnatomyWire } from './routes/sessions-activity';
export {
  type CallDetail,
  CallDetailSchema,
  type CallDirection,
  CallDirectionSchema,
  type CallStatus,
  CallStatusSchema,
  type CallSummary,
  CallSummarySchema,
  CallTierSchema,
} from './routes/voice';

// oRPC contract — single source of truth for the web control plane.
// `apps/web-api` (server) calls `implement(contract)` against this.
// `apps/web` (client) calls `createORPCClient(link)` typed as
// `ContractRouterClient<typeof contract>`. Both ends fail to compile if the
// shapes drift.
//
// v0 surface: sessions / personalities (read-only) / chat / tools /
// onboarding / config. v0.5 (cron, skills, mesh) and v1 (memory, comms,
// plugins, settings, batch, eval) namespaces land in their own phases.

// ---------------------------------------------------------------------------
// Root contract — every namespace mounted under one symbol
// ---------------------------------------------------------------------------

export const contract = {
  sessions,
  activity,
  personalities,
  chat,
  tools,
  approvals,
  clarify,
  onboarding,
  config,
  debug,
  cron,
  skills,
  slashCommands,
  evolver,
  mesh,
  memory,
  plugins,
  mcp,
  platforms,
  batch,
  eval: evalNs,
  kanban,
  teams,
  apiKeys,
  meta,
  models,
  modelRegistry,
  decisions,
  dashboards,
  admin,
  context,
  files,
  goals,
  tasks,
  digest,
  voice,
  deliveries,
  usage,
  outbox,
  learning,
  amendments,
  channels,
  a2a,
  namedSecrets,
  credentials,
  keys,
  toolSettings,
  documents,
  recipes,
  catalog,
  backup,
  execution,
};

export type Contract = typeof contract;

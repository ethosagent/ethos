import { chatAbort } from '../features/chat/rpc/abort';
import { chatSend } from '../features/chat/rpc/send';
import { chatSteer } from '../features/chat/rpc/steer';
import { debugChat } from '../features/debug/rpc/chat';
import { sessionsCompact } from '../features/sessions/rpc/compact';
import { sessionsContextAnatomy } from '../features/sessions/rpc/context-anatomy';
import { sessionsDelete } from '../features/sessions/rpc/delete';
import { sessionsExport } from '../features/sessions/rpc/export';
import { sessionsFork } from '../features/sessions/rpc/fork';
import { sessionsGet } from '../features/sessions/rpc/get';
import { sessionsList } from '../features/sessions/rpc/list';
import { sessionsMessages } from '../features/sessions/rpc/messages';
import { sessionsPin } from '../features/sessions/rpc/pin';
import { sessionsUnpin } from '../features/sessions/rpc/unpin';
import { sessionsUpdate } from '../features/sessions/rpc/update';
import { a2aRouter } from './a2a';
import { activityRouter } from './activity';
import { adminRouter } from './admin';
import { apiKeysRouter } from './api-keys';
import { approvalsRouter } from './approvals';
import { backupRouter } from './backup';
import { batchRouter } from './batch';
import { channelsRouter } from './channels';
import { clarifyRouter } from './clarify';
import { configRouter } from './config';
import { contextRouter, filesRouter } from './context-resolve';
import { credentialsRouter } from './credentials';
import { cronRouter } from './cron';
import { dashboardsRouter } from './dashboards';
import { deliveriesRouter } from './deliveries';
import { digestRouter } from './digest';
import { documentsRouter } from './documents';
import { evalRouter } from './eval';
import { evolverRouter } from './evolver';
import { executionRouter } from './execution';
import { goalsRouter } from './goals';
import { kanbanRouter } from './kanban';
import { keysRouter } from './keys';
import { learningRouter } from './learning';
import { mcpRouter } from './mcp';
import { memoryRouter } from './memory';
import { meshRouter } from './mesh';
import { metaRouter } from './meta';
import { modelRegistryRouter } from './model-registry';
import { modelsRouter } from './models';
import { namedSecretsRouter } from './named-secrets';
import { onboardingRouter } from './onboarding';
import { outboxRouter } from './outbox';
import { personalitiesRouter } from './personalities';
import { personalitiesMcpExportRouter } from './personalities-mcp-export';
import { platformsRouter } from './platforms';
import { pluginsRouter } from './plugins';
import { recipesRouter } from './recipes';
import { skillsRouter } from './skills';
import { slashCommandsRouter } from './slash-commands';
import { tasksRouter } from './tasks';
import { teamsRouter } from './teams';
import { toolSettingsRouter } from './tool-settings';
import { toolsRouter } from './tools';
import { voiceRouter } from './voice';

// Top-level oRPC router. Each namespace lives in its own file (one
// `os.<namespace>.<method>.handler(...)` per procedure); this file only
// composes them. Add a namespace by importing its router and mounting it
// on `apiRouter` below — keep handler logic in the per-namespace file.

export const apiRouter = {
  sessions: {
    list: sessionsList,
    get: sessionsGet,
    messages: sessionsMessages,
    fork: sessionsFork,
    delete: sessionsDelete,
    update: sessionsUpdate,
    export: sessionsExport,
    pin: sessionsPin,
    unpin: sessionsUnpin,
    contextAnatomy: sessionsContextAnatomy,
    compact: sessionsCompact,
  },
  activity: activityRouter,
  chat: {
    send: chatSend,
    abort: chatAbort,
    steer: chatSteer,
  },
  debug: {
    chat: debugChat,
  },
  // `personalities.ts` sits at the handler-file line cap; M-T9's read mounts beside it.
  personalities: { ...personalitiesRouter, ...personalitiesMcpExportRouter },
  config: configRouter,
  onboarding: onboardingRouter,
  tools: toolsRouter,
  approvals: approvalsRouter,
  clarify: clarifyRouter,
  cron: cronRouter,
  skills: skillsRouter,
  slashCommands: slashCommandsRouter,
  evolver: evolverRouter,
  mesh: meshRouter,
  memory: memoryRouter,
  plugins: pluginsRouter,
  mcp: mcpRouter,
  platforms: platformsRouter,
  batch: batchRouter,
  eval: evalRouter,
  kanban: kanbanRouter,
  teams: teamsRouter,
  tasks: tasksRouter,
  apiKeys: apiKeysRouter,
  meta: metaRouter,
  models: modelsRouter,
  modelRegistry: modelRegistryRouter,
  dashboards: dashboardsRouter,
  admin: adminRouter,
  context: contextRouter,
  files: filesRouter,
  goals: goalsRouter,
  digest: digestRouter,
  voice: voiceRouter,
  deliveries: deliveriesRouter,
  outbox: outboxRouter,
  learning: learningRouter,
  channels: channelsRouter,
  a2a: a2aRouter,
  namedSecrets: namedSecretsRouter,
  credentials: credentialsRouter,
  keys: keysRouter,
  toolSettings: toolSettingsRouter,
  documents: documentsRouter,
  recipes: recipesRouter,
  backup: backupRouter,
  execution: executionRouter,
};

export type ApiRouter = typeof apiRouter;

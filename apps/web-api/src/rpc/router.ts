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
import { sessionsPin } from '../features/sessions/rpc/pin';
import { sessionsUnpin } from '../features/sessions/rpc/unpin';
import { sessionsUpdate } from '../features/sessions/rpc/update';
import { a2aRouter } from './a2a';
import { adminRouter } from './admin';
import { apiKeysRouter } from './api-keys';
import { batchRouter } from './batch';
import { clarifyRouter } from './clarify';
import { configRouter } from './config';
import { contextRouter, filesRouter } from './context-resolve';
import { cronRouter } from './cron';
import { dashboardsRouter } from './dashboards';
import { digestRouter } from './digest';
import { evalRouter } from './eval';
import { evolverRouter } from './evolver';
import { goalsRouter } from './goals';
import { kanbanRouter } from './kanban';
import { mcpRouter } from './mcp';
import { memoryRouter } from './memory';
import { meshRouter } from './mesh';
import { metaRouter } from './meta';
import { modelsRouter } from './models';
import { onboardingRouter } from './onboarding';
import { personalitiesRouter } from './personalities';
import { platformsRouter } from './platforms';
import { pluginsRouter } from './plugins';
import { skillsRouter } from './skills';
import { slashCommandsRouter } from './slash-commands';
import { tasksRouter } from './tasks';
import { toolsRouter } from './tools';
import { voiceRouter } from './voice';

// Top-level oRPC router. Each namespace lives in its own file (one
// `os.<namespace>.<method>.handler(...)` per procedure); this file only
// composes them.
//
// Namespaces in place:
//   • sessions      — list / get / fork / delete
//   • chat          — send / abort (SSE handles the streamed response)
//   • personalities — list / get (read-only — full lifecycle in v1)
//   • config        — get with redacted apiKey / update
//   • onboarding    — state / validateProvider / complete
//   • tools         — approve / deny (resolves pending approvals; the
//                     `before_tool_call` hook + SSE handle the request side)
//   • cron          — proactive pillar (v0.5)
//   • skills        — library CRUD over ~/.ethos/skills/*.md (v0.5)
//   • evolver       — config + approval queue + run history (v0.5)
//   • mesh          — list live mesh agents + route test (v0.5)
//   • memory        — read/write MEMORY.md + USER.md (v1)
//   • plugins       — list installed plugins + configured MCP servers (v1)
//   • platforms     — Telegram/Slack/Discord/Email connection state + setup (v1)
//   • batch         — Lab: BatchRunner submissions + progress (v1)
//   • eval          — Lab: EvalRunner submissions + scoring (v1)

export const apiRouter = {
  sessions: {
    list: sessionsList,
    get: sessionsGet,
    fork: sessionsFork,
    delete: sessionsDelete,
    update: sessionsUpdate,
    export: sessionsExport,
    pin: sessionsPin,
    unpin: sessionsUnpin,
    contextAnatomy: sessionsContextAnatomy,
    compact: sessionsCompact,
  },
  chat: {
    send: chatSend,
    abort: chatAbort,
    steer: chatSteer,
  },
  debug: {
    chat: debugChat,
  },
  personalities: personalitiesRouter,
  config: configRouter,
  onboarding: onboardingRouter,
  tools: toolsRouter,
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
  tasks: tasksRouter,
  apiKeys: apiKeysRouter,
  meta: metaRouter,
  models: modelsRouter,
  dashboards: dashboardsRouter,
  admin: adminRouter,
  context: contextRouter,
  files: filesRouter,
  goals: goalsRouter,
  digest: digestRouter,
  voice: voiceRouter,
  a2a: a2aRouter,
};

export type ApiRouter = typeof apiRouter;

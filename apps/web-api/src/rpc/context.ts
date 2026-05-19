import type { ClarifyBridge } from '@ethosagent/core';
import { contract } from '@ethosagent/web-contracts';
import { implement } from '@orpc/server';
import type { ApiKeysService } from '../services/api-keys.service';
import type { ApprovalsService } from '../services/approvals.service';
import type { ChatService } from '../services/chat.service';
import type { ConfigService } from '../services/config.service';
import type { CronService } from '../services/cron.service';
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
import type { SessionsService } from '../services/sessions.service';
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
}

export const os = implement(contract).$context<RpcContext>();

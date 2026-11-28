// L7 of the initiative read-only enforcement map (plan initiative-engine, Task 2.7).
//
// Composes the REAL tool registry (`createAgentLoop` under every profile, plus the
// factories a host registers outside it (browser, A2A, kanban, goals, watchers, cron,
// dashboard, team memory, debug, decide, skill_read, takeover, initiative ledger), as
// shared-audience-process-tools.test.ts does) and checks, in both directions:
//
//   1. every registered tool name is in exactly one of INITIATIVE_READ_TOOLS /
//      INITIATIVE_LEDGER_TOOLS / INITIATIVE_CHAT_TOOLS / INITIATIVE_NEVER_TOOLS
//      (a new tool nobody classified fails here, and defaults to NEVER by hand);
//   2. every classified name is registered by some profile or host factory built here, or
//      named in NOT_COMPOSED with the reason (catches renames).
//
// Not covered: MCP tools (`mcp__<server>__<tool>`) are named by the operator's
// servers, not by this repo, so this census cannot list them. They are not in
// any class; the run registry (`buildReadOnlyRegistry`) registers only
// `runToolNames(...)`, so an MCP tool never reaches a run.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteGoalStore } from '@ethosagent/goal-store';
import {
  INITIATIVE_CHAT_TOOLS,
  INITIATIVE_LEDGER_TOOLS,
  INITIATIVE_NEVER_TOOLS,
  INITIATIVE_READ_TOOLS,
} from '@ethosagent/initiative-runner';
import { KanbanStore } from '@ethosagent/kanban-store';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { createSkillReadTool } from '@ethosagent/skill-evolver';
import { FsStorage } from '@ethosagent/storage-fs';
import { createA2aTools } from '@ethosagent/tools-a2a';
import { createBrowserTakeoverTool, createBrowserTools } from '@ethosagent/tools-browser';
import { createCronTool } from '@ethosagent/tools-cron';
import { buildDebugTools } from '@ethosagent/tools-debug';
import { createDecideTool } from '@ethosagent/tools-decision';
import { createGoalTools } from '@ethosagent/tools-goals';
import {
  createInitiativeChatTools,
  createInitiativeLedgerTools,
  createInitiativeRecallTools,
  createRunClarifyTool,
} from '@ethosagent/tools-initiatives';
import { createKanbanTools } from '@ethosagent/tools-kanban';
import { createTeamMemoryTools } from '@ethosagent/tools-memory';
import { buildDashboardTools, dashboardSaveTool } from '@ethosagent/tools-ui';
import { createWatcherTools } from '@ethosagent/tools-watchers';
import { compose as composeWorld } from '@ethosagent/tools-world/compose';
import type { InitiativeLedgerPort, Tool, WiringContext } from '@ethosagent/types';
import type { WorldToolPort } from '@ethosagent/world-service';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentLoop, type WiringConfig, type WiringProfile } from '../index';

/**
 * Classified names this census cannot construct, and why. Everything a host wires
 * from an in-process factory is built directly in `beforeAll` (see `buildHostWired`).
 */
const NOT_COMPOSED: Record<string, string> = {};

const PROFILES: WiringProfile[] = ['cli', 'tui', 'web', 'acp', 'mcp'];

const CLASSES: Record<string, ReadonlySet<string>> = {
  READ: new Set(INITIATIVE_READ_TOOLS),
  LEDGER: new Set(INITIATIVE_LEDGER_TOOLS),
  CHAT: new Set(INITIATIVE_CHAT_TOOLS),
  NEVER: INITIATIVE_NEVER_TOOLS,
};

function classesOf(name: string): string[] {
  return Object.entries(CLASSES)
    .filter(([, set]) => set.has(name))
    .map(([cls]) => cls);
}

/**
 * Build, with in-memory or temp-dir dependencies, every factory a host wires
 * outside `createAgentLoop`. Construction only closes over its dependency, so the
 * collaborators that are never called while listing tools (watcher manager, cron
 * scheduler, dashboard store, clarify bridge, decide fn, ledger port) are inert
 * `{}` stand-ins; the stores are real, over the temp dir.
 */
function buildHostWired(dataDir: string): { tools: Tool[]; close: () => void } {
  const storage = new FsStorage();
  const memory = new MarkdownFileMemoryProvider({ dir: join(dataDir, 'team'), storage });
  const session = new SQLiteSessionStore(join(dataDir, 'census-sessions.db'));
  const kanbanStore = new KanbanStore(join(dataDir, 'census-kanban.db'));
  const goalStore = new SQLiteGoalStore(join(dataDir, 'census-goals.db'));
  const inert = {} as never;
  const ledger = inert as InitiativeLedgerPort;
  const tools: Tool[] = [
    ...createWatcherTools(inert),
    ...createGoalTools(goalStore),
    ...createKanbanTools({ store: kanbanStore }),
    ...createCronTool(inert),
    ...createTeamMemoryTools(memory),
    ...buildDashboardTools(inert),
    dashboardSaveTool as Tool,
    ...buildDebugTools({ sessionStore: session }),
    createDecideTool({ decide: inert }),
    createSkillReadTool({ storage, skillsDirs: [join(dataDir, 'skills')] }) as Tool,
    createBrowserTakeoverTool(inert) as Tool,
    ...createInitiativeLedgerTools(ledger, 'INI-1'),
    createRunClarifyTool(ledger, 'INI-1'),
    ...createInitiativeRecallTools(inert, 'census'),
    ...createInitiativeChatTools({ config: inert, ideas: () => ledger, recall: inert }),
    // World tools exist only under `world.enabled`, which this census does not turn on; the ten
    // are built over an inert port (construction closes over it) so each name is classified.
    ...composeWorld(inert as WiringContext, { port: inert as WorldToolPort }).tools,
  ];
  return {
    tools,
    close: () => {
      for (const s of [session, kanbanStore, goalStore])
        (s as unknown as { close(): void }).close();
    },
  };
}

describe('initiative read-only census (L7)', () => {
  let home: string;
  const tools = new Map<string, Tool>();
  const prevEnv: Record<string, string | undefined> = {};
  let closeStores: () => void = () => undefined;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'ethos-initiative-census-'));
    const dataDir = join(home, '.ethos');
    mkdirSync(join(dataDir, 'personalities', 'open'), { recursive: true });
    writeFileSync(join(dataDir, 'personalities', 'open', 'config.yaml'), 'name: open\n');
    writeFileSync(join(dataDir, 'personalities', 'open', 'SOUL.md'), '# Core\nOpen.\n');
    writeFileSync(join(dataDir, 'personalities', 'open', 'toolset.yaml'), '- read_file\n');
    for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
    process.env.HOME = home;
    process.env.ETHOS_STATE_DIR = dataDir;
    const config: WiringConfig = {
      provider: 'ollama',
      model: 'offline-test',
      baseUrl: 'http://127.0.0.1:9',
      apiKey: 'sk-dummy',
      personality: 'open',
      memory: 'markdown',
    };
    for (const profile of PROFILES) {
      const runtime = await createAgentLoop(config, {
        dataDir,
        workingDir: home,
        disableDocker: true,
        profile,
      });
      try {
        for (const name of runtime.toolRegistry.toolNamesForPersonality({
          id: 'open',
          name: 'open',
        })) {
          const tool = runtime.toolRegistry.get(name);
          if (tool) tools.set(name, tool);
        }
      } finally {
        await runtime.dispose();
      }
    }
    const hostWired = buildHostWired(dataDir);
    closeStores = hostWired.close;
    for (const tool of [
      ...hostWired.tools,
      ...createBrowserTools({}),
      ...createA2aTools({} as Parameters<typeof createA2aTools>[0]),
    ]) {
      tools.set(tool.name, tool);
    }
  }, 240_000);

  afterAll(() => {
    closeStores();
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('composes a real registry (the census is not silently blind)', () => {
    expect(tools.size).toBeGreaterThan(40);
    expect(tools.has('terminal')).toBe(true);
    expect(tools.has('read_file')).toBe(true);
  });

  it('R2 every registered tool is classified', () => {
    const unclassified = [...tools.keys()].filter((n) => classesOf(n).length === 0).sort();
    expect(
      unclassified,
      'classify in extensions/initiative-runner/src/tool-classes.ts: NEVER by default; READ only for a genuine search/read tool',
    ).toEqual([]);
  });

  it('every classified name is in exactly one class', () => {
    const all = new Set([...Object.values(CLASSES).flatMap((s) => [...s])]);
    const multi = [...all].filter((n) => classesOf(n).length !== 1);
    expect(multi).toEqual([]);
  });

  it('every classified name exists', () => {
    const all = Object.values(CLASSES).flatMap((s) => [...s]);
    const unknown = all.filter((n) => !tools.has(n) && NOT_COMPOSED[n] === undefined).sort();
    expect(unknown).toEqual([]);
  });

  it('NOT_COMPOSED has no stale entries', () => {
    const stale = Object.keys(NOT_COMPOSED).filter(
      (n) => tools.has(n) || classesOf(n).length === 0,
    );
    expect(stale).toEqual([]);
  });
});

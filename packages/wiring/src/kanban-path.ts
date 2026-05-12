import { join } from 'node:path';

/**
 * Resolve the kanban DB path from wiring config + dataDir + active personality id.
 *
 * Precedence:
 *   1. Explicit `kanbanDbPath` (callers override everything)
 *   2. Team board (`${dataDir}/teams/<teamName>/board.db`) when `teamName` is set
 *   3. Per-personality solo board (`${dataDir}/personalities/<personalityId>/kanban.db`)
 *
 * Lives in its own file so tests can exercise it without pulling in the rest of
 * the wiring (PluginLoader, DockerSandbox, MCP, …).
 */
export function resolveKanbanDbPath(
  config: { kanbanDbPath?: string; teamName?: string },
  dataDir: string,
  personalityId: string,
): string {
  if (config.kanbanDbPath !== undefined) return config.kanbanDbPath;
  if (config.teamName !== undefined) {
    return join(dataDir, 'teams', config.teamName, 'board.db');
  }
  return join(dataDir, 'personalities', personalityId, 'kanban.db');
}

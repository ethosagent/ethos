import { join } from 'node:path';
import { isSafePathSegment } from '@ethosagent/storage-fs';

/**
 * Resolve the kanban DB path from wiring config + dataDir.
 *
 * Precedence:
 *   1. Explicit `kanbanDbPath` (callers override everything)
 *   2. Team board (`${dataDir}/teams/<teamName>/board.db`) when `teamName` is set
 *   3. Global board (`${dataDir}/board.db`)
 *
 * Lives in its own file so tests can exercise it without pulling in the rest of
 * the wiring (PluginLoader, DockerSandbox, MCP, …).
 */
export function resolveKanbanDbPath(
  config: { kanbanDbPath?: string; teamName?: string },
  dataDir: string,
): string {
  if (config.kanbanDbPath !== undefined) return config.kanbanDbPath;
  if (config.teamName !== undefined) {
    if (!isSafePathSegment(config.teamName)) {
      throw new Error(`Invalid team name for kanban path: ${config.teamName}`);
    }
    return join(dataDir, 'teams', config.teamName, 'board.db');
  }
  return join(dataDir, 'board.db');
}

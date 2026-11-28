import type { WorldToolPort } from '@ethosagent/world-service';
import type { ToolDef } from './common';
import { createReadTools } from './read-tools';

export const WORLD_TOOL_NAMES = [
  'world_query',
  'world_neighbours',
  'world_history',
  'world_assert',
  'world_close',
  'world_propose',
  'world_schema_change',
  'world_import',
  'world_export',
  'world_build',
] as const;

export type WorldToolName = (typeof WORLD_TOOL_NAMES)[number];

/** The `world_*` tools over one narrow port. Wiring builds the port; tools never see a provider. */
export function createWorldTools(port: WorldToolPort): ToolDef[] {
  return [...createReadTools(port)];
}

export { createReadTools };

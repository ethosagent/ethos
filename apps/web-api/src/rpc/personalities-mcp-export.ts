import { os } from './context';

// The MCP export section's read (M-T9, plan/phases/trust-before-reach.md
// Part 3). Split out of `personalities.ts` to keep each handler file thin.
// Mounted beside `personalitiesRouter` in `router.ts`. Bearer-reachable via `personalities:read`,
// so `PersonalitiesService.mcpExport` returns key prefixes, never a secret.

export const personalitiesMcpExportRouter = {
  mcpExport: os.personalities.mcpExport.handler(({ input, context }) =>
    context.personalities.mcpExport(input.id),
  ),
};

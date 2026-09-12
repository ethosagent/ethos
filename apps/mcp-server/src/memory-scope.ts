// Personality memory scope for the MCP surfaces.
//
// Personality memory lives at `~/.ethos/personalities/<id>/` — `resolveScopeDir`
// in `extensions/memory-markdown/src/index.ts` routes `personality:<id>` there
// and REJECTS a bare `memory` scope, which is what the memory tools used to
// pass. Every MCP memory call names the personality and goes through the
// provider, so the tools read the same bytes the agent does.

import type { MemoryContext } from '@ethosagent/types';
import { assertSafeId } from '@ethosagent/types';

/**
 * Build the memory context for one personality. Throws `IdValidationError`
 * (`assertSafeId`, @ethosagent/types) on an unsafe id, before any provider
 * sees it.
 */
export function personalityMemoryContext(personalityId: string): MemoryContext {
  assertSafeId(personalityId, 'personalityId');
  return {
    scopeId: `personality:${personalityId}`,
    sessionId: '',
    sessionKey: '',
    platform: 'mcp',
    workingDir: '',
  };
}

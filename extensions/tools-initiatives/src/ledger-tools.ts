import type { InitiativeLedgerPort, Tool } from '@ethosagent/types';

/** The ledger tools a run gets, minus `clarify` (run-local, `createRunClarifyTool`). */
const LEDGER_TOOL_NAMES = [
  'initiative_propose',
  'initiative_note',
  'initiative_brief',
  'initiative_ideas',
  'initiative_budget',
  'initiative_list',
  'initiative_search',
  'initiative_get',
] as const;

function stubTool(name: string, description: string): Tool {
  return {
    name,
    description,
    toolset: 'initiative',
    maxResultChars: 5000,
    capabilities: {},
    schema: { type: 'object', properties: {} },
    async execute() {
      return { ok: false, code: 'not_available', error: `${name} is not implemented yet` };
    },
  };
}

/**
 * Ledger tools bound to one initiative. Skeleton: every tool returns a
 * "not implemented yet" error until Task 4.3 fills them in.
 */
export function createInitiativeLedgerTools(
  _port: InitiativeLedgerPort,
  _initiativeId: string,
): Tool[] {
  return LEDGER_TOOL_NAMES.map((name) =>
    stubTool(name, `Initiative ledger tool ${name} (not implemented yet).`),
  );
}

/** Run-local `clarify`: records a question for the digest. Skeleton until Task 4.3. */
export function createRunClarifyTool(_port: InitiativeLedgerPort, _initiativeId: string): Tool {
  return stubTool('clarify', 'Record a question for the owner (not implemented yet).');
}

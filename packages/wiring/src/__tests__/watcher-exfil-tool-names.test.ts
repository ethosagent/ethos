// Drift gate for the watcher's suspicious-sequence rule (`EXFIL_TOOL_NAMES`
// in packages/safety/watcher/src/rules.ts).
//
// The list used to name `web_post`, `web_put`, `web_delete` and `email_send`.
// No tool registers any of them, so a credential read followed by a real
// outbound call (`web_extract`, `send_message`, `a2a_send`, …) never tripped
// the rule — it could only fire on `browser_type`. This gate builds the REAL
// tool definitions and checks the list against them in both directions:
//
//   1. every listed name is registered by a real factory (catches renames and
//      removals, and a list of names nothing registers);
//   2. every tool declaring `network.allowedHosts: ['*']` — a destination the
//      agent chooses — is either listed or exempted below with a reason
//      (catches a NEW agent-directed network tool nobody classified).
//
// Tests live in wiring because only this layer imports the tools-* packages;
// safety-watcher deliberately depends on nothing but types.
//
// On failure: a renamed/removed tool → update EXFIL_TOOL_NAMES. A new '*' tool
// → add it to EXFIL_TOOL_NAMES if it can carry agent-chosen content off the
// host, otherwise add it to EXEMPT_WILDCARD_TOOLS with the reason.

import { EXFIL_TOOL_NAMES, isExfilShapedTool } from '@ethosagent/safety-watcher';
import { createA2aTools } from '@ethosagent/tools-a2a';
import { createEngineAskTool } from '@ethosagent/tools-answer-engines';
import { createBrowserTools } from '@ethosagent/tools-browser';
import { createDelegationTools } from '@ethosagent/tools-delegation';
import { createImageTools } from '@ethosagent/tools-image';
import { createMeetingTools } from '@ethosagent/tools-meeting';
import { createMessagingTools } from '@ethosagent/tools-messaging';
import { createRedditSearchTool, createRedditThreadTool } from '@ethosagent/tools-reddit';
import { createVideoAnalyzeTool, createVisionTools } from '@ethosagent/tools-vision';
import { createVoiceTools } from '@ethosagent/tools-voice';
import { createWebTools } from '@ethosagent/tools-web';
import { createXSearchTool } from '@ethosagent/tools-x-search';
import type { Tool } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';

// The factories below only read their dependencies inside `execute()`, never
// at construction, so an empty stand-in is enough to read names and
// capabilities.
type Deps<F extends (...args: never[]) => unknown> = Parameters<F>[0];
const unused = <T>(): T => ({}) as T;

function realTools(): Tool[] {
  return [
    ...createWebTools(),
    ...createBrowserTools({}),
    ...createA2aTools(unused<Deps<typeof createA2aTools>>()),
    ...createDelegationTools(
      unused<Deps<typeof createDelegationTools>>(),
      unused<Parameters<typeof createDelegationTools>[1]>(),
    ),
    ...createMessagingTools({ send: async () => ({ ok: true }) } as Deps<
      typeof createMessagingTools
    >),
    ...createImageTools(),
    ...createMeetingTools(),
    ...createVoiceTools(),
    ...createVisionTools(unused<Deps<typeof createVisionTools>>()),
    createVideoAnalyzeTool(unused<Deps<typeof createVideoAnalyzeTool>>()),
    createXSearchTool(),
    createEngineAskTool(),
    createRedditSearchTool(),
    createRedditThreadTool(),
  ];
}

/** Wildcard-network tools that carry no agent-chosen content off the host. */
const EXEMPT_WILDCARD_TOOLS: Record<string, string> = {
  browser_click: 'acts on the page already loaded; carries no agent text',
  browser_vision_click: 'acts on the page already loaded; carries no agent text',
  browser_press: 'presses a key on the page already loaded; the text was typed earlier',
  browser_scroll: 'acts on the page already loaded',
  browser_back: 'history navigation on the page already loaded',
  browser_console: 'reads the page already loaded',
  browser_get_images: 'reads the page already loaded',
  browser_dialog: 'answers a dialog on the page already loaded',
  browser_screenshot: 'takes no arguments; captures the page already loaded',
  browser_fill_credential: 'the value comes from the vault, origin-bound, never from the agent',
  delegate_task: 'spawns an in-process sub-agent; sends nothing off the host itself',
  mixture_of_agents: 'fans out to in-process models; sends nothing to an agent-chosen host',
  list_team: 'reads the local mesh registry; sends nothing',
};

describe('watcher suspicious-sequence rule — exfil tool names drift gate', () => {
  const tools = realTools();
  const registered = new Set(tools.map((t) => t.name));

  it('every name in EXFIL_TOOL_NAMES is the name of a real registered tool', () => {
    const missing = [...EXFIL_TOOL_NAMES].filter((name) => !registered.has(name));
    expect(
      missing,
      `EXFIL_TOOL_NAMES lists tools no factory registers: ${missing.join(', ')}. Update packages/safety/watcher/src/rules.ts.`,
    ).toEqual([]);
  });

  it("every allowedHosts ['*'] tool is classified: exfil-shaped or exempt with a reason", () => {
    const wildcard = tools.filter((t) => t.capabilities?.network?.allowedHosts.includes('*'));
    // The gate must be looking at something; an empty list would pass vacuously.
    expect(wildcard.length).toBeGreaterThan(10);
    const unclassified = wildcard
      .map((t) => t.name)
      .filter((name) => !isExfilShapedTool(name) && !(name in EXEMPT_WILDCARD_TOOLS));
    expect(
      unclassified,
      `Agent-directed network tools the watcher does not classify: ${unclassified.join(', ')}`,
    ).toEqual([]);
  });

  it('no exempt entry is also listed, and every exempt entry is a real tool', () => {
    for (const name of Object.keys(EXEMPT_WILDCARD_TOOLS)) {
      expect(registered.has(name), `${name} is exempted but not registered`).toBe(true);
      expect(isExfilShapedTool(name), `${name} is both exempt and exfil-shaped`).toBe(false);
    }
  });
});

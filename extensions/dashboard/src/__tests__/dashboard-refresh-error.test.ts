// A prompt panel's refresh whose turn ends in an `error` event (a provider
// failure, or SETUP_REQUIRED before onboarding has a loop) used to write the
// empty streamed text into the panel — wiping the last good content — and
// clear its error. The previous content now stays, and the error is recorded.

import type { AgentLoop } from '@ethosagent/core';
import type { AgentEvent } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { refreshSinglePanel } from '../dashboard-refresh';
import type { DashboardPanel } from '../dashboards.service';

function promptPanel(): DashboardPanel {
  return {
    id: 'p1',
    dashboardId: 'd1',
    queryType: 'prompt',
    blockType: 'markdown',
    prompt: 'summarise',
    sqlQuery: null,
    pluginId: null,
    dataSourceId: null,
    htmlTemplate: null,
    paramDefaults: {},
    dependsOn: null,
    cronSchedule: null,
    lastRunAt: null,
  } as unknown as DashboardPanel;
}

describe('refreshSinglePanel — an errored turn', () => {
  it('keeps the panel content and records the error', async () => {
    const writes: string[] = [];
    const loop = {
      async *run(): AsyncGenerator<AgentEvent> {
        yield {
          type: 'error',
          error: 'Setup required — complete onboarding first.',
          code: 'SETUP_REQUIRED',
        };
      },
    } as unknown as AgentLoop;

    await refreshSinglePanel(promptPanel(), {
      agentLoop: loop,
      dashboards: {
        get: () => ({ dashboard: { personalityId: 'p', paramsCurrent: {} }, panels: [] }),
        updatePanelContent: (_id, text) => writes.push(`content:${text}`),
        setPanelError: (_id, error) => writes.push(`error:${error}`),
        clearPanelError: () => writes.push('clear'),
        updatePanelParamDefaults: () => {},
      },
    });

    expect(writes).toEqual(['error:Setup required — complete onboarding first.']);
  });
});

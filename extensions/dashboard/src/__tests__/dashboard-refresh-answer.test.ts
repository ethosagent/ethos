// A prompt panel's content is the turn's WHOLE answer. A `returnDirect` tool's
// answer reaches the turn only as `done.text` — after any preamble the model
// streamed before calling it — so collecting `text_delta` alone wrote the
// preamble (or nothing) into the panel. `answerSuffix` (@ethosagent/types) is
// what the stream still owes.

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

async function contentFor(events: AgentEvent[]): Promise<string | undefined> {
  let content: string | undefined;
  const loop = {
    async *run(): AsyncGenerator<AgentEvent> {
      for (const e of events) yield e;
    },
  } as unknown as AgentLoop;
  await refreshSinglePanel(promptPanel(), {
    agentLoop: loop,
    dashboards: {
      get: () => ({ dashboard: { personalityId: 'p', paramsCurrent: {} }, panels: [] }),
      updatePanelContent: (_id, text) => {
        content = text;
      },
      setPanelError: () => {},
      clearPanelError: () => {},
      updatePanelParamDefaults: () => {},
    },
  });
  return content;
}

describe('refreshSinglePanel — the panel gets the whole answer', () => {
  it('a returnDirect answer with nothing streamed', async () => {
    expect(await contentFor([{ type: 'done', text: 'DIRECT ANSWER', turnCount: 1 }])).toBe(
      'DIRECT ANSWER',
    );
  });

  it('a returnDirect answer after a streamed preamble: both, in order', async () => {
    expect(
      await contentFor([
        { type: 'text_delta', text: 'Let me look that up.' },
        { type: 'done', text: 'DIRECT ANSWER', turnCount: 1 },
      ]),
    ).toBe('Let me look that up.\n\nDIRECT ANSWER');
  });

  it('a normal turn is unchanged — done.text is what streamed', async () => {
    expect(
      await contentFor([
        { type: 'text_delta', text: 'the answer' },
        { type: 'done', text: 'the answer', turnCount: 1 },
      ]),
    ).toBe('the answer');
  });
});

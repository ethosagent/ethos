import {
  INITIATIVE_SETTINGS_FIELD_KEYS,
  type InitiativesSettingsOutputSchema,
} from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { initiativeSettingsKeys } from '../../../features/initiative-settings/api/keys';
import { InitiativesTab } from '../InitiativesTab';

// Task 6.3 — the Personality → Initiatives tab. Static markup, like the other
// personality-editor tests: `apps/web` has no interaction harness here, and the
// claims are about what the tab shows for a given server answer.

type SettingsResponse = z.infer<typeof InitiativesSettingsOutputSchema>;

const DEFAULTS: SettingsResponse['settings'] = {
  enabled: true,
  selfStart: false,
  dailyBudgetUsd: 0,
  standingGuidance: [],
};

function response(over: Partial<SettingsResponse> = {}): SettingsResponse {
  return {
    settings: DEFAULTS,
    status: 'loaded',
    ceilings: {},
    guidance: [],
    ...over,
  };
}

function markup(data: SettingsResponse): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(initiativeSettingsKeys.personality('researcher'), data);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        AntApp,
        null,
        createElement(MemoryRouter, null, createElement(InitiativesTab, { id: 'researcher' })),
      ),
    ),
  );
}

function controlKeys(html: string): string[] {
  return [...html.matchAll(/data-initiative-key="([^"]+)"/g)].map((m) => m[1] ?? '');
}

describe('Personality Initiatives tab', () => {
  it('defaults when settings file is missing', () => {
    const html = markup(response({ status: 'missing' }));
    // Not an empty tab: every always-visible control is there, with its default.
    for (const key of ['enabled', 'selfStart', 'dailyBudgetUsd', 'defaultAutonomy.mode']) {
      expect(controlKeys(html), key).toContain(key);
    }
    expect(html).toContain('Takes initiatives');
    expect(html).toContain('Can start its own initiatives');
    expect(html).toMatch(/aria-label="Takes initiatives"[^>]*aria-checked="true"/);
    expect(html).toMatch(/aria-label="Can start its own initiatives"[^>]*aria-checked="false"/);
    expect(html).toContain('No settings file yet');
    // The owner-channel control exists even though delivery is unset.
    expect(controlKeys(html)).toContain('delivery.ownerChannel');
  });

  it('guidance line shows tool or unreachable', () => {
    const html = markup(
      response({
        settings: {
          ...DEFAULTS,
          standingGuidance: ['watch the kanban board', 'read my slack', 'delete the repo'],
        },
        guidance: [
          {
            text: 'watch the kanban board',
            status: 'mapped',
            mapsTo: ['kanban_list', 'kanban_get'],
          },
          { text: 'read my slack', status: 'unreachable', mapsTo: [] },
          { text: 'delete the repo', status: 'refused', mapsTo: [] },
        ],
      }),
    );
    expect(html).toContain('kanban_list, kanban_get');
    expect(html).toContain('unreachable');
    expect(html).toContain('refused');
  });

  it('every settings.yaml key has a Personality control', () => {
    const html = markup(
      response({
        settings: {
          ...DEFAULTS,
          defaultAutonomy: { mode: 'free_under', askAboveUsd: 1 },
          delivery: { ownerChannel: 'telegram:1', digestTime: '08:00' },
          standingGuidance: ['a line'],
        },
      }),
    );
    const rendered = new Set(controlKeys(html));
    for (const key of INITIATIVE_SETTINGS_FIELD_KEYS) {
      expect(rendered.has(key), `no Personality control for settings.yaml key ${key}`).toBe(true);
    }
  });

  it('hides the ask-above amount unless the mode is free_under', () => {
    const html = markup(response({ settings: { ...DEFAULTS, defaultAutonomy: { mode: 'ask' } } }));
    expect(controlKeys(html)).not.toContain('defaultAutonomy.askAboveUsd');
  });

  it('shows the operator ceilings read-only with a link to Settings', () => {
    const html = markup(response({ ceilings: { maxUsdPerDayPerPersonality: 2, maxUsdPerDay: 5 } }));
    expect(html).toContain('$2');
    expect(html).toContain('$5');
    expect(html).toContain('href="/settings/automation/initiatives"');
  });
});

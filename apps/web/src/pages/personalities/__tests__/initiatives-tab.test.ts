import {
  INITIATIVE_SETTINGS_FIELD_KEYS,
  type InitiativeMetricsOutputSchema,
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
import { initiativesKeys } from '../../../features/initiatives/api/keys';
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

type MetricsResponse = z.infer<typeof InitiativeMetricsOutputSchema>;

function metrics(over: Partial<MetricsResponse> = {}): MetricsResponse {
  return {
    since: '2026-11-01T00:00:00.000Z',
    gate1: { asked: 0, approved: 0, rate: 0 },
    gate2: { briefs: 0, adopted: 0, rate: 0 },
    selfStart: { started: 0, kept: 0, stopped: 0 },
    ...over,
  };
}

function markup(data: SettingsResponse, m?: MetricsResponse): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(initiativeSettingsKeys.personality('researcher'), data);
  if (m) queryClient.setQueryData(initiativesKeys.metrics('researcher'), m);
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

  it('digest time says it is in the notifications timezone, not "local"', () => {
    const html = markup(response({ settings: { ...DEFAULTS } }));
    expect(html).toContain('notifications timezone');
    expect(html).not.toContain('Local time of day');
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

  it('tab shows gate 1 and gate 2 rates', () => {
    const html = markup(
      response(),
      metrics({
        gate1: { asked: 8, approved: 6, rate: 0.75 },
        gate2: { briefs: 4, adopted: 1, rate: 0.25 },
      }),
    );
    expect(html).toContain('data-initiative-metrics');
    expect(html).toMatch(/Gate 1: 6 of 8 approved \(75%\)/);
    expect(html).toMatch(/Gate 2: 1 of 4 adopted \(25%\)/);
  });

  it('metrics block shows an empty state when nothing was asked', () => {
    const html = markup(response(), metrics());
    expect(html).toContain('data-initiative-metrics');
    expect(html).toContain('Nothing asked yet');
    expect(html).not.toContain('NaN');
  });
});

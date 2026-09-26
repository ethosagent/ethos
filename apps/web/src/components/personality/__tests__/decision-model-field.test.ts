// Edit → Config › Decision model (plan decision-provider-personality §9, PD9,
// PD10): `DecisionModelField` and its pure half, ./decisionModel.
//
// What the field promises: the select lists the decision models the operator
// ADDED (plus None, plus a stored value the machine lacks); with none added it
// is disabled and links to Settings → Models; the three site controls stay
// disabled until a model is chosen; every note is the server's resolution
// (`Personality.decisions.resolved`), shown only while its row shows what is
// saved; and the save patch writes only what changed.
//
// `renderToStaticMarkup` (apps/web has no DOM), with `decisions.list` seeded
// into the query cache and a MemoryRouter for the Settings link.

import type {
  DecisionProviderView,
  DecisionsListResult,
  Personality,
} from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ConfigEditor } from '../../../pages/Personalities';
import { decisionKeys } from '../../../pages/settings/lib/decision-models';
import { DecisionModelField } from '../DecisionModelField';
import {
  type DecisionFieldValue,
  decisionFieldValue,
  decisionProviderOptions,
  decisionSiteNote,
  decisionsUpdateInput,
} from '../decisionModel';

const JEV: DecisionProviderView = {
  id: 'typesafe',
  label: 'Jev',
  vendor: 'TypeSafe',
  configured: true,
  keyRef: 'providers/typesafe/apiKey',
  keyPresent: true,
  keyPreview: '…6789',
  model: 'jev-latest',
  baseUrl: 'https://api.typesafe.ai',
  host: 'api.typesafe.ai',
  getKeyUrl: 'https://console.typesafe.ai',
  usedBy: [],
};

const LIST: DecisionsListResult = { catalog: [], providers: [JEV] };

type Stored = Personality['decisions'];

/** A saved block: Jev, injection on (R6-downgraded), approver shadow (inert under manual). */
const SAVED: Stored = {
  provider: 'typesafe',
  sites: { injection: 'on', approver: 'shadow' },
  resolved: {
    configured: true,
    apiKeyPresent: true,
    sites: [
      {
        site: 'injection',
        requested: 'on',
        effective: 'shadow',
        reason: 'threshold-missing',
        missingThresholds: ['decisions.thresholds.injection'],
      },
      {
        site: 'approver',
        requested: 'shadow',
        effective: 'shadow',
        missingThresholds: [],
        inertApprovalMode: 'manual',
      },
      {
        site: 'router',
        requested: 'off',
        effective: 'off',
        reason: 'undeclared',
        missingThresholds: [],
      },
    ],
  },
};

function markup(
  value: DecisionFieldValue,
  stored: Stored,
  opts: { list?: DecisionsListResult; approvalMode?: 'manual' | 'smart' | 'off' } = {},
): string {
  const client = new QueryClient();
  client.setQueryData(decisionKeys.list(), opts.list ?? LIST);
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        QueryClientProvider,
        { client },
        createElement(DecisionModelField, {
          value,
          stored,
          approvalMode: opts.approvalMode ?? 'manual',
          onChange: () => {},
        }),
      ),
    ),
  );
}

/** Visible text, tags stripped. */
function text(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
}

/** The markup of one site row. */
function row(html: string, site: string): string {
  const start = html.indexOf(`data-site="${site}"`);
  expect(start, `no row ${site}`).toBeGreaterThan(-1);
  const next = html.indexOf('data-site="', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

describe('the field', () => {
  it('renders the select and three site rows with off · shadow · on and one-line help', () => {
    const html = markup(decisionFieldValue(SAVED), SAVED);
    const t = text(html);
    expect(t).toContain('Decision model');
    expect(html).toContain('aria-label="Decision model"');
    expect(t).toContain('Jev · TypeSafe');
    for (const [site, label, help] of [
      [
        'injection',
        'Injection check',
        'Asks whether a tool result is trying to instruct the agent.',
      ],
      ['approver', 'Tool approvals', 'Asks whether a flagged tool call runs, is refused'],
      ['router', 'Model routing', 'Asks whether a message needs only the trivial model.'],
    ] as const) {
      const r = text(row(html, site));
      expect(r).toContain(label);
      expect(r).toContain(help);
      expect(r).toMatch(/off.*shadow.*on/);
    }
  });

  it('disables every site control while no decision model is chosen (PD10)', () => {
    const html = markup(decisionFieldValue(undefined), undefined);
    for (const site of ['injection', 'approver', 'router']) {
      expect(row(html, site)).toContain('ant-segmented-disabled');
    }
    const chosen = markup({ ...decisionFieldValue(undefined), provider: 'typesafe' }, undefined);
    for (const site of ['injection', 'approver', 'router']) {
      expect(row(chosen, site)).not.toContain('ant-segmented-disabled');
    }
  });

  it('with no decision model added: disabled select and a link to Settings → Models', () => {
    const html = markup(decisionFieldValue(undefined), undefined, {
      list: { catalog: [], providers: [] },
    });
    expect(text(html)).toContain('No decision models yet. Add one in Settings → Models');
    expect(html).toContain('href="/settings/models"');
    expect(html).toContain('ant-select-disabled');
  });

  it('options: None, the added models, and a stored value the machine lacks — never dropped', () => {
    expect(decisionProviderOptions([JEV], undefined)).toEqual([
      { value: '', label: 'None' },
      { value: 'typesafe', label: 'Jev · TypeSafe' },
    ]);
    expect(decisionProviderOptions([], 'typesafe')).toEqual([
      { value: '', label: 'None' },
      { value: 'typesafe', label: 'typesafe (not configured on this machine)' },
    ]);
  });
});

describe('notes — the server resolution, while the row shows what is saved', () => {
  it('shows the R6 downgrade and the inert approver on the saved rows', () => {
    const html = markup(decisionFieldValue(SAVED), SAVED);
    expect(text(row(html, 'injection'))).toContain(
      'on requested, running shadow: decisions.thresholds.injection missing',
    );
    expect(text(row(html, 'approver'))).toContain(
      'Inert: approval mode is manual; the approver runs only when Approval mode is Smart.',
    );
    expect(row(html, 'router')).not.toContain('decision-site-note');
  });

  it('hides a note once the row is changed and not yet saved', () => {
    const value = decisionFieldValue(SAVED);
    value.sites.injection = 'shadow';
    expect(
      decisionSiteNote({ site: 'injection', value, stored: SAVED, approvalMode: 'manual' }),
    ).toBeNull();
  });

  it('hides the inert-approver note once this form’s approval mode is Smart', () => {
    const value = decisionFieldValue(SAVED);
    expect(
      decisionSiteNote({ site: 'approver', value, stored: SAVED, approvalMode: 'smart' }),
    ).toBeNull();
  });

  it('says so when the saved model is not configured on this machine', () => {
    const stored: Stored = {
      provider: 'typesafe',
      sites: { injection: 'shadow' },
      resolved: {
        configured: false,
        sites: [
          {
            site: 'injection',
            requested: 'shadow',
            effective: 'off',
            reason: 'not-configured',
            missingThresholds: [],
          },
        ],
      },
    };
    const t = text(
      markup(decisionFieldValue(stored), stored, { list: { catalog: [], providers: [] } }),
    );
    expect(t).toContain('Not configured on this machine — every site runs off.');
    expect(t).toContain('typesafe (not configured on this machine)');
  });

  it('says so when the saved model has no key', () => {
    const stored: Stored = {
      ...SAVED,
      resolved: { configured: true, apiKeyPresent: false, sites: SAVED?.resolved?.sites ?? [] },
    };
    expect(text(markup(decisionFieldValue(stored), stored))).toContain(
      'No key stored — every site takes today’s path',
    );
  });
});

describe('the save patch', () => {
  it('a first choice sends the provider and only the sites turned on', () => {
    const value: DecisionFieldValue = {
      provider: 'typesafe',
      sites: { injection: 'shadow', approver: 'off', router: 'off' },
    };
    expect(decisionsUpdateInput(value, undefined)).toEqual({
      provider: 'typesafe',
      sites: { injection: 'shadow' },
    });
  });

  it('an edit sends only the changed site, turning one off explicitly', () => {
    const value = decisionFieldValue(SAVED);
    value.sites.approver = 'off';
    expect(decisionsUpdateInput(value, SAVED)).toEqual({ sites: { approver: 'off' } });
  });

  it('None clears the provider and leaves the stored sites', () => {
    const value = { ...decisionFieldValue(SAVED), provider: '' };
    expect(decisionsUpdateInput(value, SAVED)).toEqual({ provider: '' });
  });

  it('keeps a stored provider this machine does not know rather than sending it', () => {
    const stored: Stored = { provider: 'elsewhere', sites: {} };
    const value = decisionFieldValue(stored);
    value.sites.router = 'shadow';
    expect(decisionsUpdateInput(value, stored)).toEqual({ sites: { router: 'shadow' } });
  });
});

describe('placement (PD9)', () => {
  it('ConfigEditor renders the field directly under Model', () => {
    const client = new QueryClient();
    client.setQueryData(decisionKeys.list(), LIST);
    const personality: Personality = {
      id: 'agent',
      name: 'Agent',
      description: null,
      model: null,
      provider: null,
      toolset: [],
      capabilities: null,
      streamingTimeoutMs: null,
      mcp_servers: null,
      plugins: null,
      fs_reach: null,
      decisions: SAVED,
      system: false,
      builtin: false,
      version: 1,
    };
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(
          QueryClientProvider,
          { client },
          createElement(AntApp, null, createElement(ConfigEditor, { id: 'agent', personality })),
        ),
      ),
    );
    const t = text(html);
    const model = t.indexOf(' Model ');
    const decision = t.indexOf('Decision model');
    const memory = t.indexOf('Memory scope');
    expect(model).toBeGreaterThan(-1);
    expect(decision).toBeGreaterThan(model);
    expect(memory).toBeGreaterThan(decision);
  });
});

// Shared links in the settings index and rail (share-links review F3), and a
// guard that collapsing the three "New API key" rows left them unchanged.

import { describe, expect, it } from 'vitest';
import { SETTINGS_INDEX } from '../lib/settings-index';
import { SETTINGS_CATEGORIES } from '../lib/taxonomy';

const inSection = (section: string) =>
  SETTINGS_INDEX.filter((e) => e.category === 'security' && e.section === section);

describe('Shared links is registered', () => {
  it('has a rail section right after API keys', () => {
    const security = SETTINGS_CATEGORIES.find((c) => c.slug === 'security');
    const slugs = security?.sections.map((s) => s.slug) ?? [];
    expect(slugs.indexOf('shared-links')).toBe(slugs.indexOf('api-keys') + 1);
    expect(security?.sections.find((s) => s.slug === 'shared-links')?.label).toBe('shared links');
  });

  it('has one self-saving, state-backed table entry that is not a config key', () => {
    expect(inSection('shared-links')).toEqual([
      {
        key: null,
        formName: null,
        label: 'Shared links table',
        category: 'security',
        section: 'shared-links',
        advanced: false,
        saves: 'self',
        status: null,
        stateBacked: true,
        keyUnresolved: 'Share-link store (rpc.shares.list/revoke), not a config.yaml key.',
      },
    ]);
  });
});

describe('API key rows are unchanged', () => {
  it('keeps the table row and the three create-modal fields, in order', () => {
    const base = { key: null, category: 'security', section: 'api-keys', advanced: false };
    const field = (kind: string) =>
      `${kind} of the create-key modal form; writes to the API-key store, not config.yaml.`;
    expect(inSection('api-keys')).toEqual([
      {
        ...base,
        formName: null,
        label: 'API keys table',
        saves: 'self',
        status: null,
        stateBacked: true,
        keyUnresolved: 'API-key store (rpc.apiKeys.list/create/revoke), not a config.yaml key.',
      },
      {
        ...base,
        formName: 'name',
        label: 'New API key — Name',
        saves: 'self',
        status: null,
        keyUnresolved: field('Field'),
      },
      {
        ...base,
        formName: 'scopes',
        label: 'New API key — Scopes',
        saves: 'self',
        status: null,
        keyUnresolved: field('Field'),
      },
      {
        ...base,
        formName: 'origins',
        label: 'New API key — Allowed Origins',
        saves: 'self',
        status: null,
        keyUnresolved: field('Form.List field'),
      },
    ]);
  });
});

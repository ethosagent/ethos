import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, Form } from 'antd';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { SettingsView } from '../../components/world/SettingsView';
import { configGetFixture } from '../settings/__tests__/config-get-fixture';
import { SETTINGS_INDEX } from '../settings/lib/settings-index';
import type { SettingsPaneContext } from '../settings/pane-context';
import { MemoryPane } from '../settings/panes/memory';

// Plan world-model Task 7.3b. Every key the world model added to config has a
// labeled control in the home the plan gives it, and nothing but that home
// counts: not the personality Config tab, not Show file, not the CLI.

const SRC = join(import.meta.dirname, '..', '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const WORLD_KEYS = [
  ['world.enabled', 'World'],
  ['world.contextMaxChars', 'Context characters'],
  ['world.contextHops', 'Context hops'],
  ['world.extraction', 'Extraction'],
  ['world.proposals.cap', 'Proposal cap'],
  ['world.proposals.ttlDays', 'Proposal TTL'],
] as const;

function noop() {}

function Harness({ owner }: { owner: boolean }) {
  const [form] = Form.useForm();
  const context: SettingsPaneContext = {
    form,
    config: owner ? configGetFixture() : undefined,
    personalities: [],
    personalitiesLoading: false,
    quickCommandRows: [],
    setQuickCommandRows: noop,
    channelToolsetRows: [],
    setChannelToolsetRows: noop,
    voiceTtsProviderRows: [],
    setVoiceTtsProviderRows: noop,
    voiceSttProviderRows: [],
    setVoiceSttProviderRows: noop,
    voiceRealtimeProviderRows: [],
    setVoiceRealtimeProviderRows: noop,
    retentionRows: [],
    setRetentionRows: noop,
    voiceBotRows: [],
    setVoiceBotRows: noop,
  };
  return createElement(
    Form,
    { form, layout: 'vertical', component: false },
    createElement(Outlet, { context }),
  );
}

function memoryPane(owner: boolean): string {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(
        AntApp,
        null,
        createElement(
          MemoryRouter,
          { initialEntries: ['/'] },
          createElement(
            Routes,
            null,
            createElement(
              Route,
              { element: createElement(Harness, { owner }) },
              createElement(Route, { path: '/', element: createElement(MemoryPane) }),
            ),
          ),
        ),
      ),
    ),
  );
}

describe('world config controls', () => {
  it('every world config key has a control', () => {
    // 1. config.yaml world.*: Settings > Memory > World, six self-saving rows.
    const html = memoryPane(true);
    expect(html).toContain('id="world"');
    const world = html.slice(html.indexOf('id="world"'));
    for (const [key, label] of WORLD_KEYS) {
      const row = SETTINGS_INDEX.find((e) => e.key === key);
      expect(row, key).toMatchObject({
        category: 'memory',
        section: 'world',
        saves: 'self',
        stateBacked: true,
        formName: null,
        label,
      });
      expect(world, `${key} control`).toContain(`aria-label="${label}"`);
      expect(world, `${key} named`).toContain(key);
    }
    expect(SETTINGS_INDEX.filter((e) => e.key?.startsWith('world.'))).toHaveLength(
      WORLD_KEYS.length,
    );

    // 2. world.yaml: the World page settings view. title/audience/readers/proposers
    // are editable; id and backend are shown and read-only.
    const view = renderToStaticMarkup(
      createElement(SettingsView, {
        config: {
          id: 'acme',
          backend: 'sqlite',
          title: 'Acme',
          audience: 'shareable',
          readers: ['ops'],
          proposers: [],
        },
        saving: false,
        error: null,
        onSave: noop,
      }),
    );
    for (const label of ['Title', 'Audience', 'Readers', 'Proposers']) {
      expect(view, label).toContain(`aria-label="${label}"`);
    }
    expect(view).toMatch(/aria-label="World id"[^>]*readOnly|readOnly[^>]*aria-label="World id"/);
    expect(view).toMatch(/aria-label="Backend"[^>]*readOnly|readOnly[^>]*aria-label="Backend"/);
    expect(view).not.toContain('<textarea');

    // 3. worlds.yaml mounts: the Worlds tab, and only there.
    expect(read('pages/personalities/EditModal.tsx')).toMatch(/key: 'worlds',[\s\S]*?<WorldsTab/);
    expect(read('pages/personalities/WorldsTab.tsx')).toContain('rpc.worlds.mountsSave');
  });

  it('is not satisfied by the personality Config tab', () => {
    const config = read('pages/personalities/ConfigEditor.tsx');
    expect(config).not.toMatch(/worlds?\.|mounts|worlds\.yaml/i);
  });

  it('a non-owner does not see the Settings section', () => {
    const html = memoryPane(false);
    expect(html).not.toContain('id="world"');
    expect(html).not.toContain('world.enabled');
  });
});

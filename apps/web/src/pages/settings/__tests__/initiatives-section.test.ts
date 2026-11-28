import { CONSTITUTION_INITIATIVES_FIELD_KEYS } from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { initiativeSettingsKeys } from '../../../features/initiative-settings/api/keys';
import { INITIATIVES_SETTINGS_ENTRIES } from '../lib/settings-index-initiatives';
import { InitiativesSection, isNonOwnerError, refusesSsh } from '../panes/automation-initiatives';

// Task 6.3b — Settings → Automation → Initiatives. Static markup, same technique
// as `settings-self-save-markers.test.ts`: the claims are about what the section
// renders for a given server answer.

function client(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function markup(queryClient: QueryClient): string {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(AntApp, null, createElement(InitiativesSection)),
    ),
  );
}

function seeded(initiatives: object): QueryClient {
  const queryClient = client();
  queryClient.setQueryData(initiativeSettingsKeys.constitution(), { initiatives });
  return queryClient;
}

describe('Settings Initiatives section', () => {
  it('every constitution initiatives key has a Settings control', () => {
    const html = markup(seeded({ readableRoots: ['/data/notes'] }));
    expect(html).toContain('id="initiatives"');
    for (const key of CONSTITUTION_INITIATIVES_FIELD_KEYS) {
      expect(html, `no Settings control for constitution key ${key}`).toContain(
        `data-initiative-key="${key}"`,
      );
    }
    // The index carries the same set, one row per control.
    expect(INITIATIVES_SETTINGS_ENTRIES.map((e) => e.key?.split('.').pop()).sort()).toEqual(
      [...CONSTITUTION_INITIATIVES_FIELD_KEYS].sort(),
    );
  });

  it('shows the defaults for keys the block does not set', () => {
    const html = markup(seeded({}));
    expect(html).toMatch(/aria-label="Initiatives enabled"[^>]*aria-checked="true"/);
    expect(html).toContain('value="0.50"');
    expect(html).toContain(
      'Limits apply at the next window; the rest of the constitution still needs a restart.',
    );
  });

  it('hidden for non-owner', () => {
    expect(isNonOwnerError(Object.assign(new Error('no'), { code: 'FORBIDDEN' }))).toBe(true);
    expect(isNonOwnerError(Object.assign(new Error('no'), { code: 'UNAUTHORIZED' }))).toBe(true);
    expect(isNonOwnerError(Object.assign(new Error('boom'), { code: 'UNKNOWN' }))).toBe(false);
    expect(isNonOwnerError(null)).toBe(false);

    const queryClient = client();
    queryClient
      .getQueryCache()
      .build(queryClient, { queryKey: initiativeSettingsKeys.constitution() })
      .setState({
        status: 'error',
        error: Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' }),
        fetchStatus: 'idle',
      });
    const html = markup(queryClient);
    expect(html).not.toContain('settings-section-heading');
    expect(html).not.toContain('data-initiative-key');
  });

  it('renders nothing before the answer arrives', () => {
    expect(markup(client())).not.toContain('settings-section-heading');
  });

  it('hints that ~/.ssh is refused before the server says so', () => {
    expect(refusesSsh('~/.ssh')).toBe(true);
    expect(refusesSsh('/home/me/.ssh/keys')).toBe(true);
    expect(refusesSsh('/home/me/work/../.ssh')).toBe(true);
    expect(refusesSsh('/home/me/work')).toBe(false);
  });
});

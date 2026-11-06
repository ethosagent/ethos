import type { CatalogListEntry } from '@ethosagent/web-contracts';

// Pure formatter for the one-line "what will this touch" summary under a
// catalog row (plan/phases/unified-catalog.md §5.3). Pinned by
// __tests__/capability-line.test.ts. No DOM, no React.

const AUTH_LABEL: Record<CatalogListEntry['capabilities']['auth'], string> = {
  oauth: 'OAuth',
  none: 'no auth',
  bearer: 'API key',
  env: 'env key',
};

const FILES_LABEL: Record<CatalogListEntry['capabilities']['filesystem'], string> = {
  none: 'no files',
  'user-path': 'your path',
  'own-state': 'own state',
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function pinLabel(pin: CatalogListEntry['pin']): string {
  switch (pin.type) {
    case 'remote':
      return hostOf(pin.url);
    case 'npm':
    case 'pypi':
      return `${pin.type} ${pin.package}@${pin.version}`;
    case 'git':
      return `git ${pin.repo}@${pin.commit.slice(0, 7)}`;
  }
}

export function capabilityLine(entry: CatalogListEntry): string {
  const { pin, capabilities: c } = entry;
  const parts = [pinLabel(pin)];
  // A remote's auth is the headline (OAuth / API key); a local entry mentions
  // auth only when it needs one, so keyless local servers stay terse.
  if (pin.type === 'remote' || c.auth !== 'none') parts.push(AUTH_LABEL[c.auth]);
  if (c.toolCount !== undefined)
    parts.push(`${c.toolCount} ${c.toolCount === 1 ? 'tool' : 'tools'}`);
  parts.push(FILES_LABEL[c.filesystem]);
  if (c.shell) parts.push('runs shell');
  return parts.join(' · ');
}

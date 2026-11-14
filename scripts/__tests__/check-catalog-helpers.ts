import type { CatalogEntry } from '@ethosagent/types';
import { expect, vi } from 'vitest';
import { checkEntry, type GitTreeResult, type PackedPackage, type Runner } from '../check-catalog';

export const NOW = new Date('2026-11-05T00:00:00Z');
export const SRI = `sha512-${'A'.repeat(86)}==`;
export const OTHER_SRI = `sha512-${'B'.repeat(86)}==`;
export const SHA = 'a'.repeat(64);

export const base = {
  description: 'd',
  category: 'Utilities',
  publisher: 'Acme',
  tier: 'verified',
  reviewedAt: '2026-11-05',
} as const;

export function npmEntry(over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    ...base,
    id: 'thing',
    kind: 'mcp',
    name: 'Thing',
    pin: { type: 'npm', package: '@acme/thing', version: '1.2.3', integrity: SRI },
    capabilities: { network: [], auth: 'none', env: [], filesystem: 'none', shell: false },
    license: 'MIT',
    mcp: { argsAfterSpec: [], argVars: [], envVars: [] },
    ...over,
  };
}

export function remoteEntry(over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    ...base,
    id: 'svc',
    kind: 'mcp',
    name: 'Svc',
    pin: { type: 'remote', url: 'https://mcp.svc.test/mcp', transport: 'streamable-http' },
    capabilities: {
      network: ['mcp.svc.test'],
      auth: 'oauth',
      env: [],
      filesystem: 'none',
      shell: false,
    },
    license: null,
    ...over,
  };
}

export const CLEAN_PACK: PackedPackage = {
  integrity: SRI,
  pkgJson: { name: '@acme/thing' },
  sources: [{ path: 'dist/index.js', content: 'export const x = 1;\n' }],
};

export const CLEAN_TREE: GitTreeResult = {
  outcome: 'ok',
  detail: 'fetched; digest matches',
  skillMd: {
    path: 'SKILL.md',
    content: '---\nname: pdf\ndescription: PDFs\n---\n\n# PDF\n\nExtract text.\n',
  },
  sources: [],
  license: 'Permission is hereby granted, free of charge, to any person obtaining a copy',
};

/** `npm view <spec> dist.integrity license --json` prints one object for two fields. */
export const npmView =
  (over: { integrity?: string; license?: string } = {}) =>
  async (args: string[]) => {
    expect(args).toEqual(['view', '@acme/thing@1.2.3', 'dist.integrity', 'license', '--json']);
    return JSON.stringify({
      'dist.integrity': over.integrity ?? SRI,
      license: over.license ?? 'MIT',
    });
  };

/** A runner whose every call succeeds with the clean answer; tests override one seam. */
export function runner(over: Partial<Runner> = {}): Runner {
  return {
    npm: vi.fn(npmView()),
    git: vi.fn(async () => ''),
    gitTree: vi.fn(async () => CLEAN_TREE),
    fetch: vi.fn(async () => new Response('{}', { status: 200 })),
    osv: vi.fn(async () => ({ safe: true, advisories: [] })),
    packNpm: vi.fn(async () => CLEAN_PACK),
    now: () => NOW,
    ...over,
  };
}

export const status = async (e: CatalogEntry, r: Runner, check: string) =>
  (await checkEntry(e, r)).results.find((c) => c.check === check)?.status;

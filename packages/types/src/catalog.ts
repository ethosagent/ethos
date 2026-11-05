// The unified catalog's entry contract (plan/phases/unified-catalog.md §4.3).
// Pure types plus three `as const` vocabularies. The data lives in
// `@ethosagent/catalog`; the wire schema is `CatalogEntrySchema` in
// `@ethosagent/web-contracts`, pinned equal to this file by
// `packages/web-contracts/src/__tests__/catalog-schema-drift.test.ts`.

export const CATALOG_KINDS = ['mcp', 'plugin', 'skill'] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];

/**
 * Review tier: who vouches for the entry. A review claim, NOT the scanner's
 * `TrustTier` (safety-scanner), and it never relaxes `canInstall` (D5).
 */
export const CATALOG_TIERS = ['official', 'verified', 'community'] as const;
export type CatalogTier = (typeof CATALOG_TIERS)[number];

export const CATALOG_PIN_TYPES = ['remote', 'npm', 'pypi', 'git'] as const;
export type CatalogPinType = (typeof CATALOG_PIN_TYPES)[number];

export type CatalogPin =
  /** A hosted service: no code is fetched. */
  | { type: 'remote'; url: string; transport: 'streamable-http' }
  /** `integrity` is the npm `dist.integrity` (sha512 SRI). */
  | { type: 'npm'; package: string; version: string; integrity: string }
  /** `integrity` is `sha256-<hex>` of the `py3-none-any` wheel. */
  | { type: 'pypi'; package: string; version: string; integrity: string }
  /** Phase 3: a commit plus Ethos's own digest of the fetched tree. */
  | { type: 'git'; repo: string; commit: string; subdir?: string; contentDigest: string };

export interface CatalogCapabilities {
  /** Hosts the entry talks to. ['*'] = any (e.g. fetch). [] = none. */
  network: string[];
  auth: 'none' | 'oauth' | 'bearer' | 'env';
  /** Env vars / credentials it reads (names only). */
  env: string[];
  filesystem: 'none' | 'user-path' | 'own-state';
  shell: boolean;
  /** From a tools/list handshake; absent when none was run or it needs auth to list. */
  toolCount?: number;
}

export interface CatalogEntry {
  /** Unique across kinds; a slug. Equals the MCP preset name for kind 'mcp'. */
  id: string;
  kind: CatalogKind;
  /** Display label (the remote presets' `label`). */
  name: string;
  description: string;
  /** One of the existing category labels for the kind (D8). */
  category: string;
  /** e.g. 'Linear', 'Model Context Protocol', 'cocal (community)'. */
  publisher: string;
  tier: CatalogTier;
  pin: CatalogPin;
  capabilities: CatalogCapabilities;
  /** SPDX expression; null only for a remote service (D6). */
  license: string | null;
  /** The remote presets' `docsUrl`. */
  homepage?: string;
  /** ISO date of the last human review / pin check. */
  reviewedAt: string;
  /** Kind 'mcp', npm/pypi pins only. */
  mcp?: { argsAfterSpec: string[]; argVars: string[]; envVars: string[] };
  /** Kind 'plugin'. */
  plugin?: { pluginId: string };
  /** Kind 'skill'. */
  skill?: { skillName: string };
}

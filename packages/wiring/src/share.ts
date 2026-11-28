// Share-links passthrough for apps (plan share-links A2, B2; ARCHITECTURE.md Law 5):
// the SQLite store and the redacted snapshot builder, so web-api and the CLI reach both
// through wiring. `MAX_SNAPSHOT_BYTES` is the one snapshot cap; the store enforces it and
// `shareSnapshotBytes` measures against it.

import { join } from 'node:path';

export {
  AmbiguousSharePrefixError,
  type CreateShareLinkInput,
  type CreateShareLinkResult,
  hashShareToken,
  MAX_SNAPSHOT_BYTES,
  MIN_PREFIX_LENGTH,
  type ShareLinkEvent,
  type ShareLinkEventKind,
  type ShareLinkKind,
  type ShareLinkRecord,
  type ShareLinkStoreOptions,
  type ShareLinkSummary,
  SharePrefixTooShortError,
  SnapshotTooLargeError,
  SqliteShareLinkStore,
} from '@ethosagent/share-links';
export {
  previewShare,
  publishShare,
  resolveShareBaseUrl,
  type ShareBaseUrl,
  type ShareExpiry,
  type SharePreviewResult,
  type SharePublishDeps,
  type SharePublishInput,
  type SharePublishResult,
  type ShareRefusal,
} from './share-publish';
export {
  buildShareSnapshot,
  type ShareSnapshot,
  type ShareSnapshotMessage,
  type ShareSnapshotOptions,
  type ShareSnapshotSession,
  type ShareSnapshotTool,
  type ShareSnapshotTurn,
  shareSnapshotBytes,
} from './share-snapshot';

/**
 * The share-link database path: `<dataDir>/share-links.db`, beside the
 * `sessions.db` that holds the API-key store (`join(ethosDir(), 'sessions.db')`
 * in apps/ethos/src/commands/boot.ts and api-key.ts). The file name is the one
 * denied by STATE_DIR_DENY_ENTRIES (packages/storage-fs/src/sensitive-paths.ts),
 * listed in backup ALWAYS_EXCLUDED (packages/wiring/src/backup/scopes.ts) and
 * write-blocked by BLOCKED_WRITE_PATHS (extensions/tools-file/src/index.ts).
 */
export function shareLinksDbPath(dataDir: string): string {
  return join(dataDir, 'share-links.db');
}

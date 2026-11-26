import type {
  ShareCreateOutput,
  ShareLinkSummaryWire,
  SharePreviewOutput,
  ShareRevokeOutput,
} from '@ethosagent/web-contracts';
import {
  AmbiguousSharePrefixError,
  MAX_SNAPSHOT_BYTES,
  previewShare,
  publishShare,
  resolveShareBaseUrl,
  type ShareBaseUrl,
  SharePrefixTooShortError,
  type SharePublishDeps,
  SnapshotTooLargeError,
  type SqliteShareLinkStore,
} from '@ethosagent/wiring';
import type { ActorReader } from './actor';
import type { ShareSettings, ShareSettingsReader } from './settings';

// Operator-side share-link service (plan share-links §3 Service, D4, D9, D11, D12, D13, D15).
// The refusal ladder (disabled, not_found, shared_session, excluded_personality, empty,
// too_large) and the URL-base rule live in @ethosagent/wiring `previewShare` /
// `publishShare` / `resolveShareBaseUrl`; this class only supplies live settings, the
// audit actor and the bind address, and maps results onto the web-contracts shapes.
// Guarantees, each pinned by ../../__tests__/services/share-service.test.ts:
// - refusals are returned, not thrown, and match ShareRefusalSchema;
// - the actor recorded on `created` / `revoked` events is `web:<admin>` ('actor');
// - the URL base is `webBaseUrl` else the bind address, never a request Host ('url base');
// - `list` rows carry no token, url or snapshot ('list never exposes token or snapshot').

/** Where `ethos serve` listens. `port` is set after the listener binds (it may walk forward). */
export interface ShareLinksHost {
  store: SqliteShareLinkStore;
  bind: { host: string; port: number };
}

export interface ShareServiceDeps {
  /** Absent in onboarding mode (no config yet): every write is refused as `disabled`. */
  host: ShareLinksHost | null;
  sessions: SharePublishDeps['sessions'];
  settings: ShareSettingsReader;
  actor: ActorReader;
  /** `createWebApi({ webBaseUrl })`, used when config.yaml no longer names one. */
  webBaseUrl?: string;
  now?: () => Date;
}

export class ShareService {
  constructor(private readonly deps: ShareServiceDeps) {}

  async preview(input: {
    sessionId: string;
    includeToolNames: boolean;
    pii: boolean;
  }): Promise<SharePreviewOutput> {
    const settings = await this.deps.settings();
    const publishDeps = this.publishDeps(settings);
    if (!publishDeps) return { ok: false, reason: 'disabled' };
    return previewShare(publishDeps, input);
  }

  async create(input: {
    sessionId: string;
    expiresIn: '1h' | '1d' | '7d' | '30d';
    includeToolNames: boolean;
    pii: boolean;
  }): Promise<ShareCreateOutput> {
    // One settings read per call: `enabled` and `webBaseUrl` come from the same snapshot.
    const settings = await this.deps.settings();
    const publishDeps = this.publishDeps(settings);
    if (!publishDeps) return { ok: false, reason: 'disabled' };
    try {
      return await publishShare(publishDeps, {
        ...input,
        actor: await this.deps.actor(),
        baseUrl: this.baseUrl(settings),
      });
    } catch (err) {
      // publishShare measures the same cap first; this is the store's own backstop.
      if (err instanceof SnapshotTooLargeError) {
        return { ok: false, reason: 'too_large', limitBytes: MAX_SNAPSHOT_BYTES };
      }
      throw err;
    }
  }

  async list(input: {
    activeOnly?: boolean;
  }): Promise<{ enabled: boolean; links: ShareLinkSummaryWire[] }> {
    const { enabled } = await this.deps.settings();
    const store = this.deps.host?.store;
    if (!store) return { enabled: false, links: [] };
    const rows = store.list({ activeOnly: input.activeOnly ?? true });
    return {
      enabled,
      // Field by field: a new store column never reaches the wire by accident.
      links: rows.map((r) => ({
        id: r.id,
        prefix: r.prefix,
        sessionId: r.sessionId,
        title: r.title,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        viewCount: r.viewCount,
        lastViewedAt: r.lastViewedAt,
        revokedAt: r.revokedAt,
      })),
    };
  }

  /** Allowed while the feature is off: the operator must always be able to kill a link. */
  async revoke(input: { id: string }): Promise<ShareRevokeOutput> {
    const store = this.deps.host?.store;
    if (!store) return { ok: false, reason: 'not_found' };
    try {
      const revoked = store.revoke(input.id, await this.deps.actor());
      return revoked ? { ok: true } : { ok: false, reason: 'not_found' };
    } catch (err) {
      if (err instanceof AmbiguousSharePrefixError)
        return { ok: false, reason: 'ambiguous_prefix' };
      if (err instanceof SharePrefixTooShortError) return { ok: false, reason: 'prefix_too_short' };
      throw err;
    }
  }

  private publishDeps(settings: ShareSettings): SharePublishDeps | null {
    const host = this.deps.host;
    if (!host) return null;
    const { enabled, excludePersonalities } = settings;
    return {
      store: host.store,
      shareLinks: { enabled, excludePersonalities },
      sessions: this.deps.sessions,
      now: this.deps.now ?? (() => new Date()),
    };
  }

  // Wildcard binds are mapped to "this machine" inside resolveShareBaseUrl (D4).
  private baseUrl({ webBaseUrl }: ShareSettings): ShareBaseUrl {
    const configured = webBaseUrl ?? this.deps.webBaseUrl;
    const { host, port } = this.deps.host?.bind ?? { host: '127.0.0.1', port: 0 };
    return resolveShareBaseUrl({
      ...(configured ? { webBaseUrl: configured } : {}),
      bindHost: host,
      port,
    });
  }
}

import type { Hono } from 'hono';

/**
 * A protocol module (e.g. A2A, Phase 3) contributes its own Hono sub-router to
 * the web-api app via an EXPLICIT, REVIEWABLE typed list on `createWebApi`
 * (NOT plugin auto-discovery — plan §12). Each entry declares its mount path,
 * its auth posture, and a human-readable description, so a reviewer can audit
 * the whole seam at a glance: what path, gated how, for what.
 *
 * Isolation (plan §12 blast-radius mitigation): every module mounts under its
 * OWN `basePath` with its OWN declared `auth` — a module NEVER shares another
 * route's auth (A2A does not ride `/rpc`'s auth). `enabled: false` is the
 * per-module kill switch: a disabled module is not mounted at all, so a
 * misbehaving module can be isolated without touching the rest of the app.
 * Modules inherit the app-wide CORS + error-envelope middleware but bring
 * their own auth posture.
 */
export interface RouteModule {
  /** Mount path, e.g. `/a2a`. The router's routes are relative to this prefix. */
  basePath: string;
  /** The sub-router. Its routes are relative to `basePath`. */
  router: Hono;
  /**
   * Declared auth posture (reviewable):
   * - `public` — no auth middleware; the module owns its own access control
   *   (e.g. an A2A `/a2a-auth` handshake).
   * - `bearer` — reuses the main API's cookie-OR-bearer middleware (the same
   *   posture as `/rpc/*`).
   * - `cookie` — reuses the cookie-only auth middleware.
   */
  auth: 'public' | 'bearer' | 'cookie';
  /** Human-readable purpose, surfaced for reviewability. */
  description: string;
  /** Kill switch. Defaults to true; when false the module is NOT mounted. */
  enabled?: boolean;
  /**
   * Live per-request gate — when present and it returns false, the module's
   * routes 404 as if unmounted. Distinct from `enabled?` (mount-time static).
   * Lets a feature be toggled at runtime without a restart.
   */
  enabledCheck?: () => boolean;
}

/**
 * Runtime control surface for a live-toggleable protocol module (A2A). The
 * route modules + the outbound tool consult `isEnabled`; `setEnabled` flips the
 * live state and persists it. Threaded through {@link RouteModule.enabledCheck}
 * and consumed by the RPC layer so a UI toggle and the live `/a2a` handshake
 * stay one source of truth.
 */
export interface A2aControl {
  /** Current live state — the same predicate wired into `enabledCheck`. */
  isEnabled: () => boolean;
  /** Flip A2A on/off at runtime and persist the new state to config. */
  setEnabled: (enabled: boolean) => Promise<void>;
}

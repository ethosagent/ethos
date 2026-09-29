// Pure logic for the auth gate and the /welcome (claim) + /welcome/reset
// screens — plan/phases/web-auth-bootstrap.md Phase 2. Kept free of React and
// the DOM so mode selection, the ?t= scrub, the error-code mapping and the
// form → endpoint mapping are unit-testable (apps/web has no DOM test infra;
// the app-level behavior pins here, in __tests__/auth-flow.test.ts).

/** Mirrors MIN_PASSWORD_LENGTH in apps/web-api/src/routes/auth.ts. */
export const MIN_PASSWORD_LENGTH = 12;

export const AUTH_ENDPOINTS = {
  state: '/auth/state',
  login: '/auth/login',
  'token-login': '/auth/token-login',
  setup: '/auth/setup',
  reset: '/auth/reset',
} as const;

export type AuthFormKind = Exclude<keyof typeof AUTH_ENDPOINTS, 'state'>;

/** Same base resolution as sse.ts: VITE_API_URL in split-dev, else relative
 *  (the Vite proxy and production single-origin serve both handle it). */
function authApiBase(): string {
  return import.meta.env.VITE_API_URL ?? '';
}

// ---------------------------------------------------------------------------
// Gate mode (plan D9/D16) — which screen the full-page gate shows.
// ---------------------------------------------------------------------------

/** What the gate's live `/auth/state` poll last learned. */
export type AuthProbe = { claimed: boolean } | 'unreachable' | null;

export type GateMode = 'login' | 'token' | 'reconnecting' | 'checking';

/**
 * D9's two-mode lock screen, decided from the transport signals plus the
 * gate's own live probe. The invariants the tests pin:
 *
 *   - A 401 never renders "reconnecting" — a 401 IS a response, so the
 *     backend is reachable; the user gets the credential form for the
 *     instance's state (claimed → login, unclaimed → token paste).
 *   - An unreachable backend never renders credential fields — entering a
 *     password into a dead backend can't succeed, so it shows the
 *     reconnecting panel until the probe answers again.
 *   - The probe outranks the remembered `unreachable` flag: if the backend
 *     died AFTER the 401, the live probe says so and reconnecting is shown;
 *     once the probe answers, the credential form returns.
 */
export function resolveGateMode(opts: {
  unauthorized: boolean;
  unreachable: boolean;
  probe: AuthProbe;
}): GateMode {
  if (opts.probe === 'unreachable') return 'reconnecting';
  if (opts.unauthorized) {
    if (opts.probe === null) return 'checking';
    return opts.probe.claimed ? 'login' : 'token';
  }
  if (opts.unreachable) return 'reconnecting';
  // Gate rendered with no active signal — a transient frame while the
  // bridge state settles. Show the neutral spinner, never a wrong form.
  return 'checking';
}

// ---------------------------------------------------------------------------
// ?t= prefill + scrub (plan D7) — the token PREFILLS, then leaves the URL.
// ---------------------------------------------------------------------------

/**
 * Pull the `t` param out of a search string. The caller feeds
 * `scrubbedSearch` to `history.replaceState` so the token never survives in
 * the address bar or browser history; every other param is preserved.
 */
export function extractPrefillToken(search: string): {
  token: string | null;
  scrubbedSearch: string;
} {
  const params = new URLSearchParams(search);
  const token = params.get('t');
  if (token === null) return { token: null, scrubbedSearch: search };
  params.delete('t');
  const rest = params.toString();
  return { token, scrubbedSearch: rest ? `?${rest}` : '' };
}

// ---------------------------------------------------------------------------
// Error surfacing — named messages per refusal code (plan D14, mockup ②).
// ---------------------------------------------------------------------------

export function parseRetryAfterHeader(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export function authErrorMessage(
  kind: AuthFormKind,
  status: number,
  code: string | null,
  retryAfterSeconds: number | null,
): string {
  if (status === 429) {
    return retryAfterSeconds !== null
      ? `Too many attempts. Try again in ${retryAfterSeconds}s.`
      : 'Too many attempts. Try again in a few minutes.';
  }
  switch (code) {
    case 'PASSWORD_TOO_SHORT':
      return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    case 'TOKEN_LOGIN_RETIRED':
      return 'This instance now uses username & password sign-in.';
    case 'ALREADY_CLAIMED':
      return 'This instance already has an admin account. Sign in with username and password, or reset via /welcome/reset.';
    case 'NOT_CLAIMED':
      return 'This instance has no admin account yet. Sign in with the token, or set one up at /welcome.';
    case 'INVALID_INPUT':
      return 'Username is required.';
    default:
      break;
  }
  if (status === 401) {
    if (kind === 'login') return 'Wrong username or password.';
    if (kind === 'token-login') return 'Invalid token. Use the web token from your deployment.';
    return 'Invalid bootstrap token. Use the token from your deployment.';
  }
  return `Request failed (${status}).`;
}

// ---------------------------------------------------------------------------
// The auth POSTs + the unauthenticated state read. Plain fetch, NOT the
// gate-aware rpc fetch: a wrong password on the login form is a form error,
// not a new "session died" signal.
// ---------------------------------------------------------------------------

export interface AuthRefusal {
  readonly ok: false;
  readonly status: number;
  readonly code: string | null;
  readonly message: string;
  readonly retryAfterSeconds: number | null;
}

export type AuthPostResult = { readonly ok: true } | AuthRefusal;

export async function postAuth(
  kind: AuthFormKind,
  body: Record<string, string>,
  fetchFn: typeof fetch = fetch,
): Promise<AuthPostResult> {
  let res: Response;
  try {
    res = await fetchFn(`${authApiBase()}${AUTH_ENDPOINTS[kind]}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return {
      ok: false,
      status: 0,
      code: null,
      message: "The server isn't answering. Check the connection and try again.",
      retryAfterSeconds: null,
    };
  }
  if (res.ok) return { ok: true };
  let code: string | null = null;
  try {
    const parsed = (await res.json()) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'code' in parsed &&
      typeof (parsed as { code: unknown }).code === 'string'
    ) {
      code = (parsed as { code: string }).code;
    }
  } catch {
    // Non-JSON refusal (a proxy error page) — the status alone maps it.
  }
  const retryAfterSeconds = parseRetryAfterHeader(res.headers.get('Retry-After'));
  return {
    ok: false,
    status: res.status,
    code,
    message: authErrorMessage(kind, res.status, code, retryAfterSeconds),
    retryAfterSeconds,
  };
}

export type AuthStateResult = { claimed: boolean; tokenFromEnv: boolean } | 'unreachable';

/** D8's one unauthenticated, secret-free endpoint. */
export async function fetchAuthState(fetchFn: typeof fetch = fetch): Promise<AuthStateResult> {
  let res: Response;
  try {
    res = await fetchFn(`${authApiBase()}${AUTH_ENDPOINTS.state}`, { credentials: 'include' });
  } catch {
    return 'unreachable';
  }
  if (!res.ok) return 'unreachable';
  try {
    const body = (await res.json()) as { claimed?: unknown; tokenFromEnv?: unknown };
    return { claimed: body.claimed === true, tokenFromEnv: body.tokenFromEnv === true };
  } catch {
    return 'unreachable';
  }
}

// ---------------------------------------------------------------------------
// Settings → Security & access → access section (plan D18). Mode selection is
// pure — claimed/unclaimed/tokenFromEnv decide the copy and the navigation
// target — so the section's whole behavior pins here without a DOM.
// ---------------------------------------------------------------------------

export type AccessSectionView =
  | {
      /** Claimed (D18): reset is discoverable here, gated by the token (D6). */
      kind: 'claimed';
      statusLine: string;
      tokenLine: string;
      action: { label: string; target: '/welcome/reset' };
      /** Glyph + word per DESIGN.md — never color alone. */
      warningLine: string;
    }
  | {
      /** Unclaimed (D16): token access is the steady state; claiming is opt-in. */
      kind: 'unclaimed';
      statusLine: string;
      tokenLine: string;
      action: { label: string; target: '/welcome' };
      warningLine: null;
    }
  | { kind: 'unavailable'; statusLine: string; tokenLine: null; action: null; warningLine: null };

export function resolveAccessSection(state: AuthStateResult): AccessSectionView {
  if (state === 'unreachable') {
    return {
      kind: 'unavailable',
      statusLine: 'Could not read the auth state from the server.',
      tokenLine: null,
      action: null,
      warningLine: null,
    };
  }
  const tokenLine = state.tokenFromEnv
    ? 'Bootstrap token: managed by your deployment (ETHOS_WEB_TOKEN).'
    : 'Bootstrap token: the generated file in the state directory.';
  if (state.claimed) {
    return {
      kind: 'claimed',
      statusLine: 'Username & password sign-in is set up for this instance.',
      tokenLine,
      action: { label: 'Reset credentials…', target: '/welcome/reset' },
      warningLine: '⚠ Requires the bootstrap token. Signs out every active session.',
    };
  }
  return {
    kind: 'unclaimed',
    statusLine: 'Token access is active — this instance has no admin account yet.',
    tokenLine,
    action: { label: 'Set up username & password', target: '/welcome' },
    warningLine: null,
  };
}

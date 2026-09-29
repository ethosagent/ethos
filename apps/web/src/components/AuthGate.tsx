import { useQueryClient } from '@tanstack/react-query';
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Link } from 'react-router-dom';
import {
  clearUnauthorized,
  getAuthBridgeState,
  reportAuthNetworkError,
  reportAuthResponse,
  subscribeAuthBridge,
} from '../lib/auth/auth-bridge';
import { type AuthProbe, fetchAuthState, postAuth, resolveGateMode } from '../lib/auth/auth-flow';
import { AuthError, AuthField, AuthScreen, AuthWordmark } from './auth/AuthShell';

// The full-page auth gate (web-auth-bootstrap Phase 2, D9/D16). Wraps the app
// shell: while no signal is up it renders children untouched; on a 401 it
// swaps the whole app for the lock screen (claimed instance → username +
// password, unclaimed → token paste + the one claim link), and while the
// backend is unreachable it shows the reconnecting panel with no credential
// fields. The transport signals come from the auth-bridge (fed by rpc.ts's
// gate-aware fetch); the claimed/unclaimed split comes from the gate's own
// `/auth/state` poll, which also drives auto-resume when connectivity
// returns.

const POLL_MS = 5_000;

export function AuthGate({ children }: { children: ReactNode }) {
  const { unauthorized, unreachable } = useSyncExternalStore(
    subscribeAuthBridge,
    getAuthBridgeState,
  );
  const gated = unauthorized || unreachable;
  const [probe, setProbe] = useState<AuthProbe>(null);
  const [lastAttemptAt, setLastAttemptAt] = useState<number | null>(null);
  const qc = useQueryClient();

  // While gated, poll /auth/state: it answers claimed vs unclaimed for the
  // form choice, and it is the liveness probe the reconnecting panel resumes
  // from. Reporting the outcome back to the bridge is what auto-lifts an
  // unreachable-only gate (a success clears `unreachable`); a 401 gate stays
  // until a credential POST succeeds.
  useEffect(() => {
    if (!gated) {
      setProbe(null);
      setLastAttemptAt(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const state = await fetchAuthState();
      if (cancelled) return;
      setLastAttemptAt(Date.now());
      if (state === 'unreachable') {
        setProbe('unreachable');
        reportAuthNetworkError();
      } else {
        setProbe({ claimed: state.claimed });
        reportAuthResponse(200);
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [gated]);

  // Whatever lifted the gate (login, token paste, connectivity back), the
  // app's queries were failing while it was down — refetch everything.
  const wasGated = useRef(false);
  useEffect(() => {
    if (wasGated.current && !gated) void qc.invalidateQueries();
    wasGated.current = gated;
  }, [gated, qc]);

  const onSignedIn = useCallback(() => {
    clearUnauthorized();
    void qc.invalidateQueries();
  }, [qc]);

  if (!gated) return <>{children}</>;

  const mode = resolveGateMode({ unauthorized, unreachable, probe });
  return (
    <AuthScreen>
      {mode === 'login' && <LoginForm onSignedIn={onSignedIn} />}
      {mode === 'token' && (
        <TokenLoginForm onSignedIn={onSignedIn} onClaimed={() => setProbe({ claimed: true })} />
      )}
      {mode === 'reconnecting' && <ReconnectingPanel lastAttemptAt={lastAttemptAt} />}
      {mode === 'checking' && <CheckingPanel />}
    </AuthScreen>
  );
}

/** ② The claimed lock screen — username + password only. Deliberately a dead
 *  end: no reset link, no links at all (plan D5). */
function LoginForm({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await postAuth('login', { username, password });
    setPending(false);
    if (result.ok) {
      onSignedIn();
      return;
    }
    setError(result.message);
  };

  return (
    <>
      <AuthWordmark />
      <h3 className="auth-title">Sign in</h3>
      <form className="auth-form" onSubmit={(e) => void submit(e)}>
        <AuthField id="gate-username" label="Username">
          <input
            id="gate-username"
            className="auth-input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
        </AuthField>
        <AuthField id="gate-password" label="Password">
          <input
            id="gate-password"
            className="auth-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </AuthField>
        <AuthError message={error} />
        <button type="submit" className="auth-btn" disabled={pending}>
          Sign in
        </button>
      </form>
    </>
  );
}

/** ①-alt The pre-claim lock screen (D16) — paste the web token, or opt into
 *  an account via the one /welcome link. */
function TokenLoginForm({
  onSignedIn,
  onClaimed,
}: {
  onSignedIn: () => void;
  onClaimed: () => void;
}) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await postAuth('token-login', { token });
    setPending(false);
    if (result.ok) {
      onSignedIn();
      return;
    }
    setError(result.message);
    // The instance was claimed since the probe answered — flip to login.
    if (result.code === 'TOKEN_LOGIN_RETIRED') onClaimed();
  };

  return (
    <>
      <AuthWordmark />
      <h3 className="auth-title">Sign in with token</h3>
      <p className="auth-sub">
        This instance uses token access. Paste the web token from your deployment.
      </p>
      <form className="auth-form" onSubmit={(e) => void submit(e)}>
        <AuthField id="gate-token" label="Web token">
          <input
            id="gate-token"
            className="auth-input auth-input--mono"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="paste token"
            autoComplete="off"
          />
        </AuthField>
        <AuthError message={error} />
        <button type="submit" className="auth-btn" disabled={pending}>
          Sign in
        </button>
      </form>
      <p className="auth-foot">
        Prefer a username &amp; password?{' '}
        <Link className="auth-link" to="/welcome">
          Set up an account
        </Link>{' '}
        — you'll need this token once to claim the instance.
      </p>
    </>
  );
}

/** ③ Backend unreachable — same shell, no credential fields (they couldn't
 *  succeed); resumes by itself when the probe answers. */
function ReconnectingPanel({ lastAttemptAt }: { lastAttemptAt: number | null }) {
  const seconds = useSecondsSince(lastAttemptAt);
  return (
    <>
      <AuthWordmark />
      <h3 className="auth-title">Reconnecting…</h3>
      <div className="auth-statusrow" role="status">
        <div className="auth-spinner" aria-hidden="true" />
        <span>
          The server isn't answering. Retrying —{' '}
          <span className="auth-mono">
            {seconds === null ? 'trying now' : `last attempt ${seconds}s ago`}
          </span>
        </span>
      </div>
      <p className="auth-foot">You'll land back where you were once it responds.</p>
    </>
  );
}

/** The one-probe-in-flight frame after a 401, before claimed/unclaimed is
 *  known — a neutral spinner, never a possibly-wrong form. */
function CheckingPanel() {
  return (
    <>
      <AuthWordmark />
      <div className="auth-statusrow" role="status">
        <div className="auth-spinner" aria-hidden="true" />
        <span>Checking access…</span>
      </div>
    </>
  );
}

function useSecondsSince(ts: number | null): number | null {
  const [seconds, setSeconds] = useState<number | null>(null);
  useEffect(() => {
    if (ts === null) {
      setSeconds(null);
      return;
    }
    const tick = () => setSeconds(Math.max(0, Math.round((Date.now() - ts) / 1000)));
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, [ts]);
  return seconds;
}

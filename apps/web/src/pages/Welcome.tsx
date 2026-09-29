import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AuthError,
  AuthField,
  AuthScreen,
  AuthWordmark,
  usePrefillToken,
} from '../components/auth/AuthShell';
import { clearUnauthorized } from '../lib/auth/auth-bridge';
import { fetchAuthState, MIN_PASSWORD_LENGTH, postAuth } from '../lib/auth/auth-flow';

// ① The claim wizard (web-auth-bootstrap D1, mockup ①): bootstrap token +
// choose username & password → POST /auth/setup → session cookie → into the
// app (config onboarding takes over if the instance is unconfigured). A
// `?t=` deep-link prefills the token and is scrubbed from the address bar
// (D7). On an already-claimed instance the form never renders — a short
// state links to /welcome/reset instead.

export function Welcome() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [claimed, setClaimed] = useState<boolean | null>(null);
  const [token, setToken] = useState('');
  const [prefilled, setPrefilled] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchAuthState().then((state) => {
      if (!cancelled && state !== 'unreachable') setClaimed(state.claimed);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  usePrefillToken(setToken, setPrefilled);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    setPending(true);
    setError(null);
    const result = await postAuth('setup', { token, username, password });
    setPending(false);
    if (result.ok) {
      clearUnauthorized();
      void qc.invalidateQueries();
      navigate('/', { replace: true });
      return;
    }
    if (result.code === 'ALREADY_CLAIMED') setClaimed(true);
    setError(result.message);
  };

  if (claimed) {
    return (
      <AuthScreen>
        <AuthWordmark context="set up access" />
        <h3 className="auth-title">Already claimed</h3>
        <p className="auth-sub">
          This instance already has an admin account. Sign in with username and password.
        </p>
        <p className="auth-foot">
          <Link className="auth-link" to="/">
            Go to sign in
          </Link>{' '}
          · Forgot the credentials?{' '}
          <Link className="auth-link" to="/welcome/reset">
            Reset with the bootstrap token
          </Link>
        </p>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen>
      <AuthWordmark context="set up access" />
      <h3 className="auth-title">Claim this instance</h3>
      <p className="auth-sub">
        Prove you deployed it, then create the account you'll sign in with.
      </p>
      <form className="auth-form" onSubmit={(e) => void submit(e)}>
        <AuthField id="welcome-token" label="Bootstrap token">
          <input
            id="welcome-token"
            className="auth-input auth-input--mono"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="from your deployment"
            autoComplete="off"
          />
          {prefilled && (
            <div className="auth-prefilled">
              <span className="auth-chip">pre-filled from link</span>
              <span>cleared from the address bar</span>
            </div>
          )}
        </AuthField>
        <AuthField id="welcome-username" label="Username">
          <input
            id="welcome-username"
            className="auth-input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
        </AuthField>
        <AuthField id="welcome-password" label="Password">
          <input
            id="welcome-password"
            className="auth-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="at least 12 characters"
            autoComplete="new-password"
          />
        </AuthField>
        <AuthError message={error} />
        <button type="submit" className="auth-btn" disabled={pending}>
          Claim &amp; sign in
        </button>
      </form>
      <p className="auth-foot">
        The token stays with your operator. From now on, this username and password are the only way
        in.
      </p>
    </AuthScreen>
  );
}

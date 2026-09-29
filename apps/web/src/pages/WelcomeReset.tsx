import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AuthError,
  AuthField,
  AuthScreen,
  AuthWordmark,
  usePrefillToken,
} from '../components/auth/AuthShell';
import { clearUnauthorized } from '../lib/auth/auth-bridge';
import { MIN_PASSWORD_LENGTH, postAuth } from '../lib/auth/auth-flow';

// ④ Reset (web-auth-bootstrap D6, mockup ④): a separate URL, never linked
// from the login screen. The CURRENT bootstrap token gates it; success sets
// new credentials, invalidates every other session server-side, and signs
// the resetter in. A claimed instance's /auth/exchange link 302s here with
// `?t=` — prefilled and scrubbed like the wizard (D7).

export function WelcomeReset() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [token, setToken] = useState('');
  const [prefilled, setPrefilled] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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
    const result = await postAuth('reset', { token, username, password });
    setPending(false);
    if (result.ok) {
      clearUnauthorized();
      void qc.invalidateQueries();
      navigate('/', { replace: true });
      return;
    }
    setError(result.message);
  };

  return (
    <AuthScreen>
      <AuthWordmark context="reset access" />
      <h3 className="auth-title">Reset credentials</h3>
      <p className="auth-sub">
        Enter the instance's bootstrap token to set a new username and password.
      </p>
      <form className="auth-form" onSubmit={(e) => void submit(e)}>
        <AuthField id="reset-token" label="Bootstrap token">
          <input
            id="reset-token"
            className="auth-input auth-input--mono"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="from your operator / deployment secret"
            autoComplete="off"
          />
          {prefilled && (
            <div className="auth-prefilled">
              <span className="auth-chip">pre-filled from link</span>
              <span>cleared from the address bar</span>
            </div>
          )}
        </AuthField>
        <AuthField id="reset-username" label="New username">
          <input
            id="reset-username"
            className="auth-input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
        </AuthField>
        <AuthField id="reset-password" label="New password">
          <input
            id="reset-password"
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
          Reset &amp; sign in
        </button>
      </form>
      <p className="auth-foot">
        <span className="auth-glyph-warn" aria-hidden="true">
          ⚠
        </span>{' '}
        Resetting signs out every active session.
      </p>
    </AuthScreen>
  );
}

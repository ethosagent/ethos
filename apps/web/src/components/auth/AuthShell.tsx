import { type ReactNode, useEffect } from 'react';
import { extractPrefillToken } from '../../lib/auth/auth-flow';

// Shared primitives for the auth surfaces (AuthGate, /welcome,
// /welcome/reset) — the centered bg-elevated card from the approved Phase 0
// mockup, styled by the `.auth-*` classes in styles.css (DESIGN.md tokens:
// 8px card radius, 4px controls, accent focus ring, glyph + word errors).

export function AuthScreen({ children }: { children: ReactNode }) {
  return (
    <div className="auth-screen">
      <div className="auth-card">{children}</div>
    </div>
  );
}

export function AuthWordmark({ context }: { context?: string }) {
  return (
    <div className="auth-wordmark">
      ethos
      {context ? <span> · {context}</span> : null}
    </div>
  );
}

export function AuthField({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="auth-field">
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}

/** Glyph + word (DESIGN.md: never color alone), announced via role=alert. */
export function AuthError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="auth-err" role="alert">
      <span aria-hidden="true">⚠</span>
      <span>{message}</span>
    </div>
  );
}

/**
 * D7 — a `?t=` deep-link PREFILLS the token field, then leaves the URL:
 * `history.replaceState` scrubs the param (other params survive) so the
 * token never sits in the address bar or browser history.
 */
export function usePrefillToken(
  setToken: (token: string) => void,
  setPrefilled: (prefilled: boolean) => void,
): void {
  useEffect(() => {
    const { token, scrubbedSearch } = extractPrefillToken(window.location.search);
    if (token === null) return;
    setToken(token);
    setPrefilled(true);
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${scrubbedSearch}${window.location.hash}`,
    );
  }, [setToken, setPrefilled]);
}

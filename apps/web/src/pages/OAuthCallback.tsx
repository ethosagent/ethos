import { Alert, Button, Spin, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { rpc } from '../rpc';

interface OAuthPayload {
  code?: string | null;
  state?: string | null;
  error?: string | null;
  error_description?: string | null;
}

type Status = 'completing' | 'success' | 'error';

export function OAuthCallback() {
  const navigate = useNavigate();
  const didRun = useRef(false);
  const [status, setStatus] = useState<Status>('completing');
  const [serverName, setServerName] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (didRun.current) return;
    didRun.current = true;

    const raw = sessionStorage.getItem('ethos:mcp_oauth_callback');
    sessionStorage.removeItem('ethos:mcp_oauth_callback');

    if (!raw) {
      setStatus('error');
      setErrorMsg('OAuth callback parameters missing — please retry from the UI.');
      return;
    }

    let payload: OAuthPayload;
    try {
      payload = JSON.parse(raw) as OAuthPayload;
    } catch {
      setStatus('error');
      setErrorMsg('Failed to parse OAuth callback data.');
      return;
    }

    if (payload.error) {
      // Upstream provider returned an error
      const detail = payload.error_description
        ? `${payload.error}: ${payload.error_description}`
        : payload.error;

      // Notify opener if in popup mode
      if (window.opener) {
        try {
          window.opener.postMessage(
            { type: 'ethos:mcp_oauth_error', state: payload.state, code: payload.error, detail },
            window.location.origin,
          );
        } catch {
          /* opener may be closed */
        }
      }

      setStatus('error');
      setErrorMsg(detail);
      return;
    }

    if (!payload.code || !payload.state) {
      setStatus('error');
      setErrorMsg('OAuth callback missing required code or state parameter.');
      return;
    }

    // Exchange code for tokens via mcp.complete RPC
    rpc.mcp
      .complete({ code: payload.code, state: payload.state })
      .then((result) => {
        if ('ok' in result && result.ok === false) {
          const msg =
            ('detail' in result ? (result as { detail: string }).detail : undefined) ??
            ('code' in result ? (result as { code: string }).code : undefined) ??
            'Unknown error';
          throw new Error(msg);
        }

        const name = 'serverName' in result ? (result as { serverName: string }).serverName : '';
        setServerName(name);
        setStatus('success');

        // Notify opener (popup mode)
        if (window.opener) {
          try {
            window.opener.postMessage(
              { type: 'ethos:mcp_oauth_success', state: payload.state, serverName: name },
              window.location.origin,
            );
            // Self-close popup after short delay
            setTimeout(() => window.close(), 1500);
            return;
          } catch {
            /* opener may be closed */
          }
        }

        // Same-tab fallback: navigate back to originating page
        const returnPath = sessionStorage.getItem('ethos:mcp_oauth_return');
        sessionStorage.removeItem('ethos:mcp_oauth_return');
        setTimeout(
          () =>
            navigate(returnPath ?? '/plugins', returnPath ? {} : { state: { mcpConnected: name } }),
          2000,
        );
      })
      .catch((err: unknown) => {
        if (window.opener) {
          try {
            window.opener.postMessage(
              {
                type: 'ethos:mcp_oauth_error',
                state: payload.state,
                code: 'complete_failed',
                detail: err instanceof Error ? err.message : String(err),
              },
              window.location.origin,
            );
          } catch {
            /* opener may be closed */
          }
        }
        setStatus('error');
        setErrorMsg(err instanceof Error ? err.message : String(err));
      });
  }, [navigate]);

  if (status === 'completing') {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          gap: 16,
        }}
      >
        <Spin size="large" />
        <Typography.Text>Completing authorization...</Typography.Text>
      </div>
    );
  }

  if (status === 'success') {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          gap: 16,
        }}
      >
        <Alert
          type="success"
          message={`Connected to ${serverName}`}
          description={window.opener ? 'You may close this window.' : 'Redirecting...'}
        />
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        gap: 16,
      }}
    >
      <Alert type="error" message="OAuth Error" description={errorMsg} />
      <Button
        onClick={() => {
          const returnPath = sessionStorage.getItem('ethos:mcp_oauth_return');
          sessionStorage.removeItem('ethos:mcp_oauth_return');
          navigate(returnPath ?? '/plugins');
        }}
      >
        Return to Ethos
      </Button>
    </div>
  );
}

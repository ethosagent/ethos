import type { McpRemotePresetInfo } from '@ethosagent/web-contracts';
import { Button } from 'antd';
import { useCallback, useRef, useState } from 'react';
import { useMcpCatalog } from '../../features/mcp/api/queries';
import { groupByAuth } from '../../features/mcp/catalog';
import { useMcpOAuthPopup } from '../../features/mcp/useMcpOAuthPopup';
import { rpc } from '../../rpc';
import { attachAfterConnect } from '../connectors';
import type { WizardAnswers } from '../reducer';

// Connectors step (plan keyless-first-run §5.2). Two dense row groups derived
// from `authType` by `groupByAuth` (never a second hand-kept list). The grant
// goes to the born agent only (D19: the global catalog stays attach-free; this
// is the explicit attach and the button names the agent). Skip is always
// available and the step never blocks setup.

type RowState = { phase: 'idle' | 'working' | 'connected' } | { phase: 'error'; detail: string };

export function ConnectorsStep({
  answers,
  onNext,
}: {
  answers: WizardAnswers;
  onNext: (patch: Partial<WizardAnswers>) => void;
}) {
  const personalityId = answers.personalityId ?? '';
  const agentName = answers.agentName ?? personalityId;
  const { data, isLoading, isError } = useMcpCatalog();
  const [rows, setRows] = useState<Record<string, RowState>>({});

  const setRow = useCallback((name: string, state: RowState) => {
    setRows((prev) => ({ ...prev, [name]: state }));
  }, []);

  // The OAuth hook is single-flight; remember which preset it is working on.
  const activeOauth = useRef<string>('');

  const oauth = useMcpOAuthPopup({
    personalityId,
    onSuccess: (serverName) => {
      const preset = activeOauth.current;
      if (!preset) return;
      // D20: attach only now that the sign-in finished. If the popup was blocked, the
      // same-tab fallback completes the server flow but not this attach; re-clicking
      // "Sign in" attaches (no grant without connect).
      void attachAfterConnect({
        serverName: serverName || preset,
        personalityId,
        attach: (args) => rpc.mcp.attachPersonalities(args),
      })
        .then((r) =>
          setRow(preset, r.ok ? { phase: 'connected' } : { phase: 'error', detail: r.detail }),
        )
        .catch((err: unknown) =>
          setRow(preset, {
            phase: 'error',
            detail: err instanceof Error ? err.message : String(err),
          }),
        );
    },
    onError: (message) => {
      const preset = activeOauth.current;
      if (preset) setRow(preset, { phase: 'error', detail: message });
    },
  });

  const addNoAuth = async (preset: McpRemotePresetInfo) => {
    setRow(preset.name, { phase: 'working' });
    try {
      const r = await rpc.mcp.connectPreset({ presetName: preset.name, personalityId });
      setRow(preset.name, r.ok ? { phase: 'connected' } : { phase: 'error', detail: r.detail });
    } catch (err) {
      setRow(preset.name, {
        phase: 'error',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const signIn = (preset: McpRemotePresetInfo) => {
    activeOauth.current = preset.name;
    setRow(preset.name, { phase: 'working' });
    void oauth.start({ url: preset.url, name: preset.name, returnPath: '/onboarding' });
  };

  const connected = Object.entries(rows)
    .filter(([, s]) => s.phase === 'connected')
    .map(([name]) => name);
  const groups = data ? groupByAuth(data.remote) : { none: [], oauth: [] };
  const busy = Object.values(rows).some((s) => s.phase === 'working');

  const row = (preset: McpRemotePresetInfo, kind: 'none' | 'oauth') => {
    const state = rows[preset.name] ?? { phase: 'idle' };
    return (
      <div key={preset.name} className="onboarding-connector">
        <div className="onboarding-connector-text">
          <span className="onboarding-provider-label">{preset.label}</span>
          <span className="onboarding-provider-hint">
            {preset.description}
            {kind === 'oauth' ? ` Signs in with your ${preset.label} account.` : ''}
          </span>
          {state.phase === 'error' ? (
            <span className="onboarding-error" role="alert">
              ✕ {state.detail}
            </span>
          ) : null}
        </div>
        {state.phase === 'connected' ? (
          <span className="onboarding-connector-done">✓ Added</span>
        ) : (
          <Button
            size="small"
            loading={state.phase === 'working'}
            disabled={!personalityId || (busy && state.phase !== 'working')}
            onClick={() => (kind === 'none' ? void addNoAuth(preset) : signIn(preset))}
          >
            {kind === 'none' ? `Add to ${agentName}` : `Sign in to ${preset.label}`}
          </Button>
        )}
      </div>
    );
  };

  return (
    <section className="onboarding-step-content">
      <h1 className="onboarding-headline">Connect tools to {agentName}.</h1>
      <p className="onboarding-supporting">
        Each connector is granted to {agentName} only. You can add or remove them later in Settings.
      </p>

      {isLoading ? (
        <div className="onboarding-supporting" role="status">
          Loading connectors…
        </div>
      ) : null}
      {isError ? (
        <div className="onboarding-warning" role="alert">
          Could not load the connector list. Skip for now and add them from MCP settings.
        </div>
      ) : null}

      {groups.none.length > 0 ? (
        <div className="onboarding-connector-group">
          <div className="onboarding-section-label">WORKS NOW, NO SIGN-IN</div>
          {groups.none.map((p) => row(p, 'none'))}
        </div>
      ) : null}
      {groups.oauth.length > 0 ? (
        <div className="onboarding-connector-group">
          <div className="onboarding-section-label">SIGN IN ONCE</div>
          {groups.oauth.map((p) => row(p, 'oauth'))}
        </div>
      ) : null}

      <div className="onboarding-actions">
        <Button
          type={connected.length > 0 ? 'primary' : 'default'}
          onClick={() => {
            if (oauth.phase !== 'idle') oauth.cancel();
            onNext({ connectedPresets: connected });
          }}
        >
          {connected.length > 0 ? 'Continue' : 'Skip'}
        </Button>
      </div>
    </section>
  );
}

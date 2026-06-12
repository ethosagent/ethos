import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useMemo, useState } from 'react';
import { useServerUrl } from '../shell/ServerUrl';
import { DrawerShell } from '../ui/DrawerShell';
import { RadioOptionRow } from '../ui/RadioOptionRow';
import { SectionLabel } from '../ui/SectionLabel';
import { EnvVarRows } from './components/EnvVarRows';
import { ToolListPreview } from './components/ToolListPreview';

type Transport = 'streamable-http' | 'stdio';
type AuthType = 'none' | 'bearer' | 'oauth';
type TestResult = null | 'loading' | 'success' | 'error';
type Step = 0 | 1 | 2 | 3;

interface AddServerDrawerProps {
  open?: boolean;
  onClose: () => void;
  onServerAdded: () => void;
}

function deriveServerName(transport: Transport, url: string, command: string): string {
  if (transport === 'streamable-http' && url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }
  if (transport === 'stdio' && command) {
    const parts = command.trim().split(/\s+/);
    const last = parts[parts.length - 1];
    return last ?? '';
  }
  return '';
}

const inputStyle = {
  width: '100%',
  height: 36,
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
  padding: '0 10px',
  backgroundColor: 'var(--bg-elevated)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 4,
  color: 'var(--text-primary)',
  outline: 'none',
  boxSizing: 'border-box' as const,
};

const filledButtonStyle = {
  height: 28,
  padding: '0 14px',
  borderRadius: 4,
  border: 'none',
  backgroundColor: 'var(--text-primary)',
  color: 'var(--bg-base)',
  fontSize: 13,
  fontWeight: 500 as const,
  cursor: 'pointer',
};

const ghostButtonStyle = {
  height: 28,
  padding: '0 14px',
  borderRadius: 4,
  border: '1px solid var(--border-subtle)',
  backgroundColor: 'transparent',
  color: 'var(--text-primary)',
  fontSize: 13,
  cursor: 'pointer',
};

function StepDots({ current }: { current: Step }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        gap: 8,
        marginBottom: 20,
      }}
    >
      {([0, 1, 2, 3] as const).map((i) => (
        <div
          key={i}
          style={{
            width: i === current ? 8 : 6,
            height: i === current ? 8 : 6,
            borderRadius: '50%',
            backgroundColor: i === current ? 'var(--text-primary)' : 'var(--bg-overlay)',
            transition: 'all var(--motion-fast) var(--ease)',
          }}
        />
      ))}
    </div>
  );
}

export function AddServerDrawer({ open = true, onClose, onServerAdded }: AddServerDrawerProps) {
  const baseUrl = useServerUrl();
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [step, setStep] = useState<Step>(0);
  const [transport, setTransport] = useState<Transport>('streamable-http');
  const [url, setUrl] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [workingDir, setWorkingDir] = useState('');
  const [timeout, setTimeout_] = useState(30);
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>([]);
  const [authType, setAuthType] = useState<AuthType>('none');
  const [token, setToken] = useState('');
  const [testResult, setTestResult] = useState<TestResult>(null);
  const [testError, setTestError] = useState('');
  const [testTools, setTestTools] = useState<Array<{ name: string; description?: string }>>([]);
  const [serverName, setServerName] = useState('');

  const derivedName = deriveServerName(transport, url, command);
  const effectiveName = serverName || derivedName;

  const envVarsToRecord = useCallback((): Record<string, string> | undefined => {
    const filtered = envVars.filter((v) => v.key.trim());
    if (filtered.length === 0) return undefined;
    const record: Record<string, string> = {};
    for (const v of filtered) {
      record[v.key.trim()] = v.value;
    }
    return record;
  }, [envVars]);

  const handleTest = useCallback(async () => {
    setTestResult('loading');
    setTestError('');
    setTestTools([]);

    try {
      const addInput =
        transport === 'streamable-http'
          ? {
              transport: 'streamable-http' as const,
              name: effectiveName,
              url,
              ...(authType === 'bearer' && token.trim() ? { token: token.trim() } : {}),
            }
          : {
              transport: 'stdio' as const,
              name: effectiveName,
              command,
              ...(args.trim()
                ? {
                    args: args
                      .split(',')
                      .map((a) => a.trim())
                      .filter(Boolean),
                  }
                : {}),
              ...(envVarsToRecord() ? { env: envVarsToRecord() } : {}),
            };

      const result = await client.rpc.mcp.addServer(addInput);

      if (!result.ok) {
        setTestResult('error');
        setTestError(('detail' in result ? result.detail : result.code) ?? 'Failed to add server');
        return;
      }

      setTestResult('success');

      try {
        const toolsResult = await client.rpc.mcp.serverTools({
          personalityId: 'default',
          serverName: result.serverName,
        });
        if (toolsResult.available) {
          setTestTools(toolsResult.tools);
        }
      } catch {
        // Tool listing is best-effort
      }
    } catch (err) {
      setTestResult('error');
      setTestError(err instanceof Error ? err.message : String(err));
    }
  }, [transport, effectiveName, url, authType, token, command, args, envVarsToRecord, client]);

  const handleAdd = useCallback(() => {
    onClose();
    onServerAdded();
  }, [onClose, onServerAdded]);

  const handlePickDir = useCallback(async () => {
    const result = await window.ethos.dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (!result.canceled && result.filePaths.length > 0) {
      setWorkingDir(result.filePaths[0]);
    }
  }, []);

  const handleStartOAuth = useCallback(async () => {
    try {
      const result = await client.rpc.mcp.start({ url });
      if (result.ok && 'authUrl' in result && typeof result.authUrl === 'string') {
        await window.ethos.shell.openExternal({ url: result.authUrl });
      }
    } catch {
      // OAuth flow start is best-effort
    }
  }, [client, url]);

  const canAdvanceStep1 =
    transport === 'streamable-http'
      ? url.trim().length > 0 && effectiveName.length > 0
      : command.trim().length > 0 && effectiveName.length > 0;

  const footer = (
    <>
      {step === 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', width: '100%' }}>
          <button type="button" onClick={() => setStep(1)} style={filledButtonStyle}>
            Next
          </button>
        </div>
      )}
      {step === 1 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
          <button type="button" onClick={() => setStep(0)} style={ghostButtonStyle}>
            Back
          </button>
          <button
            type="button"
            disabled={!canAdvanceStep1}
            onClick={() => setStep(2)}
            style={{
              ...filledButtonStyle,
              opacity: canAdvanceStep1 ? 1 : 0.4,
              cursor: canAdvanceStep1 ? 'pointer' : 'not-allowed',
            }}
          >
            Next
          </button>
        </div>
      )}
      {step === 2 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
          <button type="button" onClick={() => setStep(1)} style={ghostButtonStyle}>
            Back
          </button>
          <button type="button" onClick={() => setStep(3)} style={filledButtonStyle}>
            Next
          </button>
        </div>
      )}
      {step === 3 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
          <button type="button" onClick={() => setStep(2)} style={ghostButtonStyle}>
            Back
          </button>
          <button
            type="button"
            disabled={testResult !== 'success'}
            onClick={handleAdd}
            style={{
              ...filledButtonStyle,
              opacity: testResult === 'success' ? 1 : 0.4,
              cursor: testResult === 'success' ? 'pointer' : 'not-allowed',
            }}
          >
            Add server
          </button>
        </div>
      )}
    </>
  );

  return (
    <DrawerShell open={open} title="Add MCP Server" onClose={onClose} footer={footer}>
      <StepDots current={step} />

      {step === 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <SectionLabel>Transport type</SectionLabel>
          <RadioOptionRow
            selected={transport === 'streamable-http'}
            onClick={() => setTransport('streamable-http')}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>
                HTTP / Streamable HTTP
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Connect to a remote server over HTTP. Supports streaming.
              </span>
            </div>
          </RadioOptionRow>
          <RadioOptionRow selected={transport === 'stdio'} onClick={() => setTransport('stdio')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>
                Local command (stdio)
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Run a local program as an MCP server. Useful for native integrations.
              </span>
            </div>
          </RadioOptionRow>
        </div>
      )}

      {step === 1 && transport === 'streamable-http' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <SectionLabel>Server URL</SectionLabel>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/mcp"
              style={inputStyle}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <SectionLabel>Server name</SectionLabel>
            <input
              type="text"
              value={serverName}
              onChange={(e) => setServerName(e.target.value)}
              placeholder={derivedName || 'my-server'}
              style={inputStyle}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>Timeout</span>
            <input
              type="number"
              value={timeout}
              onChange={(e) => setTimeout_(Number(e.target.value))}
              min={1}
              style={{ ...inputStyle, width: 60, textAlign: 'center' }}
            />
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>seconds</span>
          </div>
        </div>
      )}

      {step === 1 && transport === 'stdio' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <SectionLabel>Command</SectionLabel>
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx @modelcontextprotocol/server-everything stdio"
              style={inputStyle}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <SectionLabel>Arguments</SectionLabel>
            <input
              type="text"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="Comma-separated args (optional)"
              style={inputStyle}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <SectionLabel>Server name</SectionLabel>
            <input
              type="text"
              value={serverName}
              onChange={(e) => setServerName(e.target.value)}
              placeholder={derivedName || 'my-server'}
              style={inputStyle}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <SectionLabel>Working directory</SectionLabel>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type="text"
                value={workingDir}
                onChange={(e) => setWorkingDir(e.target.value)}
                placeholder="/path/to/project"
                style={{ ...inputStyle, flex: 1 }}
              />
              <button
                type="button"
                onClick={handlePickDir}
                style={{
                  ...ghostButtonStyle,
                  height: 36,
                  padding: '0 10px',
                  flexShrink: 0,
                }}
              >
                Browse
              </button>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>Timeout</span>
            <input
              type="number"
              value={timeout}
              onChange={(e) => setTimeout_(Number(e.target.value))}
              min={1}
              style={{ ...inputStyle, width: 60, textAlign: 'center' }}
            />
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>seconds</span>
          </div>
          <EnvVarRows vars={envVars} onChange={setEnvVars} />
        </div>
      )}

      {step === 2 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <SectionLabel>Authentication</SectionLabel>
          <RadioOptionRow selected={authType === 'none'} onClick={() => setAuthType('none')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>
                None
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Server accepts connections without authentication.
              </span>
            </div>
          </RadioOptionRow>
          <RadioOptionRow selected={authType === 'bearer'} onClick={() => setAuthType('bearer')}>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                width: '100%',
              }}
            >
              <span style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>
                Bearer token
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Add a static API token to each request.
              </span>
              {authType === 'bearer' && (
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Paste token here"
                  style={{ ...inputStyle, marginTop: 8, fontSize: 13 }}
                />
              )}
            </div>
          </RadioOptionRow>
          <RadioOptionRow selected={authType === 'oauth'} onClick={() => setAuthType('oauth')}>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                width: '100%',
              }}
            >
              <span style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>
                OAuth
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Complete an OAuth flow to authenticate.
              </span>
              {authType === 'oauth' && (
                <button
                  type="button"
                  onClick={handleStartOAuth}
                  style={{
                    ...ghostButtonStyle,
                    marginTop: 8,
                    height: 30,
                    alignSelf: 'flex-start',
                  }}
                >
                  Start OAuth flow &rarr;
                </button>
              )}
            </div>
          </RadioOptionRow>
        </div>
      )}

      {step === 3 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <button
            type="button"
            disabled={testResult === 'loading'}
            onClick={handleTest}
            style={{
              width: '100%',
              height: 36,
              borderRadius: 4,
              border: 'none',
              backgroundColor: 'var(--text-primary)',
              color: 'var(--bg-base)',
              fontSize: 13,
              fontWeight: 500,
              cursor: testResult === 'loading' ? 'not-allowed' : 'pointer',
              opacity: testResult === 'loading' ? 0.6 : 1,
            }}
          >
            {testResult === 'loading' ? 'Testing...' : 'Test connection'}
          </button>

          {testResult === 'success' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 12px',
                  borderRadius: 4,
                  backgroundColor: 'rgba(52, 199, 89, 0.08)',
                }}
              >
                <span style={{ color: 'var(--success)', fontSize: 16 }}>{'✓'}</span>
                <span style={{ fontSize: 13, color: 'var(--success)' }}>
                  Connected to {effectiveName}
                </span>
              </div>
              {testTools.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <SectionLabel>Available tools ({testTools.length})</SectionLabel>
                  <ToolListPreview tools={testTools} />
                </div>
              )}
            </div>
          )}

          {testResult === 'error' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 12px',
                  borderRadius: 4,
                  backgroundColor: 'rgba(255, 69, 58, 0.08)',
                }}
              >
                <span style={{ color: 'var(--error)', fontSize: 16 }}>{'✗'}</span>
                <span style={{ fontSize: 13, color: 'var(--error)' }}>Connection failed</span>
              </div>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                  wordBreak: 'break-word',
                }}
              >
                {testError}
              </span>
            </div>
          )}
        </div>
      )}
    </DrawerShell>
  );
}

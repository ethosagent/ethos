import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConfigGetResponse, ProviderType } from '../../shared/ipc-contract';
import { useAppState } from '../state/AppContext';
import { RadioOptionRow } from '../ui/RadioOptionRow';
import { SectionLabel } from '../ui/SectionLabel';
import { SettingRow } from '../ui/SettingRow';
import { SliderRow } from '../ui/SliderRow';
import { Toggle } from '../ui/Toggle';
import { ApiKeyUpdateFlow } from './components/ApiKeyUpdateFlow';
import { CodexAuthSection } from './components/CodexAuthSection';
import { LaunchAtLoginRow } from './components/LaunchAtLoginRow';
import { ProviderDropdown } from './components/ProviderDropdown';
import { SaveButton } from './components/SaveButton';

// ---------------------------------------------------------------------------
// Provider chain row state
// ---------------------------------------------------------------------------

let nextRowId = 1;

interface ProviderRow {
  _id: number;
  provider: ProviderType;
  model: string;
  apiKeyPreview: string;
  baseUrl: string;
  editing: boolean;
}

function rowsFromConfig(config: ConfigGetResponse): ProviderRow[] {
  // Desktop config has a single provider; wrap it as a chain
  return [
    {
      _id: nextRowId++,
      provider: config.provider,
      model: config.model,
      apiKeyPreview: config.apiKeyPreview ?? '',
      baseUrl: config.baseUrl ?? '',
      editing: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// Drag reorder helper
// ---------------------------------------------------------------------------

function useDragReorder<T>(_items: T[], setItems: React.Dispatch<React.SetStateAction<T[]>>) {
  const dragIdx = useRef<number | null>(null);

  const onDragStart = useCallback((idx: number) => {
    dragIdx.current = idx;
  }, []);

  const onDragOver = useCallback(
    (e: React.DragEvent, idx: number) => {
      e.preventDefault();
      const from = dragIdx.current;
      if (from === null || from === idx) return;
      setItems((prev) => {
        const next = [...prev];
        const dragged = next[from];
        if (!dragged) return prev;
        next.splice(from, 1);
        next.splice(idx, 0, dragged);
        dragIdx.current = idx;
        return next;
      });
    },
    [setItems],
  );

  const onDragEnd = useCallback(() => {
    dragIdx.current = null;
  }, []);

  return { onDragStart, onDragOver, onDragEnd };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SettingsPage() {
  const [config, setConfig] = useState<ConfigGetResponse | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(() => {
    try {
      return localStorage.getItem('ethos:settings:advanced') === 'true';
    } catch {
      return false;
    }
  });

  // Provider state
  const [providerRows, setProviderRows] = useState<ProviderRow[]>([]);
  const [provider, setProvider] = useState<ProviderType>('anthropic');
  const [model, setModel] = useState('');
  const [compressionModel, setCompressionModel] = useState('');
  const [visionModel, setVisionModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [keyPreview, setKeyPreview] = useState('');

  // Advanced state
  const { setAdvancedMode } = useAppState();
  const [advancedEnabled, setAdvancedEnabled] = useState(false);
  const [exportStatus, setExportStatus] = useState('');
  const [pruneStatus, setPruneStatus] = useState('');

  const loadConfig = useCallback(async () => {
    try {
      const cfg = await window.ethos.settings.getConfig();
      setConfig(cfg);
      setProviderRows(rowsFromConfig(cfg));
      setProvider(cfg.provider);
      setModel(cfg.model);
      setCompressionModel(cfg.compressionModel ?? '');
      setVisionModel(cfg.visionModel ?? '');
      setBaseUrl(cfg.baseUrl ?? '');
      setKeyPreview(cfg.apiKeyPreview ?? '');
    } catch (err) {
      console.error('[SettingsPage] Failed to load config', err);
    }
  }, []);

  useEffect(() => {
    loadConfig();
    window.ethos.settings.getAdvancedMode().then(setAdvancedEnabled);
  }, [loadConfig]);

  const toggleAdvanced = useCallback(() => {
    setShowAdvanced((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('ethos:settings:advanced', String(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const drag = useDragReorder(providerRows, setProviderRows);

  if (!config) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: 'var(--text-tertiary)',
          fontSize: 13,
        }}
      >
        Loading settings...
      </div>
    );
  }

  const models = config.providers[provider] ?? [];
  const modelOptions = models.map((m) => ({ value: m, label: m }));
  const showEndpoint = provider === 'ollama' || provider === 'azure' || provider === 'openrouter';

  const hasProviderChanges =
    provider !== config.provider ||
    model !== config.model ||
    compressionModel !== (config.compressionModel ?? '') ||
    visionModel !== (config.visionModel ?? '') ||
    baseUrl !== (config.baseUrl ?? '');

  async function handleProviderSave(): Promise<{ ok: boolean; error?: string }> {
    if (!config) return { ok: false, error: 'Config not loaded' };
    const updates: Record<string, unknown> = {};
    if (provider !== config.provider) updates.provider = provider;
    if (model !== config.model) updates.model = model;
    if (compressionModel !== (config.compressionModel ?? ''))
      updates.compressionModel = compressionModel || undefined;
    if (visionModel !== (config.visionModel ?? '')) updates.visionModel = visionModel || undefined;
    if (baseUrl !== (config.baseUrl ?? '')) updates.baseUrl = baseUrl || undefined;

    const result = await window.ethos.settings.updateConfig(updates);
    if (result.ok) loadConfig();
    return result;
  }

  async function refreshKeyPreview() {
    try {
      const { preview } = await window.ethos.keychain.preview({ key: 'api-key' });
      setKeyPreview(preview ?? '');
    } catch {
      // ignore
    }
    loadConfig();
  }

  async function autoSave(updates: Record<string, unknown>) {
    const { ok } = await window.ethos.settings.updateConfig(updates);
    if (ok) loadConfig();
  }

  async function handleThemeChange(theme: 'dark' | 'light' | 'system') {
    await window.ethos.settings.setTheme({ theme });
    const resolved =
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : theme;
    document.documentElement.setAttribute('data-theme', resolved);
    await autoSave({ theme });
  }

  async function handleAdvancedToggle(enabled: boolean) {
    const { ok } = await window.ethos.settings.setAdvancedMode({ enabled });
    if (ok) {
      setAdvancedEnabled(enabled);
      setAdvancedMode(enabled);
    }
  }

  async function handleExport() {
    setExportStatus('Exporting...');
    try {
      const result = await window.ethos.settings.exportData();
      if (result.ok) {
        setExportStatus(result.path ? `Exported to ${result.path}` : 'Export complete.');
      } else {
        setExportStatus(result.error ?? 'Export failed.');
      }
    } catch {
      setExportStatus('Export failed.');
    }
  }

  async function handlePrune() {
    if (!config) return;
    setPruneStatus('Pruning...');
    try {
      const result = await window.ethos.settings.pruneRetention({
        retentionDays: config.retentionDays,
        traceLogDays: config.traceLogDays,
        observabilityDays: config.observabilityDays,
      });
      if (result.ok) {
        const freedMb = result.freedBytes ? (result.freedBytes / (1024 * 1024)).toFixed(1) : '0';
        setPruneStatus(`Done. Freed ${freedMb} MB.`);
      } else {
        setPruneStatus(result.error ?? 'Prune failed.');
      }
    } catch {
      setPruneStatus('Prune failed.');
    }
  }

  const themeOptions: Array<'dark' | 'light' | 'system'> = ['dark', 'light', 'system'];

  const providerOptions = [
    { value: 'anthropic', label: 'Anthropic' },
    { value: 'openai', label: 'OpenAI' },
    { value: 'azure', label: 'Azure OpenAI' },
    { value: 'ollama', label: 'Ollama' },
    { value: 'openrouter', label: 'OpenRouter' },
    { value: 'codex', label: 'OpenAI Codex' },
  ];

  const approvalOptions: Array<{
    value: 'manual' | 'smart' | 'off';
    label: string;
    description: string;
  }> = [
    { value: 'manual', label: 'Manual', description: 'Ask before every sensitive tool call.' },
    {
      value: 'smart',
      label: 'Smart',
      description: 'Ask only for high-risk operations. Routine tools run automatically.',
    },
    {
      value: 'off',
      label: 'Off',
      description: 'Run all tools without asking. Use only on trusted machines.',
    },
  ];

  return (
    <div
      style={{
        maxWidth: 720,
        margin: '0 auto',
        padding: 24,
        overflowY: 'auto',
        height: '100%',
      }}
    >
      {/* ── Header ───────────────────────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 24,
        }}
      >
        <h2
          style={{
            fontSize: 20,
            fontWeight: 600,
            color: 'var(--text-primary)',
            margin: 0,
          }}
        >
          Settings
        </h2>
        <button
          type="button"
          onClick={toggleAdvanced}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            background: 'transparent',
            border: 'none',
            color: 'var(--text-secondary)',
            fontSize: 11,
            cursor: 'pointer',
            padding: '4px 8px',
            borderRadius: 4,
          }}
        >
          {showAdvanced ? 'Hide advanced' : 'Show advanced'}
          <span
            style={{
              display: 'inline-block',
              fontSize: 10,
              transform: showAdvanced ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 80ms ease',
            }}
          >
            ▾
          </span>
        </button>
      </div>

      {/* ── Provider Chain ───────────────────────────────────────── */}
      <div style={{ marginBottom: 24 }}>
        <SectionLabel>Provider chain</SectionLabel>
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {providerRows.map((row, idx) => (
            // biome-ignore lint/a11y/noStaticElementInteractions: drag-reorderable row uses HTML5 DnD
            <div
              key={row._id}
              draggable
              onDragStart={() => drag.onDragStart(idx)}
              onDragOver={(e) => drag.onDragOver(e, idx)}
              onDragEnd={drag.onDragEnd}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 14px',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 6,
                cursor: 'grab',
                flexWrap: 'wrap',
              }}
            >
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)', cursor: 'grab' }}>⠿</span>
              <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                {row.provider}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                }}
              >
                {row.model}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--text-tertiary)',
                }}
              >
                {row.apiKeyPreview || '—'}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  fontWeight: 500,
                  color: idx === 0 ? 'var(--success)' : 'var(--text-tertiary)',
                  backgroundColor: idx === 0 ? 'rgba(74, 222, 128, 0.10)' : 'var(--bg-overlay)',
                  padding: '2px 8px',
                  borderRadius: 4,
                  whiteSpace: 'nowrap',
                }}
              >
                {idx === 0 ? '✓ active' : 'standby'}
              </span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  onClick={() =>
                    setProviderRows((prev) =>
                      prev.map((r, i) => (i === idx ? { ...r, editing: !r.editing } : r)),
                    )
                  }
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-secondary)',
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                >
                  {row.editing ? 'Done' : 'Edit'}
                </button>
              </span>
            </div>
          ))}
        </div>

        {/* Provider edit area */}
        <div style={{ marginTop: 12 }}>
          <SettingRow label="Provider">
            <ProviderDropdown
              value={provider}
              options={providerOptions}
              onChange={(v) => {
                setProvider(v as ProviderType);
                const providerModels = config.providers[v] ?? [];
                setModel(providerModels[0] ?? '');
                setCompressionModel('');
                setVisionModel('');
              }}
            />
          </SettingRow>

          <SettingRow label="Model">
            <ProviderDropdown value={model} options={modelOptions} onChange={setModel} mono />
          </SettingRow>

          {showAdvanced && (
            <>
              <SettingRow label="Compression model" subText="Used for session summaries">
                <ProviderDropdown
                  value={compressionModel}
                  options={[{ value: '', label: 'Default' }, ...modelOptions]}
                  onChange={setCompressionModel}
                  mono
                />
              </SettingRow>
              <SettingRow label="Vision model" subText="Used for image inputs">
                <ProviderDropdown
                  value={visionModel}
                  options={[{ value: '', label: 'Default' }, ...modelOptions]}
                  onChange={setVisionModel}
                  mono
                />
              </SettingRow>
            </>
          )}

          {showEndpoint && (
            <SettingRow label="Endpoint URL">
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://..."
                style={{
                  width: 280,
                  height: 32,
                  padding: '0 8px',
                  borderRadius: 4,
                  border: '1px solid var(--border-subtle)',
                  backgroundColor: 'var(--bg-elevated)',
                  color: 'var(--text-primary)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 13,
                  outline: 'none',
                }}
              />
            </SettingRow>
          )}

          {provider === 'codex' ? (
            <div style={{ marginTop: 12 }}>
              <CodexAuthSection onAuthUpdated={loadConfig} />
            </div>
          ) : (
            <div style={{ marginTop: 12 }}>
              <SettingRow label="Current key">
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    color: 'var(--text-tertiary)',
                  }}
                >
                  {keyPreview || 'Not set'}
                </span>
              </SettingRow>
              <ApiKeyUpdateFlow provider={provider} onKeyUpdated={refreshKeyPreview} />
            </div>
          )}

          <SaveButton disabled={!hasProviderChanges} onSave={handleProviderSave} />
        </div>
      </div>

      {/* ── Default Personality ──────────────────────────────────── */}
      <div style={{ marginBottom: 24 }}>
        <SectionLabel>Default personality</SectionLabel>
        <div style={{ marginTop: 8 }}>
          {/* Desktop doesn't have a personalities list API in the same
              shape; just show the config value as text */}
          <SettingRow label="Current">
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                color: 'var(--text-primary)',
              }}
            >
              {config.provider ? 'default' : '—'}
            </span>
          </SettingRow>
        </div>
      </div>

      {/* ── Memory Mode ─────────────────────────────────────────── */}
      <div style={{ marginBottom: 24 }}>
        <SectionLabel>Memory mode</SectionLabel>
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <RadioOptionRow
            selected={config.memory === 'markdown'}
            onClick={() => autoSave({ memory: 'markdown' })}
          >
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
                  Markdown
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                Plain text files. Simple, portable, always readable.
              </div>
            </div>
          </RadioOptionRow>
          <RadioOptionRow
            selected={config.memory === 'vector'}
            onClick={() => autoSave({ memory: 'vector' })}
          >
            <div style={{ flex: 1 }}>
              <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
                Vector
              </span>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                Semantic search over your notes.
              </div>
            </div>
          </RadioOptionRow>
        </div>
      </div>

      {/* ── Theme ───────────────────────────────────────────────── */}
      <div style={{ marginBottom: 24 }}>
        <SectionLabel>Theme</SectionLabel>
        <div
          style={{
            marginTop: 8,
            padding: '8px 0',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <div style={{ display: 'flex', gap: 8 }}>
            {themeOptions.map((t) => (
              <label
                key={t}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 13,
                  color: 'var(--text-primary)',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="radio"
                  name="theme"
                  checked={config.theme === t}
                  onChange={() => handleThemeChange(t)}
                  style={{ accentColor: 'var(--accent)' }}
                />
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* ── Launch at login ─────────────────────────────────────── */}
      <div style={{ marginBottom: 24 }}>
        <SectionLabel>Startup</SectionLabel>
        <div style={{ marginTop: 8 }}>
          <LaunchAtLoginRow hasShownHint={config.hasShownLoginItemHint} onRefresh={loadConfig} />
        </div>
      </div>

      {/* ── Appearance (chat display) ───────────────────────────── */}
      <div style={{ marginBottom: 24 }}>
        <SectionLabel>Chat display</SectionLabel>
        <div style={{ marginTop: 8 }}>
          <SettingRow label="Verbosity">
            <div style={{ display: 'flex', gap: 0 }}>
              {(['concise', 'balanced', 'verbose'] as const).map((v) => {
                const isSelected = config.verbosity === v;
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => autoSave({ verbosity: v })}
                    style={{
                      height: 28,
                      padding: '0 12px',
                      borderRadius: 4,
                      border: isSelected
                        ? '1px solid var(--accent)'
                        : '1px solid var(--border-subtle)',
                      backgroundColor: isSelected ? 'var(--bg-overlay)' : 'transparent',
                      color: 'var(--text-primary)',
                      fontSize: 12,
                      cursor: 'pointer',
                      marginLeft: v === 'concise' ? 0 : -1,
                      position: 'relative',
                      zIndex: isSelected ? 1 : 0,
                    }}
                  >
                    {v.charAt(0).toUpperCase() + v.slice(1)}
                  </button>
                );
              })}
            </div>
          </SettingRow>
          <SliderRow
            label="Message font size"
            value={config.messageFontSize}
            min={12}
            max={18}
            step={1}
            unit="px"
            onChange={(v) => {
              document.documentElement.style.setProperty('--chat-font-size', `${v}px`);
              autoSave({ messageFontSize: v });
            }}
          />
          <SliderRow
            label="Code block font size"
            value={config.codeBlockFontSize}
            min={11}
            max={15}
            step={1}
            unit="px"
            onChange={(v) => autoSave({ codeBlockFontSize: v })}
          />
        </div>
      </div>

      {/* ── Advanced section ─────────────────────────────────────── */}
      {showAdvanced && (
        <>
          <div style={{ marginBottom: 24 }}>
            <SectionLabel>Advanced</SectionLabel>
            <div style={{ marginTop: 8 }}>
              <SettingRow
                label="Advanced mode"
                subText="Show MCP server management, the Safety tab in personality editing, and the Lab features"
              >
                <Toggle checked={advancedEnabled} onChange={handleAdvancedToggle} />
              </SettingRow>
            </div>
          </div>

          <div style={{ marginBottom: 24 }}>
            <SectionLabel>Approval</SectionLabel>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {approvalOptions.map((opt) => (
                <RadioOptionRow
                  key={opt.value}
                  selected={config.approvalMode === opt.value}
                  onClick={() => autoSave({ approvalMode: opt.value })}
                  accentColor="#f59e0b"
                >
                  <div style={{ flex: 1 }}>
                    <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
                      {opt.label}
                    </span>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                      {opt.description}
                    </div>
                  </div>
                </RadioOptionRow>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 24 }}>
            <SectionLabel>Context</SectionLabel>
            <div style={{ marginTop: 8 }}>
              <SettingRow
                label="Context layering"
                subText="Include previous session summaries for deeper context."
              >
                <Toggle
                  checked={config.contextLayering}
                  onChange={(checked) => autoSave({ contextLayering: checked })}
                />
              </SettingRow>
            </div>
          </div>

          <div style={{ marginBottom: 24 }}>
            <SectionLabel>Developer</SectionLabel>
            <div style={{ marginTop: 8 }}>
              <SettingRow
                label="Debug mode"
                subText="Show expanded tool args and internal events in chat."
              >
                <Toggle
                  checked={config.debugMode}
                  onChange={(checked) => autoSave({ debugMode: checked })}
                />
              </SettingRow>
            </div>
          </div>

          {/* ── Data Retention ───────────────────────────────────── */}
          <div style={{ marginBottom: 24 }}>
            <SectionLabel>Data retention</SectionLabel>
            <div style={{ marginTop: 8 }}>
              <SliderRow
                label="Keep messages for"
                value={config.retentionDays}
                min={7}
                max={365}
                step={1}
                unit=" days"
                onChange={(v) => autoSave({ retentionDays: v })}
              />
              <SliderRow
                label="Keep trace logs for"
                value={config.traceLogDays}
                min={1}
                max={90}
                step={1}
                unit=" days"
                onChange={(v) => autoSave({ traceLogDays: v })}
              />
              <SliderRow
                label="Keep observability blobs for"
                value={config.observabilityDays}
                min={1}
                max={30}
                step={1}
                unit=" days"
                onChange={(v) => autoSave({ observabilityDays: v })}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                <button
                  type="button"
                  onClick={handlePrune}
                  disabled={pruneStatus === 'Pruning...'}
                  style={{
                    height: 28,
                    padding: '0 12px',
                    borderRadius: 4,
                    border: '1px solid var(--border-subtle)',
                    backgroundColor: 'transparent',
                    color: 'var(--text-primary)',
                    fontSize: 12,
                    cursor: pruneStatus === 'Pruning...' ? 'not-allowed' : 'pointer',
                  }}
                >
                  Apply retention policy now
                </button>
                {pruneStatus && (
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12,
                      color: pruneStatus.startsWith('Done')
                        ? 'var(--success)'
                        : 'var(--text-tertiary)',
                    }}
                  >
                    {pruneStatus}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* ── Data export ──────────────────────────────────────── */}
          <div style={{ marginBottom: 24 }}>
            <SectionLabel>Data</SectionLabel>
            <div style={{ marginTop: 8 }}>
              <SettingRow label="Export all data">
                <button
                  type="button"
                  onClick={handleExport}
                  style={{
                    height: 28,
                    padding: '0 12px',
                    borderRadius: 4,
                    border: '1px solid var(--border-subtle)',
                    backgroundColor: 'transparent',
                    color: 'var(--text-primary)',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  Export...
                </button>
              </SettingRow>
              {exportStatus && (
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--text-tertiary)',
                    marginTop: 4,
                  }}
                >
                  {exportStatus}
                </div>
              )}
            </div>
          </div>

          {/* ── General: Updates + Data dir ──────────────────────── */}
          <div style={{ marginBottom: 24 }}>
            <SectionLabel>Updates</SectionLabel>
            <div style={{ marginTop: 8 }}>
              <SettingRow label="Current version">
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    color: 'var(--text-tertiary)',
                  }}
                >
                  v0.3.0-beta
                </span>
              </SettingRow>
              <SettingRow label="Auto-update">
                <Toggle
                  checked={config.autoUpdate}
                  onChange={(checked) => autoSave({ autoUpdate: checked })}
                />
              </SettingRow>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

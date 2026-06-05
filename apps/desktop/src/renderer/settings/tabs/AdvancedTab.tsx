import { useEffect, useState } from 'react';
import type { ConfigGetResponse } from '../../../shared/ipc-contract';
import { useAppState } from '../../state/AppContext';
import { RadioOptionRow } from '../../ui/RadioOptionRow';
import { SectionLabel } from '../../ui/SectionLabel';
import { SettingRow } from '../../ui/SettingRow';
import { Toggle } from '../../ui/Toggle';

interface AdvancedTabProps {
  config: ConfigGetResponse;
  onRefresh: () => void;
}

export function AdvancedTab({ config, onRefresh }: AdvancedTabProps) {
  const { setAdvancedMode } = useAppState();
  const [advancedEnabled, setAdvancedEnabled] = useState(false);
  const [saved, setSaved] = useState(false);
  const [exportStatus, setExportStatus] = useState('');

  useEffect(() => {
    window.ethos.settings.getAdvancedMode().then(setAdvancedEnabled);
  }, []);

  async function autoSave(updates: Record<string, unknown>) {
    const { ok } = await window.ethos.settings.updateConfig(updates);
    if (ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onRefresh();
    }
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
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', minHeight: 20, marginBottom: 4 }}>
        {saved && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--success)',
            }}
          >
            Saved
          </span>
        )}
      </div>

      <div style={{ marginBottom: 24 }}>
        <SectionLabel>Mode</SectionLabel>
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
              accentColor="var(--warning)"
            >
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
                  {opt.label}
                </span>
                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                    marginTop: 4,
                  }}
                >
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
    </div>
  );
}

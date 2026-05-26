import { useEffect, useState } from 'react';
import type { ConfigGetResponse } from '../../../shared/ipc-contract';
import { SectionLabel } from '../../ui/SectionLabel';
import { SettingRow } from '../../ui/SettingRow';
import { Toggle } from '../../ui/Toggle';
import { LaunchAtLoginRow } from '../components/LaunchAtLoginRow';

interface GeneralTabProps {
  config: ConfigGetResponse;
  onRefresh: () => void;
}

const DEFAULTS: Record<string, unknown> = {
  theme: 'dark',
  memory: 'markdown',
  approvalMode: 'manual',
  contextLayering: false,
  debugMode: false,
  verbosity: 'balanced',
  messageFontSize: 14,
  codeBlockFontSize: 13,
  retentionDays: 90,
  traceLogDays: 30,
  observabilityDays: 7,
  autoUpdate: true,
  launchAtLogin: false,
};

function DataDirRow() {
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [restartNotice, setRestartNotice] = useState(false);

  useEffect(() => {
    window.ethos.settings.getDataDir().then((res: { path: string }) => setCurrentPath(res.path));
  }, []);

  async function handleChange() {
    const result = await window.ethos.dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return;
    const newPath = result.filePaths[0];
    await window.ethos.settings.setDataDir({ path: newPath });
    setCurrentPath(newPath);
    setRestartNotice(true);
  }

  return (
    <div>
      <SettingRow label="Data directory">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--text-tertiary)',
              maxWidth: 220,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {currentPath ?? '—'}
          </span>
          <button
            type="button"
            onClick={handleChange}
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
            Change…
          </button>
        </div>
      </SettingRow>
      {restartNotice && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-tertiary)',
            marginTop: 4,
            marginLeft: 160,
            paddingBottom: 8,
          }}
        >
          Restart the app to apply this change.
        </div>
      )}
    </div>
  );
}

export function GeneralTab({ config, onRefresh }: GeneralTabProps) {
  async function handleToggle(field: string, value: boolean) {
    await window.ethos.settings.updateConfig({ [field]: value });
    onRefresh();
  }

  async function handleReset() {
    const confirmed = window.confirm('Reset all settings to defaults? This cannot be undone.');
    if (!confirmed) return;
    await window.ethos.settings.updateConfig(DEFAULTS);
    onRefresh();
  }

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <SectionLabel>Startup</SectionLabel>
        <div style={{ marginTop: 8 }}>
          <LaunchAtLoginRow hasShownHint={config.hasShownLoginItemHint} onRefresh={onRefresh} />
        </div>
      </div>

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
              onChange={(checked) => handleToggle('autoUpdate', checked)}
            />
          </SettingRow>

          <SettingRow label="Check for updates">
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                color: 'var(--text-tertiary)',
              }}
            >
              Last checked 2h ago
            </span>
          </SettingRow>
        </div>
      </div>

      <div style={{ marginBottom: 24 }}>
        <SectionLabel>Data</SectionLabel>
        <div style={{ marginTop: 8 }}>
          <DataDirRow />
          <SettingRow label="Config files">
            <button
              type="button"
              onClick={() => window.ethos.settings.openConfigFolder()}
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
              Open in Finder
            </button>
          </SettingRow>

          <SettingRow label="Reset to defaults">
            <button
              type="button"
              onClick={handleReset}
              style={{
                height: 28,
                padding: '0 12px',
                borderRadius: 4,
                border: '1px solid var(--border-subtle)',
                backgroundColor: 'transparent',
                color: 'var(--error)',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              Reset...
            </button>
          </SettingRow>
        </div>
      </div>
    </div>
  );
}

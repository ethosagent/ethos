import { useState } from 'react';
import type { ConfigGetResponse } from '../../../shared/ipc-contract';
import { SectionLabel } from '../../ui/SectionLabel';
import { SettingRow } from '../../ui/SettingRow';
import { SliderRow } from '../../ui/SliderRow';

interface AppearanceTabProps {
  config: ConfigGetResponse;
  onRefresh: () => void;
}

type ThemeOption = 'dark' | 'light' | 'system';
type VerbosityOption = 'concise' | 'balanced' | 'verbose';

function resolveTheme(theme: ThemeOption): 'dark' | 'light' {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return theme;
}

export function AppearanceTab({ config, onRefresh }: AppearanceTabProps) {
  const [saved, setSaved] = useState(false);

  async function autoSave(updates: Record<string, unknown>) {
    const { ok } = await window.ethos.settings.updateConfig(updates);
    if (ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onRefresh();
    }
  }

  async function handleThemeChange(theme: ThemeOption) {
    await window.ethos.settings.setTheme({ theme });
    document.documentElement.setAttribute('data-theme', resolveTheme(theme));
    await autoSave({ theme });
  }

  const themeOptions: ThemeOption[] = ['dark', 'light', 'system'];
  const verbosityOptions: VerbosityOption[] = ['concise', 'balanced', 'verbose'];

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
        <SectionLabel>Theme</SectionLabel>
        <div
          style={{ marginTop: 8, padding: '8px 0', borderBottom: '1px solid var(--border-subtle)' }}
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

      <div style={{ marginBottom: 24 }}>
        <SectionLabel>Chat display</SectionLabel>
        <div style={{ marginTop: 8 }}>
          <SettingRow label="Verbosity">
            <div style={{ display: 'flex', gap: 0 }}>
              {verbosityOptions.map((v) => {
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
        </div>
      </div>

      <div style={{ marginBottom: 24 }}>
        <SectionLabel>Code</SectionLabel>
        <div style={{ marginTop: 8 }}>
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
    </div>
  );
}

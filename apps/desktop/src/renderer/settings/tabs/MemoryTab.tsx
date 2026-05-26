import { useState } from 'react';
import type { ConfigGetResponse } from '../../../shared/ipc-contract';
import { Chip } from '../../ui/Chip';
import { RadioOptionRow } from '../../ui/RadioOptionRow';
import { SectionLabel } from '../../ui/SectionLabel';
import { SettingRow } from '../../ui/SettingRow';

interface MemoryTabProps {
  config: ConfigGetResponse;
  onRefresh: () => void;
}

export function MemoryTab({ config, onRefresh }: MemoryTabProps) {
  const [saved, setSaved] = useState(false);

  async function autoSave(updates: Record<string, unknown>) {
    const { ok } = await window.ethos.settings.updateConfig(updates);
    if (ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onRefresh();
    }
  }

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
        <SectionLabel>Memory backend</SectionLabel>
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
                <Chip label="Default" variant="neutral" />
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                  marginTop: 4,
                }}
              >
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
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                  marginTop: 4,
                }}
              >
                Semantic search over your notes.
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--text-tertiary)',
                  marginTop: 4,
                }}
              >
                Requires setup — see documentation.
              </div>
            </div>
          </RadioOptionRow>
        </div>
      </div>

      <div style={{ marginBottom: 24 }}>
        <SectionLabel>Memory scope</SectionLabel>
        <div style={{ marginTop: 8 }}>
          <SettingRow label="Scope path">
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                color: 'var(--text-tertiary)',
              }}
            >
              ~/.ethos/personalities/default/memory/
            </span>
          </SettingRow>
        </div>
      </div>
    </div>
  );
}

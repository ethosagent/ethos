import { useState } from 'react';
import type { ConfigGetResponse } from '../../../shared/ipc-contract';
import { SectionLabel } from '../../ui/SectionLabel';
import { SliderRow } from '../../ui/SliderRow';

interface RetentionTabProps {
  config: ConfigGetResponse;
  onRefresh: () => void;
}

export function RetentionTab({ config, onRefresh }: RetentionTabProps) {
  const [saved, setSaved] = useState(false);
  const [pruneStatus, setPruneStatus] = useState('');

  async function autoSave(updates: Record<string, unknown>) {
    const { ok } = await window.ethos.settings.updateConfig(updates);
    if (ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onRefresh();
    }
  }

  async function handlePrune() {
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
        <SectionLabel>Message history</SectionLabel>
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
        </div>
      </div>

      <div style={{ marginBottom: 24 }}>
        <SectionLabel>Trace logs</SectionLabel>
        <div style={{ marginTop: 8 }}>
          <SliderRow
            label="Keep trace logs for"
            value={config.traceLogDays}
            min={1}
            max={90}
            step={1}
            unit=" days"
            onChange={(v) => autoSave({ traceLogDays: v })}
          />
        </div>
      </div>

      <div style={{ marginBottom: 24 }}>
        <SectionLabel>Observability data</SectionLabel>
        <div style={{ marginTop: 8 }}>
          <SliderRow
            label="Keep observability blobs for"
            value={config.observabilityDays}
            min={1}
            max={30}
            step={1}
            unit=" days"
            onChange={(v) => autoSave({ observabilityDays: v })}
          />
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
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
              color: pruneStatus.startsWith('Done') ? 'var(--success)' : 'var(--text-tertiary)',
            }}
          >
            {pruneStatus}
          </span>
        )}
      </div>
    </div>
  );
}

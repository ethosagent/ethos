import { createEthosClient } from '@ethosagent/sdk';
import { useEffect, useMemo, useState } from 'react';
import { DrawerShell } from '../../ui/DrawerShell';
import { SectionLabel } from '../../ui/SectionLabel';

interface EvolverConfigDrawerProps {
  open: boolean;
  port: number;
  onClose: () => void;
}

export function EvolverConfigDrawer({ open, port, onClose }: EvolverConfigDrawerProps) {
  const [rewriteThreshold, setRewriteThreshold] = useState(0.5);
  const [newSkillPatternThreshold, setNewSkillPatternThreshold] = useState(0.5);
  const [minRunsBeforeEvolve, setMinRunsBeforeEvolve] = useState(3);
  const [minPatternCount, setMinPatternCount] = useState(5);
  const [autoApprove, setAutoApprove] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const client = useMemo(
    () => createEthosClient({ baseUrl: `http://localhost:${port}`, fetch: globalThis.fetch }),
    [port],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    client.rpc.evolver
      .configGet({})
      .then((res) => {
        if (!cancelled) {
          setRewriteThreshold(res.config.rewriteThreshold);
          setNewSkillPatternThreshold(res.config.newSkillPatternThreshold);
          setMinRunsBeforeEvolve(res.config.minRunsBeforeEvolve);
          setMinPatternCount(res.config.minPatternCount);
          setAutoApprove(res.config.autoApprove);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, open]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await client.rpc.evolver.configUpdate({
        rewriteThreshold,
        newSkillPatternThreshold,
        minRunsBeforeEvolve,
        minPatternCount,
        autoApprove,
      });
      onClose();
    } catch {
      // best-effort
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = {
    width: 60,
    height: 28,
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    color: 'var(--text-primary)',
    backgroundColor: 'var(--bg-base)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-sm)',
    padding: '0 8px',
    outline: 'none',
    boxSizing: 'border-box' as const,
  };

  return (
    <DrawerShell
      open={open}
      title="Evolver Config"
      onClose={onClose}
      footer={
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || loading}
          style={{
            height: 28,
            padding: '0 16px',
            backgroundColor: 'var(--accent)',
            color: 'var(--bg-base)',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            fontSize: 12,
            fontWeight: 500,
            cursor: saving || loading ? 'default' : 'pointer',
            opacity: saving || loading ? 0.5 : 1,
          }}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      }
    >
      {loading ? (
        <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>Loading...</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div>
            <SectionLabel>Rewrite threshold</SectionLabel>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={rewriteThreshold}
                onChange={(e) => setRewriteThreshold(Number(e.target.value))}
                style={inputStyle}
              />
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Confidence threshold for rewriting existing skills (0-1)
              </span>
            </div>
          </div>

          <div>
            <SectionLabel>New skill pattern threshold</SectionLabel>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={newSkillPatternThreshold}
                onChange={(e) => setNewSkillPatternThreshold(Number(e.target.value))}
                style={inputStyle}
              />
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Confidence threshold for proposing new skills (0-1)
              </span>
            </div>
          </div>

          <div>
            <SectionLabel>Min runs before evolve</SectionLabel>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
              <input
                type="number"
                min={1}
                step={1}
                value={minRunsBeforeEvolve}
                onChange={(e) => setMinRunsBeforeEvolve(Number(e.target.value))}
                style={inputStyle}
              />
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Minimum evaluation runs before evolution triggers
              </span>
            </div>
          </div>

          <div>
            <SectionLabel>Min pattern count</SectionLabel>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
              <input
                type="number"
                min={1}
                step={1}
                value={minPatternCount}
                onChange={(e) => setMinPatternCount(Number(e.target.value))}
                style={inputStyle}
              />
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Minimum pattern occurrences before proposing a skill
              </span>
            </div>
          </div>

          <div>
            <SectionLabel>Auto-approve evolved skills</SectionLabel>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
              <input
                type="checkbox"
                checked={autoApprove}
                onChange={(e) => setAutoApprove(e.target.checked)}
              />
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Promote proposed skills directly to the live library without manual review
              </span>
            </div>
          </div>
        </div>
      )}
    </DrawerShell>
  );
}

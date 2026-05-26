import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { DrawerShell } from '../../ui/DrawerShell';
import { SectionLabel } from '../../ui/SectionLabel';

interface SkillDetailDrawerProps {
  open: boolean;
  skillId: string | null;
  isNew: boolean;
  port: number;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}

export function SkillDetailDrawer({
  open,
  skillId,
  isNew,
  port,
  onClose,
  onSaved,
  onDeleted,
}: SkillDetailDrawerProps) {
  const client = useMemo(
    () => createEthosClient({ baseUrl: `http://localhost:${port}`, fetch: globalThis.fetch }),
    [port],
  );

  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [source, setSource] = useState('');
  const [saving, setSaving] = useState(false);

  const loadSkill = useCallback(async () => {
    if (!skillId || isNew) return;
    try {
      const res = await client.rpc.skills.get({ id: skillId });
      setId(res.skill.id);
      setName(res.skill.name);
      setDescription(res.skill.description ?? '');
      setBody(res.skill.body);
      setSource(res.skill.source);
    } catch {
      // best-effort
    }
  }, [client, skillId, isNew]);

  useEffect(() => {
    if (open && skillId && !isNew) {
      loadSkill();
    }
    if (open && isNew) {
      setId('');
      setName('');
      setDescription('');
      setBody('');
      setSource('');
    }
  }, [open, skillId, isNew, loadSkill]);

  const handleSave = async () => {
    setSaving(true);
    try {
      if (isNew) {
        await client.rpc.skills.create({ id: id || name.replace(/\s+/g, '-').toLowerCase(), body });
      } else if (skillId) {
        await client.rpc.skills.update({ id: skillId, body });
      }
      onSaved();
      onClose();
    } catch {
      // best-effort
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!skillId) return;
    const confirmed = await window.ethos.dialog.showMessage({
      type: 'warning',
      message: `Delete "${name || skillId}"? This action cannot be undone.`,
      buttons: ['Cancel', 'Delete'],
    });
    if (confirmed.response !== 1) return;
    try {
      await client.rpc.skills.delete({ id: skillId });
      onDeleted();
      onClose();
    } catch {
      // best-effort
    }
  };

  const canSave = isNew ? (id || name).trim().length > 0 : true;

  const footer = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
      }}
    >
      {!isNew && skillId ? (
        <button
          type="button"
          onClick={handleDelete}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 14,
            color: 'var(--error)',
            padding: 0,
          }}
        >
          Delete
        </button>
      ) : (
        <span />
      )}
      <button
        type="button"
        onClick={handleSave}
        disabled={saving || !canSave}
        style={{
          height: 28,
          padding: '0 14px',
          backgroundColor: 'var(--accent)',
          color: 'var(--bg-base)',
          border: 'none',
          borderRadius: 'var(--radius-sm)',
          cursor: saving || !canSave ? 'default' : 'pointer',
          fontSize: 13,
          fontWeight: 500,
          opacity: saving || !canSave ? 0.5 : 1,
        }}
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  );

  const title = isNew ? (
    <input
      type="text"
      value={id}
      onChange={(e) => setId(e.target.value)}
      placeholder="skill-name"
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 14,
        fontWeight: 500,
        color: 'var(--text-primary)',
        background: 'none',
        border: 'none',
        outline: 'none',
        width: '100%',
        padding: 0,
      }}
    />
  ) : (
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 500 }}>
      {name || id}
    </span>
  );

  return (
    <DrawerShell open={open} title={title} onClose={onClose} footer={footer}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Description (read-only display from frontmatter) */}
        {description && (
          <div>
            <SectionLabel>Description</SectionLabel>
            <div
              style={{
                marginTop: 6,
                fontSize: 13,
                color: 'var(--text-secondary)',
                lineHeight: 1.4,
              }}
            >
              {description}
            </div>
          </div>
        )}

        {/* Source badge */}
        {source && (
          <div>
            <SectionLabel>Source</SectionLabel>
            <div
              style={{
                marginTop: 6,
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                color: 'var(--text-secondary)',
              }}
            >
              {source}
            </div>
          </div>
        )}

        {/* Skill body */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <SectionLabel>Skill body</SectionLabel>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--text-tertiary)',
              }}
            >
              {body.length} chars
            </span>
          </div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Skill instructions..."
            style={{
              display: 'block',
              width: '100%',
              minHeight: 200,
              marginTop: 6,
              padding: 16,
              fontFamily: 'var(--font-mono)',
              fontSize: 13,
              lineHeight: 1.5,
              color: 'var(--text-primary)',
              backgroundColor: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              outline: 'none',
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />
        </div>
      </div>
    </DrawerShell>
  );
}

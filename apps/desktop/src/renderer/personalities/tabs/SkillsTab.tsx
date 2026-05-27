import { createEthosClient } from '@ethosagent/sdk';
import type { PersonalitySkill } from '@ethosagent/web-contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';

interface SkillsTabProps {
  personalityId: string | null;
  port: number;
}

const btnStyle: React.CSSProperties = {
  height: 28,
  padding: '0 12px',
  borderRadius: 4,
  border: '1px solid var(--border-subtle)',
  backgroundColor: 'transparent',
  color: 'var(--text-primary)',
  fontSize: 12,
  cursor: 'pointer',
};

interface SkillRowProps {
  skill: PersonalitySkill;
  index: number;
  total: number;
  onEdit: () => void;
  onDelete: () => void;
}

function SkillRow({ skill, index, onEdit, onDelete }: SkillRowProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '10px 12px',
        borderTop: index === 0 ? 'none' : '1px solid var(--border-subtle)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
          {skill.name}
        </div>
        <div
          style={{
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-tertiary)',
            marginTop: 2,
          }}
        >
          {skill.id}.md
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <button type="button" onClick={onEdit} style={btnStyle}>
          Edit
        </button>
        <button type="button" onClick={onDelete} style={btnStyle}>
          Delete
        </button>
      </div>
    </div>
  );
}

interface CreateSkillFormProps {
  personalityId: string;
  client: ReturnType<typeof createEthosClient>;
  onSaved: () => void;
  onCancel: () => void;
}

function CreateSkillForm({ personalityId, client, onSaved, onCancel }: CreateSkillFormProps) {
  const [skillId, setSkillId] = useState('');
  const [body, setBody] = useState(
    '---\nname: my-skill\ndescription: One-line summary\n---\n\nWrite the skill body here.\n',
  );
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    if (!skillId.trim()) return;
    setSaving(true);
    try {
      await client.rpc.personalities.skillsCreate({ personalityId, skillId: skillId.trim(), body });
      onSaved();
    } catch {
      // best-effort
    } finally {
      setSaving(false);
    }
  }, [personalityId, skillId, body, client, onSaved]);

  return (
    <div
      style={{
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-sm)',
        backgroundColor: 'var(--bg-elevated)',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <input
        type="text"
        placeholder="Skill ID (e.g. my-skill)"
        value={skillId}
        onChange={(e) => setSkillId(e.target.value)}
        style={{
          height: 28,
          padding: '0 8px',
          borderRadius: 4,
          border: '1px solid var(--border-subtle)',
          backgroundColor: 'var(--bg-base)',
          color: 'var(--text-primary)',
          fontSize: 13,
          outline: 'none',
        }}
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={10}
        style={{
          padding: 8,
          borderRadius: 4,
          border: '1px solid var(--border-subtle)',
          backgroundColor: 'var(--bg-base)',
          color: 'var(--text-primary)',
          fontSize: 12,
          fontFamily: 'var(--font-mono)',
          resize: 'vertical',
          outline: 'none',
        }}
      />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onCancel} style={btnStyle}>
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !skillId.trim()}
          style={btnStyle}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}

interface EditSkillDrawerProps {
  personalityId: string;
  skill: PersonalitySkill;
  port: number;
  onSaved: () => void;
  onClose: () => void;
}

function EditSkillDrawer({ personalityId, skill, port, onSaved, onClose }: EditSkillDrawerProps) {
  const client = useMemo(
    () => createEthosClient({ baseUrl: `http://localhost:${port}`, fetch: globalThis.fetch }),
    [port],
  );
  const [body, setBody] = useState(skill.body);
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await client.rpc.personalities.skillsUpdate({ personalityId, skillId: skill.id, body });
      onSaved();
    } catch {
      // best-effort
    } finally {
      setSaving(false);
    }
  }, [personalityId, skill.id, body, client, onSaved]);

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: overlay backdrop close */}
      <div
        role="button"
        tabIndex={-1}
        onClick={onClose}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClose();
          }
        }}
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.3)',
          zIndex: 999,
        }}
      />
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 480,
          backgroundColor: 'var(--bg-elevated)',
          borderLeft: '1px solid var(--border-subtle)',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 1000,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            height: 40,
            padding: '0 16px',
            flexShrink: 0,
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <span
            style={{
              fontSize: 14,
              fontWeight: 500,
              color: 'var(--text-primary)',
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            Edit {skill.name}
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: 18,
              color: 'var(--text-tertiary)',
              padding: 0,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={16}
            style={{
              width: '100%',
              padding: 8,
              borderRadius: 4,
              border: '1px solid var(--border-subtle)',
              backgroundColor: 'var(--bg-base)',
              color: 'var(--text-primary)',
              fontSize: 12,
              fontFamily: 'var(--font-mono)',
              resize: 'vertical',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>
        <div
          style={{
            height: 40,
            padding: '0 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 8,
            borderTop: '1px solid var(--border-subtle)',
            flexShrink: 0,
          }}
        >
          <button type="button" onClick={onClose} style={btnStyle}>
            Cancel
          </button>
          <button type="button" onClick={handleSave} disabled={saving} style={btnStyle}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </>
  );
}

interface ImportSkillsDrawerProps {
  personalityId: string;
  existingIds: Set<string>;
  port: number;
  onSaved: () => void;
  onClose: () => void;
}

function ImportSkillsDrawer({
  personalityId,
  existingIds,
  port,
  onSaved,
  onClose,
}: ImportSkillsDrawerProps) {
  const client = useMemo(
    () => createEthosClient({ baseUrl: `http://localhost:${port}`, fetch: globalThis.fetch }),
    [port],
  );
  const [globalSkills, setGlobalSkills] = useState<Array<{ id: string; name: string }>>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await client.rpc.skills.list();
        if (!cancelled) {
          setGlobalSkills(res.skills.filter((s) => !existingIds.has(s.id)));
        }
      } catch {
        // best-effort
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [client, existingIds]);

  const handleToggle = useCallback((id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const handleImport = useCallback(async () => {
    if (selected.size === 0) return;
    setImporting(true);
    try {
      await client.rpc.personalities.skillsImportGlobal({
        personalityId,
        skillIds: Array.from(selected),
      });
      onSaved();
    } catch {
      // best-effort
    } finally {
      setImporting(false);
    }
  }, [personalityId, selected, client, onSaved]);

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: overlay backdrop close */}
      <div
        role="button"
        tabIndex={-1}
        onClick={onClose}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClose();
          }
        }}
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.3)',
          zIndex: 999,
        }}
      />
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 480,
          backgroundColor: 'var(--bg-elevated)',
          borderLeft: '1px solid var(--border-subtle)',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 1000,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            height: 40,
            padding: '0 16px',
            flexShrink: 0,
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <span
            style={{
              fontSize: 14,
              fontWeight: 500,
              color: 'var(--text-primary)',
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            Import from global library
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: 18,
              color: 'var(--text-tertiary)',
              padding: 0,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          {loading ? (
            <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Loading...</span>
          ) : globalSkills.length === 0 ? (
            <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
              No importable skills found.
            </span>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {globalSkills.map((skill) => (
                <label
                  key={skill.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(skill.id)}
                    onChange={(e) => handleToggle(skill.id, e.target.checked)}
                  />
                  <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{skill.name}</span>
                  <span
                    style={{
                      fontSize: 11,
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--text-tertiary)',
                    }}
                  >
                    {skill.id}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
        <div
          style={{
            height: 40,
            padding: '0 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 8,
            borderTop: '1px solid var(--border-subtle)',
            flexShrink: 0,
          }}
        >
          <button type="button" onClick={onClose} style={btnStyle}>
            Cancel
          </button>
          <button
            type="button"
            onClick={handleImport}
            disabled={importing || selected.size === 0}
            style={btnStyle}
          >
            {importing ? 'Importing...' : 'Import'}
          </button>
        </div>
      </div>
    </>
  );
}

export function SkillsTab({ personalityId, port }: SkillsTabProps) {
  const client = useMemo(
    () => createEthosClient({ baseUrl: `http://localhost:${port}`, fetch: globalThis.fetch }),
    [port],
  );

  const [skills, setSkills] = useState<PersonalitySkill[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<PersonalitySkill | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const reload = useCallback(async () => {
    if (!personalityId) return;
    setLoading(true);
    try {
      const res = await client.rpc.personalities.skillsList({ personalityId });
      setSkills(res.skills);
    } catch {
      // best-effort
    } finally {
      setLoading(false);
    }
  }, [personalityId, client]);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleDelete = useCallback(
    async (skill: PersonalitySkill) => {
      if (!personalityId) return;
      try {
        const result = await window.ethos.dialog.showMessage({
          type: 'warning',
          title: 'Delete Skill',
          message: `Are you sure you want to delete "${skill.name}"?`,
          buttons: ['Cancel', 'Delete'],
        });
        if (result.response === 1) {
          await client.rpc.personalities.skillsDelete({ personalityId, skillId: skill.id });
          reload();
        }
      } catch {
        // best-effort
      }
    },
    [personalityId, client, reload],
  );

  if (!personalityId) {
    return (
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
        Save this personality first to manage its skills.
      </div>
    );
  }

  if (loading && skills.length === 0) {
    return <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Loading skills...</span>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" onClick={() => setImportOpen(true)} style={btnStyle}>
          Import from global
        </button>
        <button type="button" onClick={() => setCreating(true)} style={btnStyle}>
          New skill
        </button>
      </div>

      {skills.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
          No skills for this personality yet.
        </div>
      ) : (
        <div
          style={{
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-sm)',
            overflow: 'hidden',
          }}
        >
          {skills.map((skill, i) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              index={i}
              total={skills.length}
              onEdit={() => setEditing(skill)}
              onDelete={() => handleDelete(skill)}
            />
          ))}
        </div>
      )}

      {creating && (
        <CreateSkillForm
          personalityId={personalityId}
          client={client}
          onSaved={() => {
            setCreating(false);
            reload();
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      {editing && (
        <EditSkillDrawer
          personalityId={personalityId}
          skill={editing}
          port={port}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
          onClose={() => setEditing(null)}
        />
      )}

      {importOpen && (
        <ImportSkillsDrawer
          personalityId={personalityId}
          existingIds={new Set(skills.map((s) => s.id))}
          port={port}
          onSaved={() => {
            setImportOpen(false);
            reload();
          }}
          onClose={() => setImportOpen(false)}
        />
      )}
    </div>
  );
}

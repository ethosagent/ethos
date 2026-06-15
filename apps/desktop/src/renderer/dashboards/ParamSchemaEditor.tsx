import { useEffect, useState } from 'react';
import { DrawerShell } from '../ui/DrawerShell';
import type { ParamDef } from './types';

interface ParamSchemaEditorProps {
  open: boolean;
  schema: ParamDef[];
  onClose: () => void;
  onSave: (schema: ParamDef[]) => void;
}

interface EditableRow {
  uid: string;
  key: string;
  label: string;
  type: ParamDef['type'];
  optionsText: string;
  default: string;
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 28,
  fontSize: 12,
  backgroundColor: 'var(--bg-base)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 4,
  color: 'var(--text-primary)',
  padding: '0 8px',
  boxSizing: 'border-box',
};

const rowLabelStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-tertiary)',
  marginBottom: 2,
  display: 'block',
};

export function ParamSchemaEditor({ open, schema, onClose, onSave }: ParamSchemaEditorProps) {
  const [rows, setRows] = useState<EditableRow[]>([]);

  useEffect(() => {
    if (!open) return;
    setRows(
      schema.map((def) => ({
        uid: crypto.randomUUID(),
        key: def.key,
        label: def.label,
        type: def.type,
        optionsText: (def.options ?? []).join(', '),
        default: def.default,
      })),
    );
  }, [open, schema]);

  const updateRow = (uid: string, patch: Partial<EditableRow>) => {
    setRows((prev) => prev.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  };

  const removeRow = (uid: string) => {
    setRows((prev) => prev.filter((r) => r.uid !== uid));
  };

  const addRow = () => {
    setRows((prev) => [
      ...prev,
      {
        uid: crypto.randomUUID(),
        key: '',
        label: '',
        type: 'select',
        optionsText: '',
        default: '',
      },
    ]);
  };

  const handleSave = () => {
    const result: ParamDef[] = rows
      .filter((r) => r.key.trim() !== '' && r.label.trim() !== '')
      .map((r) => {
        const options = r.optionsText
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const def: ParamDef = {
          key: r.key.trim(),
          label: r.label.trim(),
          type: r.type,
          default: r.default,
        };
        if (r.type !== 'date-range' && options.length > 0) {
          def.options = options;
        }
        return def;
      });
    onSave(result);
  };

  const footer = (
    <button
      type="button"
      onClick={handleSave}
      style={{
        height: 28,
        padding: '0 12px',
        background: 'none',
        border: '1px solid var(--accent)',
        borderRadius: 4,
        cursor: 'pointer',
        fontSize: 13,
        color: 'var(--text-primary)',
      }}
    >
      Save
    </button>
  );

  return (
    <DrawerShell open={open} title="Parameters" onClose={onClose} footer={footer}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {rows.map((row) => (
          <div
            key={row.uid}
            style={{
              border: '1px solid var(--border-subtle)',
              borderRadius: 8,
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                title="Remove"
                onClick={() => removeRow(row.uid)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 16,
                  color: 'var(--text-tertiary)',
                  padding: 0,
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </div>
            <div>
              <span style={rowLabelStyle}>Key</span>
              <input
                value={row.key}
                onChange={(e) => updateRow(row.uid, { key: e.target.value })}
                style={inputStyle}
              />
            </div>
            <div>
              <span style={rowLabelStyle}>Label</span>
              <input
                value={row.label}
                onChange={(e) => updateRow(row.uid, { label: e.target.value })}
                style={inputStyle}
              />
            </div>
            <div>
              <span style={rowLabelStyle}>Type</span>
              <select
                value={row.type}
                onChange={(e) => updateRow(row.uid, { type: e.target.value as ParamDef['type'] })}
                style={inputStyle}
              >
                <option value="select">select</option>
                <option value="options">options</option>
                <option value="date-range">date-range</option>
              </select>
            </div>
            {(row.type === 'select' || row.type === 'options') && (
              <div>
                <span style={rowLabelStyle}>Options (comma-separated)</span>
                <input
                  value={row.optionsText}
                  onChange={(e) => updateRow(row.uid, { optionsText: e.target.value })}
                  style={inputStyle}
                />
              </div>
            )}
            <div>
              <span style={rowLabelStyle}>Default</span>
              <input
                value={row.default}
                onChange={(e) => updateRow(row.uid, { default: e.target.value })}
                style={inputStyle}
              />
            </div>
          </div>
        ))}
        <button
          type="button"
          onClick={addRow}
          style={{
            height: 28,
            padding: '0 12px',
            background: 'none',
            border: '1px solid var(--border-subtle)',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 13,
            color: 'var(--text-secondary)',
          }}
        >
          Add parameter
        </button>
      </div>
    </DrawerShell>
  );
}

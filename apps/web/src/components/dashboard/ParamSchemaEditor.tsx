import { Button, Input, Modal, Select, Space } from 'antd';
import { useEffect, useRef, useState } from 'react';

interface ParamDef {
  key: string;
  label: string;
  type: 'select' | 'options' | 'date-range';
  options?: string[];
  default: string;
}

interface InternalDef extends ParamDef {
  _uid: number;
}

interface Props {
  open: boolean;
  schema: ParamDef[];
  onCancel: () => void;
  onSave: (schema: ParamDef[]) => void;
}

export function ParamSchemaEditor({ open, schema, onCancel, onSave }: Props) {
  const [defs, setDefs] = useState<InternalDef[]>([]);
  const uidRef = useRef(0);

  useEffect(() => {
    if (open) {
      setDefs(
        schema.map((d) => ({
          ...d,
          options: d.options ? [...d.options] : [],
          _uid: ++uidRef.current,
        })),
      );
    }
  }, [open, schema]);

  function updateDef(index: number, patch: Partial<ParamDef>) {
    setDefs((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  }

  function addDef() {
    setDefs((prev) => [
      ...prev,
      { key: '', label: '', type: 'select', options: [], default: '', _uid: ++uidRef.current },
    ]);
  }

  function removeDef(index: number) {
    setDefs((prev) => prev.filter((_, i) => i !== index));
  }

  return (
    <Modal
      open={open}
      title="Edit Dashboard Parameters"
      onCancel={onCancel}
      onOk={() => onSave(defs.filter((d) => d.key && d.label).map(({ _uid: _, ...rest }) => rest))}
      okText="Save"
      width={600}
      destroyOnClose
    >
      <div style={{ maxHeight: 400, overflowY: 'auto' }}>
        {defs.map((def, i) => (
          <div
            key={def._uid}
            style={{
              border: '1px solid #f0f0f0',
              borderRadius: 'var(--border-radius-md, 6px)',
              padding: 12,
              marginBottom: 12,
            }}
          >
            <Space direction="vertical" style={{ width: '100%' }} size={8}>
              <Space>
                <Input
                  size="small"
                  placeholder="Key"
                  value={def.key}
                  onChange={(e) => updateDef(i, { key: e.target.value })}
                  style={{ width: 120 }}
                />
                <Input
                  size="small"
                  placeholder="Label"
                  value={def.label}
                  onChange={(e) => updateDef(i, { label: e.target.value })}
                  style={{ width: 140 }}
                />
                <Select
                  size="small"
                  value={def.type}
                  onChange={(val: 'select' | 'options' | 'date-range') =>
                    updateDef(i, { type: val })
                  }
                  style={{ width: 120 }}
                  options={[
                    { label: 'Dropdown', value: 'select' },
                    { label: 'Options', value: 'options' },
                    { label: 'Date Range', value: 'date-range' },
                  ]}
                />
                <Button size="small" danger onClick={() => removeDef(i)}>
                  x
                </Button>
              </Space>
              {(def.type === 'select' || def.type === 'options') && (
                <Input
                  size="small"
                  placeholder="Options (comma-separated)"
                  value={(def.options ?? []).join(', ')}
                  onChange={(e) =>
                    updateDef(i, {
                      options: e.target.value
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                />
              )}
              <Input
                size="small"
                placeholder={
                  def.type === 'date-range' ? 'Default: YYYY-MM-DD,YYYY-MM-DD' : 'Default value'
                }
                value={def.default}
                onChange={(e) => updateDef(i, { default: e.target.value })}
              />
            </Space>
          </div>
        ))}
      </div>
      <Button type="dashed" onClick={addDef} block style={{ marginTop: 8 }}>
        + Add Parameter
      </Button>
    </Modal>
  );
}

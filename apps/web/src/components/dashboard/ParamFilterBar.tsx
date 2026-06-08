import { DatePicker, Segmented, Select, Space, Tag } from 'antd';
import dayjs from 'dayjs';

interface ParamDef {
  key: string;
  label: string;
  type: 'select' | 'options' | 'date-range';
  options?: string[];
  default: string;
}

interface Props {
  schema: ParamDef[];
  persistent: Record<string, string>;
  ephemeral: Record<string, string>;
  onPersistentChange: (key: string, value: string) => void;
  onEphemeralClear: (key: string) => void;
}

export function ParamFilterBar({
  schema,
  persistent,
  ephemeral,
  onPersistentChange,
  onEphemeralClear,
}: Props) {
  if (schema.length === 0 && Object.keys(ephemeral).length === 0) return null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginBottom: 16,
        flexWrap: 'wrap',
      }}
    >
      {schema.map((def) => {
        switch (def.type) {
          case 'select':
            return (
              <Space key={def.key} size={4}>
                <span style={{ fontSize: 12, color: '#888' }}>{def.label}:</span>
                <Select
                  size="small"
                  style={{ minWidth: 120 }}
                  value={persistent[def.key] ?? def.default}
                  options={(def.options ?? []).map((o) => ({ label: o, value: o }))}
                  onChange={(val: string) => onPersistentChange(def.key, val)}
                />
              </Space>
            );
          case 'options':
            return (
              <Space key={def.key} size={4}>
                <span style={{ fontSize: 12, color: '#888' }}>{def.label}:</span>
                <Segmented
                  size="small"
                  options={def.options ?? []}
                  value={persistent[def.key] ?? def.default}
                  onChange={(val) => onPersistentChange(def.key, String(val))}
                />
              </Space>
            );
          case 'date-range': {
            const fromKey = `${def.key}_from`;
            const toKey = `${def.key}_to`;
            const defaults = def.default.split(',');
            const fromVal = persistent[fromKey] ?? defaults[0] ?? '';
            const toVal = persistent[toKey] ?? defaults[1] ?? '';
            return (
              <Space key={def.key} size={4}>
                <span style={{ fontSize: 12, color: '#888' }}>{def.label}:</span>
                <DatePicker.RangePicker
                  size="small"
                  value={fromVal && toVal ? [dayjs(fromVal), dayjs(toVal)] : undefined}
                  onChange={(dates) => {
                    if (dates?.[0] && dates[1]) {
                      onPersistentChange(fromKey, dates[0].format('YYYY-MM-DD'));
                      onPersistentChange(toKey, dates[1].format('YYYY-MM-DD'));
                    }
                  }}
                />
              </Space>
            );
          }
          default:
            return null;
        }
      })}
      {Object.entries(ephemeral).map(([key, value]) => (
        <Tag key={key} closable onClose={() => onEphemeralClear(key)} style={{ fontSize: 11 }}>
          {key}: {value}
        </Tag>
      ))}
    </div>
  );
}

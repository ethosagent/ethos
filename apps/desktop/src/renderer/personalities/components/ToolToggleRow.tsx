import { Toggle } from '../../ui/Toggle';

interface ToolToggleRowProps {
  name: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function ToolToggleRow({ name, description, checked, onChange }: ToolToggleRowProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 36,
        borderBottom: '1px solid var(--border-subtle)',
        padding: '0 12px',
        gap: 12,
      }}
    >
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
          color: 'var(--text-primary)',
          flexShrink: 0,
        }}
      >
        {name}
      </span>
      {description && (
        <span
          style={{
            flex: 1,
            fontSize: 12,
            color: 'var(--text-secondary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {description}
        </span>
      )}
      {!description && <span style={{ flex: 1 }} />}
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );
}

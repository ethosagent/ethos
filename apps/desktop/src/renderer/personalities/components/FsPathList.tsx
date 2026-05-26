import { useCallback, useState } from 'react';

interface FsPathListProps {
  label: string;
  paths: string[];
  onChange: (paths: string[]) => void;
}

export function FsPathList({ label, paths, onChange }: FsPathListProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const removePath = useCallback(
    (index: number) => {
      onChange(paths.filter((_, i) => i !== index));
    },
    [paths, onChange],
  );

  const addPath = useCallback(async () => {
    try {
      const result = await window.ethos.dialog.showOpen({ properties: ['openDirectory'] });
      if (!result.canceled && result.filePaths.length > 0) {
        const selected = result.filePaths[0];
        if (selected && !paths.includes(selected)) {
          onChange([...paths, selected]);
        }
      }
    } catch {
      // user cancelled
    }
  }, [paths, onChange]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span
        style={{
          fontSize: 11,
          fontWeight: 500,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--text-tertiary)',
        }}
      >
        {label}
      </span>
      {paths.map((p, i) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: hover container for styling only
        <div
          key={p}
          onMouseEnter={() => setHoveredIndex(i)}
          onMouseLeave={() => setHoveredIndex(null)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '4px 0',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--text-secondary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
            }}
          >
            {p}
          </span>
          <button
            type="button"
            onClick={() => removePath(i)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: hoveredIndex === i ? 'var(--error)' : 'var(--text-tertiary)',
              fontSize: 14,
              padding: '0 4px',
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addPath}
        style={{
          background: 'none',
          border: '1px dashed var(--border-subtle)',
          borderRadius: 4,
          padding: '6px 12px',
          fontSize: 12,
          color: 'var(--text-secondary)',
          cursor: 'pointer',
          alignSelf: 'flex-start',
          marginTop: 4,
        }}
      >
        Add path
      </button>
    </div>
  );
}

import { type DragEvent, useCallback, useRef, useState } from 'react';

interface FileDropZoneProps {
  label?: string;
  fileName?: string | null;
  fileSize?: number | null;
  onFile: (content: string, name: string, size: number) => void;
  onClear?: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileDropZone({ label, fileName, fileSize, onFile, onClear }: FileDropZoneProps) {
  const [hovering, setHovering] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const readFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          onFile(reader.result, file.name, file.size);
        }
      };
      reader.readAsText(file);
    },
    [onFile],
  );

  const handleBrowse = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) readFile(file);
    },
    [readFile],
  );

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setHovering(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setHovering(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setHovering(false);
      const file = e.dataTransfer.files[0];
      if (file) readFile(file);
    },
    [readFile],
  );

  return (
    <div>
      {label && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            fontWeight: 500,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: 'var(--text-tertiary)',
            marginBottom: 6,
          }}
        >
          {label}
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept=".jsonl"
        onChange={handleInputChange}
        style={{ display: 'none' }}
      />
      {fileName ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 12px',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--bg-elevated)',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                color: 'var(--text-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {fileName}
            </span>
            {fileSize != null && (
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--text-tertiary)',
                }}
              >
                {formatSize(fileSize)}
              </span>
            )}
          </div>
          {onClear && (
            <button
              type="button"
              onClick={onClear}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-tertiary)',
                fontSize: 18,
                cursor: 'pointer',
                padding: '0 4px',
                lineHeight: 1,
              }}
            >
              &times;
            </button>
          )}
        </div>
      ) : (
        <button
          type="button"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={handleBrowse}
          style={{
            width: '100%',
            borderRadius: 'var(--radius-md)',
            border: hovering ? '2px dashed var(--blue)' : '2px dashed var(--border-strong)',
            background: hovering ? 'rgba(74,158,255,0.05)' : 'transparent',
            padding: '32px 16px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 4,
            cursor: 'pointer',
            transition:
              'border-color var(--motion-fast) var(--ease), background var(--motion-fast) var(--ease)',
            boxSizing: 'border-box',
          }}
        >
          <span style={{ fontSize: 20, color: 'var(--text-tertiary)' }}>&#8593;</span>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            Drop a JSONL file or click to upload
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
            One JSON object per line
          </span>
        </button>
      )}
    </div>
  );
}

import { type DragEvent, useCallback, useRef, useState } from 'react';

interface FileDropZoneProps {
  label?: string;
  onFile: (content: string) => void;
}

export function FileDropZone({ label, onFile }: FileDropZoneProps) {
  const [hovering, setHovering] = useState(false);
  const [preview, setPreview] = useState<string[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFileContent = useCallback(
    (text: string) => {
      const lines = text.split('\n').filter(Boolean);
      setPreview(lines.slice(0, 3));
      onFile(text);
    },
    [onFile],
  );

  const readFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          handleFileContent(reader.result);
        }
      };
      reader.readAsText(file);
    },
    [handleFileContent],
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
            fontSize: 11,
            fontWeight: 600,
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
      <button
        type="button"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleBrowse}
        style={{
          width: '100%',
          height: 80,
          borderRadius: 8,
          border: hovering ? '1px dashed var(--info)' : '1px dashed var(--border-strong)',
          background: hovering ? 'var(--bg-elevated)' : 'transparent',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
          cursor: 'pointer',
          transition:
            'border var(--motion-fast) var(--ease), background var(--motion-fast) var(--ease)',
          boxSizing: 'border-box',
        }}
      >
        <span style={{ fontSize: 16, color: 'var(--text-tertiary)' }}>&#9636;</span>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          Drop a .jsonl file here, or{' '}
          <span style={{ color: 'var(--info)', textDecoration: 'none' }}>browse</span>
        </span>
      </button>
      {preview && (
        <pre
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            background: 'var(--bg-elevated)',
            borderRadius: 8,
            padding: 12,
            marginTop: 12,
            overflow: 'auto',
            color: 'var(--text-secondary)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {preview.join('\n')}
        </pre>
      )}
    </div>
  );
}

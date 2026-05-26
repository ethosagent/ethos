interface JobOutputTabProps {
  jobName: string;
  ranAt: string;
  output: string;
}

export function JobOutputTab({ jobName, ranAt, output }: JobOutputTabProps) {
  const formattedDate = new Date(ranAt).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  const handleDownload = async () => {
    try {
      const filename = `${jobName.replace(/\s+/g, '-').toLowerCase()}-${ranAt}.txt`;
      await window.ethos.file.save({ defaultName: filename, content: output });
    } catch {
      // best-effort
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 0',
        }}
      >
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Run: {formattedDate}</span>
        <button
          type="button"
          onClick={handleDownload}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 12,
            color: 'var(--info)',
            padding: 0,
          }}
        >
          Download output
        </button>
      </div>
      <pre
        style={{
          flex: 1,
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          color: 'var(--text-primary)',
          backgroundColor: 'var(--bg-elevated)',
          borderRadius: 8,
          padding: '12px 16px',
          overflow: 'auto',
          margin: 0,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {output}
      </pre>
    </div>
  );
}

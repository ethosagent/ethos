interface PluginRowProps {
  plugin: {
    id: string;
    name: string;
    version: string;
    description: string | null;
    source: 'user' | 'project' | 'npm';
    path: string;
    pluginContractMajor: number | null;
  };
}

export function PluginRow({ plugin }: PluginRowProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 40,
        padding: '0 12px',
        borderBottom: '1px solid var(--border-subtle)',
        gap: 8,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: 'var(--text-primary)',
          }}
        >
          {plugin.name}
        </span>
        {plugin.description && (
          <div
            style={{
              fontSize: 12,
              color: 'var(--text-tertiary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {plugin.description}
          </div>
        )}
      </div>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--text-tertiary)',
        }}
      >
        v{plugin.version}
      </span>
      <span
        style={{
          fontSize: 11,
          color: 'var(--text-tertiary)',
        }}
      >
        {plugin.source}
      </span>
    </div>
  );
}

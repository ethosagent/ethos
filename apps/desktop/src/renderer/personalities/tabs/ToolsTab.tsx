import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useServerUrl } from '../../shell/ServerUrl';
import { ToolToggleRow } from '../components/ToolToggleRow';

interface ToolGroup {
  group: string;
  tools: Array<{ name: string; description?: string }>;
}

interface ToolsTabProps {
  toolset: string[];
  onChange: (toolset: string[]) => void;
}

export function ToolsTab({ toolset, onChange }: ToolsTabProps) {
  const baseUrl = useServerUrl();
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [groups, setGroups] = useState<ToolGroup[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await client.rpc.tools.catalog({});
        if (!cancelled) setGroups(res.groups);
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
  }, [client]);

  const toolsetSet = useMemo(() => new Set(toolset), [toolset]);

  const handleToggle = useCallback(
    (name: string, checked: boolean) => {
      if (checked) {
        onChange([...toolset, name]);
      } else {
        onChange(toolset.filter((t) => t !== name));
      }
    },
    [toolset, onChange],
  );

  const handleEnableAll = useCallback(
    (group: ToolGroup) => {
      const groupNames = group.tools.map((t) => t.name);
      const existing = new Set(toolset);
      for (const n of groupNames) existing.add(n);
      onChange(Array.from(existing));
    },
    [toolset, onChange],
  );

  const handleDisableAll = useCallback(
    (group: ToolGroup) => {
      const groupNames = new Set(group.tools.map((t) => t.name));
      onChange(toolset.filter((t) => !groupNames.has(t)));
    },
    [toolset, onChange],
  );

  if (loading) {
    return (
      <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Loading tool catalog...</span>
    );
  }

  if (groups.length === 0) {
    return <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>No tools available.</span>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {groups.map((group) => (
        <div key={group.group}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 4,
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 500,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: 'var(--text-tertiary)',
              }}
            >
              {group.group}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={() => handleEnableAll(group)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                  padding: 0,
                }}
              >
                Enable all
              </button>
              <button
                type="button"
                onClick={() => handleDisableAll(group)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                  padding: 0,
                }}
              >
                Disable all
              </button>
            </div>
          </div>
          <div
            style={{
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-sm)',
              overflow: 'hidden',
            }}
          >
            {group.tools.map((tool) => (
              <ToolToggleRow
                key={tool.name}
                name={tool.name}
                description={tool.description}
                checked={toolsetSet.has(tool.name)}
                onChange={(checked) => handleToggle(tool.name, checked)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

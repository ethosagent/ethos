import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useMemo, useState } from 'react';
import { Toggle } from '../../ui/Toggle';
import { McpServerAttachPicker } from '../components/McpServerAttachPicker';

interface McpToolEntry {
  name: string;
  description?: string;
}

interface MCPTabProps {
  mcpServers: string[];
  mcpTools: Record<string, string[]>;
  onChange: (servers: string[], tools: Record<string, string[]>) => void;
  port: number;
  personalityId: string;
}

export function MCPTab({ mcpServers, mcpTools, onChange, port, personalityId }: MCPTabProps) {
  const client = useMemo(
    () => createEthosClient({ baseUrl: `http://localhost:${port}`, fetch: globalThis.fetch }),
    [port],
  );

  const [expanded, setExpanded] = useState<string | null>(null);
  const [serverToolsCache, setServerToolsCache] = useState<Record<string, McpToolEntry[]>>({});
  const [loadingTools, setLoadingTools] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);

  const toggleExpand = useCallback(
    async (serverName: string) => {
      if (expanded === serverName) {
        setExpanded(null);
        return;
      }
      setExpanded(serverName);

      if (!serverToolsCache[serverName]) {
        setLoadingTools(serverName);
        try {
          const res = await client.rpc.mcp.serverTools({
            personalityId,
            serverName,
          });
          setServerToolsCache((prev) => ({ ...prev, [serverName]: res.tools }));
        } catch {
          setServerToolsCache((prev) => ({ ...prev, [serverName]: [] }));
        } finally {
          setLoadingTools(null);
        }
      }
    },
    [expanded, serverToolsCache, client, personalityId],
  );

  const handleRemoveServer = useCallback(
    (serverName: string) => {
      const next = mcpServers.filter((s) => s !== serverName);
      const nextTools = { ...mcpTools };
      delete nextTools[serverName];
      onChange(next, nextTools);
    },
    [mcpServers, mcpTools, onChange],
  );

  const handleAttach = useCallback(
    (servers: string[]) => {
      onChange(servers, mcpTools);
    },
    [mcpTools, onChange],
  );

  const handleToolToggle = useCallback(
    (serverName: string, toolName: string, checked: boolean) => {
      const currentTools = mcpTools[serverName] ?? [];
      const allServerTools = serverToolsCache[serverName] ?? [];
      const allNames = allServerTools.map((t) => t.name);

      let nextTools: string[];
      if (checked) {
        nextTools = [...currentTools, toolName];
      } else {
        nextTools = currentTools.filter((t) => t !== toolName);
      }

      const nextRecord = { ...mcpTools };
      if (nextTools.length === 0 || nextTools.length === allNames.length) {
        delete nextRecord[serverName];
      } else {
        nextRecord[serverName] = nextTools;
      }
      onChange(mcpServers, nextRecord);
    },
    [mcpServers, mcpTools, serverToolsCache, onChange],
  );

  const isToolEnabled = useCallback(
    (serverName: string, toolName: string): boolean => {
      const subset = mcpTools[serverName];
      if (!subset) return true;
      return subset.includes(toolName);
    },
    [mcpTools],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {mcpServers.length === 0 ? (
        <span style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '16px 0' }}>
          No MCP servers attached. Click below to attach one.
        </span>
      ) : (
        <div
          style={{
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-sm)',
            overflow: 'hidden',
          }}
        >
          {mcpServers.map((serverName) => {
            const isExpanded = expanded === serverName;
            const tools = serverToolsCache[serverName];
            const isLoading = loadingTools === serverName;
            const toolCount = tools ? tools.length : '...';

            return (
              <div key={serverName}>
                {/* biome-ignore lint/a11y/useSemanticElements: custom styled expandable server row */}
                <div
                  role="button"
                  tabIndex={0}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    height: 40,
                    padding: '0 12px',
                    borderBottom: '1px solid var(--border-subtle)',
                    cursor: 'pointer',
                    gap: 8,
                  }}
                  onClick={() => toggleExpand(serverName)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleExpand(serverName);
                    }
                  }}
                >
                  <span
                    style={{
                      fontSize: 12,
                      color: 'var(--text-tertiary)',
                      transition: 'transform var(--motion-fast) var(--ease)',
                      transform: isExpanded ? 'rotate(90deg)' : 'rotate(0)',
                      display: 'inline-block',
                    }}
                  >
                    ▶
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 13,
                      color: 'var(--text-primary)',
                      flex: 1,
                    }}
                  >
                    {serverName}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      color: 'var(--text-tertiary)',
                    }}
                  >
                    {toolCount} tools
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRemoveServer(serverName);
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--text-tertiary)',
                      fontSize: 14,
                      padding: '0 4px',
                    }}
                  >
                    ×
                  </button>
                </div>

                {isExpanded && (
                  <div style={{ padding: '0 12px 8px 28px' }}>
                    {isLoading ? (
                      <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                        Loading tools...
                      </span>
                    ) : tools && tools.length > 0 ? (
                      tools.map((tool) => (
                        <div
                          key={tool.name}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            height: 28,
                          }}
                        >
                          <Toggle
                            checked={isToolEnabled(serverName, tool.name)}
                            onChange={(checked) => handleToolToggle(serverName, tool.name, checked)}
                          />
                          <span
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: 12,
                              color: 'var(--text-primary)',
                            }}
                          >
                            {tool.name}
                          </span>
                          {tool.description && (
                            <span
                              style={{
                                fontSize: 11,
                                color: 'var(--text-tertiary)',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                flex: 1,
                              }}
                            >
                              {tool.description}
                            </span>
                          )}
                        </div>
                      ))
                    ) : (
                      <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                        No tools exposed.
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ position: 'relative', alignSelf: 'flex-start' }}>
        <button
          type="button"
          onClick={() => setShowPicker((v) => !v)}
          style={{
            background: 'none',
            border: '1px dashed var(--border-subtle)',
            borderRadius: 4,
            padding: '6px 12px',
            fontSize: 12,
            color: 'var(--text-secondary)',
            cursor: 'pointer',
          }}
        >
          Attach server
        </button>
        {showPicker && (
          <McpServerAttachPicker
            attachedServers={mcpServers}
            onAttach={handleAttach}
            port={port}
            onClose={() => setShowPicker(false)}
          />
        )}
      </div>
    </div>
  );
}

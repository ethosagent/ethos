import type { McpPolicy } from '@ethosagent/web-contracts';
import { Button, Spin, Tag, Typography } from 'antd';
import { useCallback, useRef, useState } from 'react';
import { rpc } from '../../rpc';

// ---------------------------------------------------------------------------
// MCP servers panel — checkbox list of all configured MCP servers, each with
// a per-server tool checklist (loaded from the personality's mcp.yaml).
// Saves via personalities.update({ mcp_servers, mcp_tools }).
// ---------------------------------------------------------------------------

// Per-server tool selection state held in the parent so Save can build the
// `mcp_tools` payload. `tools` is the set of discovered tool names; `null`
// means tools have not been discovered yet (or the server is unreachable).
export type ServerToolState = {
  /** All bare tool names the server exposes, or null when undiscovered. */
  tools: string[] | null;
  /** Currently-checked bare tool names. */
  selected: Set<string>;
};

// A server with no `tools` entry in mcp.yaml = all tools allowed.
export function initialSelectionFor(
  serverName: string,
  policy: McpPolicy | null,
): string[] | undefined {
  return policy?.servers?.[serverName]?.tools;
}

export function ServerToolChecklist({
  personalityId,
  serverName,
  state,
  onDiscovered,
  onToggle,
}: {
  personalityId: string;
  serverName: string;
  state: ServerToolState | undefined;
  onDiscovered: (tools: string[]) => void;
  onToggle: (toolName: string) => void;
}) {
  const [allTools, setAllTools] = useState<{ name: string; description?: string }[]>([]);
  const [displayCount, setDisplayCount] = useState(50);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [available, setAvailable] = useState(false);
  const fetchedRef = useRef(false);

  const stableOnDiscovered = useCallback(onDiscovered, [onDiscovered]);

  const load = useCallback(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    setLoading(true);
    let cancelled = false;

    async function fetchAllTools() {
      const collected: { name: string; description?: string }[] = [];
      let cursor: string | undefined;
      let serverAvailable = false;
      do {
        const result = await rpc.mcp.serverTools({
          personalityId,
          serverName,
          limit: 200,
          cursor,
        });
        if (cancelled) return;
        serverAvailable = result.available ?? false;
        collected.push(...result.tools);
        cursor = result.nextCursor ?? undefined;
      } while (cursor);

      if (!cancelled) {
        setAvailable(serverAvailable);
        setAllTools(collected);
        setLoading(false);
        if (collected.length > 0) {
          stableOnDiscovered(collected.map((t) => t.name));
        }
      }
    }

    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('timed out')), 10_000),
    );
    Promise.race([fetchAllTools(), timeout]).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [personalityId, serverName, stableOnDiscovered]);

  if (!expanded) {
    return (
      <div style={{ paddingLeft: 24, paddingTop: 2 }}>
        <Button
          type="link"
          size="small"
          style={{ padding: 0, fontSize: 11, height: 'auto' }}
          onClick={() => {
            setExpanded(true);
            load();
          }}
        >
          Configure tools ▾
        </Button>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ paddingLeft: 24, paddingTop: 4 }}>
        <Spin size="small" />
      </div>
    );
  }

  if (!available || allTools.length === 0) {
    return (
      <Typography.Text
        type="secondary"
        style={{ fontSize: 11, display: 'block', paddingLeft: 24, paddingTop: 2 }}
      >
        Tool list unavailable — the server may not be reachable. All tools remain allowed.
      </Typography.Text>
    );
  }

  const visibleTools = allTools.slice(0, displayCount);
  const hasMore = displayCount < allTools.length;

  return (
    <div style={{ paddingLeft: 24, paddingTop: 4 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {visibleTools.map((tool) => (
          <Tag.CheckableTag
            key={tool.name}
            checked={state?.selected.has(tool.name) ?? true}
            onChange={() => onToggle(tool.name)}
            style={{ padding: '4px 10px', fontSize: 12 }}
          >
            {tool.name}
          </Tag.CheckableTag>
        ))}
      </div>
      {hasMore ? (
        <Button
          size="small"
          type="link"
          onClick={() => setDisplayCount((n) => n + 50)}
          style={{ paddingLeft: 0, marginTop: 4 }}
        >
          Show more tools ({allTools.length - displayCount} remaining)
        </Button>
      ) : null}
    </div>
  );
}

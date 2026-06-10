import { useMemo } from 'react';

interface ExecutionGraphProps {
  events: Array<{
    id: number;
    goalId: string;
    seq: number;
    eventType: string;
    payload: Record<string, unknown>;
    createdAt: number;
  }>;
  goalText?: string;
  personalityId?: string;
  isActive?: boolean;
}

// --- Node types ---

type NodeKind = 'GOAL' | 'TURN' | 'TOOL' | 'STEER' | 'REJECTED' | 'DONE';

interface GraphNode {
  kind: NodeKind;
  id: number;
  seq: number;
  payload: Record<string, unknown>;
  createdAt: number;
  /** Index of the parent TURN node (for TOOL nodes) */
  parentIndex?: number;
  /** For TURN nodes: tools hanging below */
  tools: GraphNode[];
  /** Original event type */
  eventType: string;
}

// --- Layout constants ---

const NODE_W = 180;
const NODE_GAP = 24;
const MAIN_Y = 24;
const TOOL_Y = 110;
const TOOL_GAP = 12;
const NODE_H_MAIN = 64;
const NODE_H_TOOL = 52;

function classifyEvent(eventType: string): NodeKind {
  switch (eventType) {
    case 'run_start':
      return 'GOAL';
    case 'turn_text':
      return 'TURN';
    case 'tool_start':
    case 'tool_end':
      return 'TOOL';
    case 'steer':
      return 'STEER';
    case 'complete_rejected':
      return 'REJECTED';
    case 'done':
      return 'DONE';
    default:
      return 'TURN';
  }
}

function buildNodes(events: ExecutionGraphProps['events']): GraphNode[] {
  const mainNodes: GraphNode[] = [];
  let lastTurnIndex = -1;
  const seenToolIds = new Set<string>();

  for (const ev of events) {
    const kind = classifyEvent(ev.eventType);

    if (kind === 'TOOL') {
      // Group tool events under their parent turn; dedupe tool_start/tool_end pairs by toolName
      const toolName = (ev.payload?.toolName as string) ?? '';
      const dedupeKey = `${lastTurnIndex}:${toolName}`;

      if (ev.eventType === 'tool_end' && seenToolIds.has(dedupeKey)) {
        // Update existing tool node with result info
        const parent = lastTurnIndex >= 0 ? mainNodes[lastTurnIndex] : undefined;
        if (parent) {
          const existing = parent.tools.find((t) => (t.payload?.toolName as string) === toolName);
          if (existing) {
            existing.payload = { ...existing.payload, ...ev.payload };
            existing.eventType = 'tool_end';
          }
        }
        continue;
      }

      seenToolIds.add(dedupeKey);

      const node: GraphNode = {
        kind,
        id: ev.id,
        seq: ev.seq,
        payload: ev.payload,
        createdAt: ev.createdAt,
        parentIndex: lastTurnIndex >= 0 ? lastTurnIndex : undefined,
        tools: [],
        eventType: ev.eventType,
      };

      if (lastTurnIndex >= 0) {
        mainNodes[lastTurnIndex].tools.push(node);
      }
      continue;
    }

    const node: GraphNode = {
      kind,
      id: ev.id,
      seq: ev.seq,
      payload: ev.payload,
      createdAt: ev.createdAt,
      tools: [],
      eventType: ev.eventType,
    };

    mainNodes.push(node);
    if (kind === 'TURN') {
      lastTurnIndex = mainNodes.length - 1;
    }
  }

  return mainNodes;
}

// --- Visual config per node kind ---

function getNodeStyle(kind: NodeKind, isRunning: boolean): { borderLeft: string; bg: string } {
  switch (kind) {
    case 'GOAL':
      return {
        borderLeft: '3px solid #8B5CF6',
        bg: 'rgba(139,92,246,0.08)',
      };
    case 'TURN':
      return {
        borderLeft: isRunning ? '1px solid var(--info)' : '1px solid var(--success)',
        bg: 'rgba(74,158,255,0.06)',
      };
    case 'TOOL':
      return {
        borderLeft: '1px solid var(--text-tertiary)',
        bg: 'rgba(107,107,106,0.06)',
      };
    case 'STEER':
      return {
        borderLeft: '3px solid #F59E0B',
        bg: 'rgba(245,158,11,0.08)',
      };
    case 'REJECTED':
      return {
        borderLeft: '1px solid var(--error)',
        bg: 'rgba(248,113,113,0.08)',
      };
    case 'DONE':
      return {
        borderLeft: '1px solid var(--success)',
        bg: 'rgba(74,222,128,0.08)',
      };
  }
}

function getNodeLabel(kind: NodeKind): string {
  switch (kind) {
    case 'GOAL':
      return 'GOAL';
    case 'TURN':
      return 'TURN';
    case 'TOOL':
      return 'TOOL';
    case 'STEER':
      return 'STEER';
    case 'REJECTED':
      return 'COMPLETION REJECTED';
    case 'DONE':
      return 'COMPLETED';
  }
}

function getLabelColor(kind: NodeKind): string {
  switch (kind) {
    case 'GOAL':
      return '#8B5CF6';
    case 'TURN':
      return 'var(--info)';
    case 'TOOL':
      return 'var(--text-tertiary)';
    case 'STEER':
      return '#F59E0B';
    case 'REJECTED':
      return 'var(--error)';
    case 'DONE':
      return 'var(--success)';
  }
}

// --- Render helpers ---

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function renderNodeContent(
  node: GraphNode,
  goalText?: string,
  personalityId?: string,
): React.ReactNode {
  switch (node.kind) {
    case 'GOAL':
      return (
        <>
          {goalText && (
            <div
              style={{
                fontSize: 11,
                color: 'var(--text-secondary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {truncate(goalText, 30)}
            </div>
          )}
          {personalityId && (
            <span
              style={{
                display: 'inline-block',
                marginTop: 4,
                fontSize: 10,
                fontFamily: "'Geist Mono', monospace",
                color: 'var(--text-tertiary)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '3px',
                padding: '1px 5px',
              }}
            >
              {personalityId}
            </span>
          )}
        </>
      );

    case 'TURN': {
      const turnNum = node.payload?.turnNumber as number | undefined;
      const text = node.payload?.text as string | undefined;
      return (
        <>
          {turnNum != null && (
            <div
              style={{
                fontSize: 11,
                color: 'var(--text-secondary)',
                fontWeight: 500,
              }}
            >
              Turn {turnNum}
            </div>
          )}
          {text && (
            <div
              style={{
                fontSize: 11,
                color: 'var(--text-tertiary)',
                fontStyle: 'italic',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {truncate(text, 30)}
            </div>
          )}
        </>
      );
    }

    case 'TOOL': {
      const toolName = (node.payload?.toolName as string) ?? '';
      const result = node.payload?.result as string | undefined;
      return (
        <>
          <div
            style={{
              fontSize: 11,
              fontFamily: "'Geist Mono', monospace",
              color: 'var(--text-secondary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {toolName}
          </div>
          {result && (
            <div
              style={{
                fontSize: 10,
                color: 'var(--text-tertiary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                marginTop: 2,
              }}
            >
              {truncate(result, 24)}
            </div>
          )}
        </>
      );
    }

    case 'STEER': {
      const message = (node.payload?.message as string) ?? '';
      const ts = node.createdAt;
      return (
        <>
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-secondary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {truncate(message, 28)}
          </div>
          <div
            style={{
              fontSize: 10,
              color: 'var(--text-tertiary)',
              marginTop: 2,
              fontFamily: "'Geist Mono', monospace",
            }}
          >
            {new Date(ts).toLocaleTimeString()}
          </div>
        </>
      );
    }

    case 'REJECTED': {
      const reason = (node.payload?.reason as string) ?? '';
      return (
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-secondary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {truncate(reason, 28)}
        </div>
      );
    }

    case 'DONE': {
      const turnCount = node.payload?.turnCount as number | undefined;
      return (
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-secondary)',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <span style={{ color: 'var(--success)' }}>&#10003;</span>
          {turnCount != null && <span>{turnCount} turns</span>}
        </div>
      );
    }
  }
}

export function ExecutionGraph({ events, goalText, personalityId, isActive }: ExecutionGraphProps) {
  const mainNodes = useMemo(() => buildNodes(events), [events]);

  // Find last TURN index for glow effect
  const lastTurnIndex = useMemo(() => {
    for (let i = mainNodes.length - 1; i >= 0; i--) {
      if (mainNodes[i].kind === 'TURN') return i;
    }
    return -1;
  }, [mainNodes]);

  // Compute positions
  const positions = useMemo(() => {
    const pos: Array<{ x: number; y: number; w: number; h: number }> = [];
    let xCursor = 16;

    for (const _node of mainNodes) {
      pos.push({
        x: xCursor,
        y: MAIN_Y,
        w: NODE_W,
        h: NODE_H_MAIN,
      });
      xCursor += NODE_W + NODE_GAP;
    }
    return pos;
  }, [mainNodes]);

  // Compute tool positions (relative to parent)
  const toolPositions = useMemo(() => {
    const result: Map<number, Array<{ x: number; y: number; w: number; h: number }>> = new Map();

    for (let i = 0; i < mainNodes.length; i++) {
      const node = mainNodes[i];
      if (node.tools.length === 0) continue;

      const parentPos = positions[i];
      if (!parentPos) continue;

      const tpList: Array<{ x: number; y: number; w: number; h: number }> = [];
      for (let t = 0; t < node.tools.length; t++) {
        tpList.push({
          x: parentPos.x + t * (140 + TOOL_GAP),
          y: TOOL_Y,
          w: 140,
          h: NODE_H_TOOL,
        });
      }
      result.set(i, tpList);
    }
    return result;
  }, [mainNodes, positions]);

  // Canvas dimensions
  const canvasWidth = useMemo(() => {
    let maxX = 0;
    for (const p of positions) {
      const right = p.x + p.w;
      if (right > maxX) maxX = right;
    }
    for (const [, tps] of toolPositions) {
      for (const tp of tps) {
        const right = tp.x + tp.w;
        if (right > maxX) maxX = right;
      }
    }
    return maxX + 32;
  }, [positions, toolPositions]);

  const canvasHeight = useMemo(() => {
    let hasTools = false;
    for (const [, tps] of toolPositions) {
      if (tps.length > 0) hasTools = true;
    }
    return hasTools ? TOOL_Y + NODE_H_TOOL + 24 : MAIN_Y + NODE_H_MAIN + 24;
  }, [toolPositions]);

  // Build arrow connections
  const arrows = useMemo(() => {
    const result: Array<{
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      pending: boolean;
    }> = [];

    // Main row connections
    for (let i = 0; i < positions.length - 1; i++) {
      const from = positions[i];
      const to = positions[i + 1];
      if (!from || !to) continue;
      result.push({
        x1: from.x + from.w,
        y1: from.y + from.h / 2,
        x2: to.x,
        y2: to.y + to.h / 2,
        pending: isActive === true && i === positions.length - 2,
      });
    }

    // Turn-to-tool connections
    for (const [parentIdx, tps] of toolPositions) {
      const parentPos = positions[parentIdx];
      if (!parentPos) continue;
      for (const tp of tps) {
        result.push({
          x1: parentPos.x + parentPos.w / 2,
          y1: parentPos.y + parentPos.h,
          x2: tp.x + tp.w / 2,
          y2: tp.y,
          pending: false,
        });
      }
    }

    return result;
  }, [positions, toolPositions, isActive]);

  return (
    <div
      style={{
        position: 'relative',
        marginBottom: 16,
        borderRadius: '8px',
        border: '1px solid var(--border-subtle)',
        background: 'var(--bg-elevated)',
        overflowX: 'auto',
        backgroundImage: 'radial-gradient(circle, #2A2A2A 1px, transparent 1px)',
        backgroundSize: '20px 20px',
      }}
    >
      <style>
        {`@keyframes exec-graph-appear {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}`}
      </style>

      {mainNodes.length === 0 ? (
        <div
          style={{
            padding: 24,
            textAlign: 'center',
            color: 'var(--text-tertiary)',
            fontSize: 13,
          }}
        >
          No events yet
        </div>
      ) : (
        <div
          style={{
            position: 'relative',
            width: canvasWidth,
            height: canvasHeight,
            minWidth: '100%',
          }}
        >
          {/* SVG arrows */}
          <svg
            role="img"
            aria-label="Execution flow arrows"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: canvasWidth,
              height: canvasHeight,
              pointerEvents: 'none',
            }}
          >
            <title>Execution flow arrows</title>
            <defs>
              <marker
                id="exec-arrow"
                markerWidth="8"
                markerHeight="6"
                refX="8"
                refY="3"
                orient="auto"
              >
                <path d="M0,0 L8,3 L0,6" fill="none" stroke="var(--info)" strokeWidth="1" />
              </marker>
              <marker
                id="exec-arrow-pending"
                markerWidth="8"
                markerHeight="6"
                refX="8"
                refY="3"
                orient="auto"
              >
                <path
                  d="M0,0 L8,3 L0,6"
                  fill="none"
                  stroke="var(--text-tertiary)"
                  strokeWidth="1"
                />
              </marker>
            </defs>
            {arrows.map((a) => (
              <line
                key={`${a.x1}-${a.y1}-${a.x2}-${a.y2}`}
                x1={a.x1}
                y1={a.y1}
                x2={a.x2}
                y2={a.y2}
                stroke={a.pending ? 'var(--text-tertiary)' : 'var(--info)'}
                strokeWidth={1}
                strokeDasharray={a.pending ? '5 4' : undefined}
                markerEnd={a.pending ? 'url(#exec-arrow-pending)' : 'url(#exec-arrow)'}
              />
            ))}
          </svg>

          {/* Main row nodes */}
          {mainNodes.map((node, idx) => {
            const pos = positions[idx];
            if (!pos) return null;

            const isLastTurnActive = isActive === true && idx === lastTurnIndex;
            const style = getNodeStyle(node.kind, isLastTurnActive);

            return (
              <div
                key={node.id}
                style={{
                  position: 'absolute',
                  left: pos.x,
                  top: pos.y,
                  width: pos.w,
                  height: pos.h,
                  borderRadius: '6px',
                  borderLeft: style.borderLeft,
                  border: `1px solid var(--border-subtle)`,
                  borderLeftWidth: node.kind === 'GOAL' || node.kind === 'STEER' ? 3 : 1,
                  borderLeftColor:
                    node.kind === 'GOAL'
                      ? '#8B5CF6'
                      : node.kind === 'STEER'
                        ? '#F59E0B'
                        : node.kind === 'REJECTED'
                          ? 'var(--error)'
                          : node.kind === 'DONE'
                            ? 'var(--success)'
                            : isLastTurnActive
                              ? 'var(--info)'
                              : node.kind === 'TURN'
                                ? 'var(--success)'
                                : 'var(--text-tertiary)',
                  background: style.bg,
                  padding: '6px 10px',
                  overflow: 'hidden',
                  opacity: 0,
                  animation: 'exec-graph-appear 300ms cubic-bezier(0.16, 1, 0.3, 1) forwards',
                  animationDelay: `${idx * 60}ms`,
                  boxShadow: isLastTurnActive ? '0 0 12px rgba(74,158,255,0.3)' : undefined,
                }}
                title={JSON.stringify(node.payload, null, 2)}
              >
                <div
                  style={{
                    fontSize: 9,
                    fontWeight: 600,
                    color: getLabelColor(node.kind),
                    textTransform: 'uppercase' as const,
                    letterSpacing: '0.05em',
                    marginBottom: 2,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  {getNodeLabel(node.kind)}
                  {node.kind === 'TURN' && isLastTurnActive && (
                    <span
                      style={{
                        display: 'inline-block',
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: 'var(--info)',
                        animation: 'goals-pulse 1.5s ease-in-out infinite',
                      }}
                    />
                  )}
                  {node.kind === 'TURN' && !isLastTurnActive && (
                    <span style={{ color: 'var(--success)', fontSize: 10 }}>&#10003;</span>
                  )}
                </div>
                {renderNodeContent(node, goalText, personalityId)}
              </div>
            );
          })}

          {/* Tool nodes (hanging below their parent turn) */}
          {Array.from(toolPositions.entries()).map(([parentIdx, tps]) => {
            const parentNode = mainNodes[parentIdx];
            if (!parentNode) return null;

            return tps.map((tp, tIdx) => {
              const tool = parentNode.tools[tIdx];
              if (!tool) return null;

              const toolStyle = getNodeStyle('TOOL', false);
              const globalIdx = mainNodes.length + parentIdx * 10 + tIdx;

              return (
                <div
                  key={tool.id}
                  style={{
                    position: 'absolute',
                    left: tp.x,
                    top: tp.y,
                    width: tp.w,
                    height: tp.h,
                    borderRadius: '6px',
                    border: '1px solid var(--border-subtle)',
                    borderLeftColor: 'var(--text-tertiary)',
                    background: toolStyle.bg,
                    padding: '4px 8px',
                    overflow: 'hidden',
                    opacity: 0,
                    animation: 'exec-graph-appear 300ms cubic-bezier(0.16, 1, 0.3, 1) forwards',
                    animationDelay: `${globalIdx * 60}ms`,
                  }}
                  title={JSON.stringify(tool.payload, null, 2)}
                >
                  <div
                    style={{
                      fontSize: 9,
                      fontWeight: 600,
                      color: 'var(--text-tertiary)',
                      textTransform: 'uppercase' as const,
                      letterSpacing: '0.05em',
                      marginBottom: 2,
                    }}
                  >
                    TOOL
                  </div>
                  {renderNodeContent(tool)}
                </div>
              );
            });
          })}
        </div>
      )}
    </div>
  );
}

import type { GoalEventWire } from '@ethosagent/web-contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface ToolResultData {
  found: boolean;
  toolName?: string;
  input?: string;
  output?: string;
}

interface ExecutionGraphProps {
  events: GoalEventWire[];
  goalText?: string;
  personalityId?: string;
  isActive?: boolean;
  /** Lazily fetch a tool's input/output for the node-detail modal. */
  fetchToolResult: (toolCallId: string) => Promise<ToolResultData | null>;
}

// --- Node types ---

type NodeKind = 'GOAL' | 'ATTEMPT' | 'TURN' | 'TOOL' | 'STEER' | 'REJECTED' | 'DONE';

interface GraphNode {
  kind: NodeKind;
  id: number;
  seq: number;
  payload: Record<string, unknown>;
  createdAt: number;
  eventType: string;
  /** Parallel batch id — only set on TOOL nodes. */
  batchId?: number;
}

// --- Layout constants ---

const NODE_W = 180;
const NODE_GAP = 24;
const MAIN_Y = 24;
const NODE_H_MAIN = 64;

const PARALLEL_HEADER_H = 22;
const INNER_TOOL_H = 72;
const INNER_GAP = 8;
const BOX_PAD = 8;

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 1.5;
const ZOOM_STEP = 0.15;

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

function classifyEvent(eventType: string): NodeKind {
  switch (eventType) {
    case 'run_start':
      return 'GOAL';
    case 'attempt_start':
      return 'ATTEMPT';
    case 'turn_text':
      return 'TURN';
    case 'tool_start':
    case 'tool_end':
      return 'TOOL';
    case 'steer':
      return 'STEER';
    case 'error':
      return 'REJECTED';
    case 'complete_rejected':
      return 'REJECTED';
    case 'done':
      return 'DONE';
    default:
      return 'TURN';
  }
}

function buildNodes(events: GoalEventWire[]): GraphNode[] {
  const mainNodes: GraphNode[] = [];
  const toolIndexByKey = new Map<string, number>();
  let currentBatchId = 0;
  let prevWasToolStart = false;

  for (const ev of events) {
    if (ev.eventType === 'usage') continue;

    const kind = classifyEvent(ev.eventType);

    if (kind === 'TOOL') {
      const toolKey =
        (ev.payload?.toolCallId as string) ?? (ev.payload?.toolName as string) ?? `tool-${ev.id}`;

      if (ev.eventType === 'tool_start') {
        if (toolIndexByKey.has(toolKey)) {
          prevWasToolStart = true;
          continue;
        }
        if (!prevWasToolStart) currentBatchId += 1;
        mainNodes.push({
          kind,
          id: ev.id,
          seq: ev.seq,
          payload: ev.payload,
          createdAt: ev.createdAt,
          eventType: ev.eventType,
          batchId: currentBatchId,
        });
        toolIndexByKey.set(toolKey, mainNodes.length - 1);
        prevWasToolStart = true;
        continue;
      }

      const existingIdx = toolIndexByKey.get(toolKey);
      if (existingIdx != null) {
        const existing = mainNodes[existingIdx];
        if (existing) {
          existing.payload = { ...existing.payload, ...ev.payload };
          existing.eventType = 'tool_end';
        }
        prevWasToolStart = false;
      } else {
        currentBatchId += 1;
        mainNodes.push({
          kind,
          id: ev.id,
          seq: ev.seq,
          payload: ev.payload,
          createdAt: ev.createdAt,
          eventType: ev.eventType,
          batchId: currentBatchId,
        });
        toolIndexByKey.set(toolKey, mainNodes.length - 1);
        prevWasToolStart = false;
      }
      continue;
    }

    prevWasToolStart = false;
    mainNodes.push({
      kind,
      id: ev.id,
      seq: ev.seq,
      payload: ev.payload,
      createdAt: ev.createdAt,
      eventType: ev.eventType,
    });
  }

  return mainNodes;
}

// --- Visual config per node kind ---

function getNodeStyle(kind: NodeKind, isRunning: boolean): { borderLeft: string; bg: string } {
  switch (kind) {
    case 'GOAL':
      return { borderLeft: '3px solid var(--purple)', bg: 'var(--bg-overlay)' };
    case 'ATTEMPT':
      return { borderLeft: '3px solid var(--warning)', bg: 'var(--bg-elevated)' };
    case 'TURN':
      return {
        borderLeft: isRunning ? '1px solid var(--info)' : '1px solid var(--success)',
        bg: 'var(--bg-elevated)',
      };
    case 'TOOL':
      return { borderLeft: '1px solid var(--text-tertiary)', bg: 'var(--bg-elevated)' };
    case 'STEER':
      return { borderLeft: '3px solid var(--warning)', bg: 'var(--bg-elevated)' };
    case 'REJECTED':
      return { borderLeft: '1px solid var(--error)', bg: 'var(--bg-elevated)' };
    case 'DONE':
      return { borderLeft: '1px solid var(--success)', bg: 'var(--bg-elevated)' };
  }
}

function getNodeLabel(kind: NodeKind): string {
  switch (kind) {
    case 'GOAL':
      return 'GOAL';
    case 'ATTEMPT':
      return 'ATTEMPT';
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
      return 'var(--purple)';
    case 'ATTEMPT':
      return 'var(--warning)';
    case 'TURN':
      return 'var(--info)';
    case 'TOOL':
      return 'var(--text-tertiary)';
    case 'STEER':
      return 'var(--warning)';
    case 'REJECTED':
      return 'var(--error)';
    case 'DONE':
      return 'var(--success)';
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function renderNodeContent(
  node: GraphNode,
  goalText?: string,
  personalityId?: string,
  onShowDetails?: (node: GraphNode) => void,
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
                fontFamily: 'var(--font-mono)',
                color: 'var(--text-tertiary)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-sm)',
                padding: '1px 5px',
              }}
            >
              {personalityId}
            </span>
          )}
        </>
      );

    case 'ATTEMPT': {
      const attemptN = node.payload?.attemptN as number | undefined;
      const strategy = node.payload?.strategy as string | undefined;
      return (
        <>
          {attemptN != null && (
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 500 }}>
              Attempt {attemptN}
            </div>
          )}
          {strategy && strategy !== 'first' && (
            <div
              style={{
                fontSize: 10,
                color: 'var(--text-tertiary)',
                fontFamily: 'var(--font-mono)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {strategy}
            </div>
          )}
        </>
      );
    }

    case 'TURN': {
      const turnNum = node.payload?.turnNumber as number | undefined;
      const text = node.payload?.text as string | undefined;
      return (
        <>
          {turnNum != null && (
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 500 }}>
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
      const isRunning = node.eventType === 'tool_start';
      const ok = node.payload?.ok as boolean | undefined;
      const durationMs = node.payload?.durationMs as number | undefined;
      return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <div
            style={{
              fontSize: 11,
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-secondary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {toolName}
          </div>
          <div
            style={{
              fontSize: 10,
              fontFamily: 'var(--font-mono)',
              marginTop: 2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {isRunning ? (
              <span style={{ color: 'var(--text-tertiary)' }}>running…</span>
            ) : (
              <span style={{ color: ok ? 'var(--success)' : 'var(--error)' }}>
                {ok ? 'done' : 'failed'}
                {durationMs != null && (
                  <span style={{ color: 'var(--text-tertiary)' }}> · {durationMs}ms</span>
                )}
              </span>
            )}
          </div>
          {onShowDetails && (
            <button
              type="button"
              aria-label="Tool details"
              title="Tool details"
              onClick={(e) => {
                e.stopPropagation();
                onShowDetails(node);
              }}
              style={{
                marginTop: 'auto',
                alignSelf: 'flex-start',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-sm)',
                background: 'none',
                color: 'var(--text-secondary)',
                fontSize: 10,
                padding: '1px 6px',
                cursor: 'pointer',
              }}
            >
              Details
            </button>
          )}
        </div>
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
              fontFamily: 'var(--font-mono)',
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
          <span style={{ color: 'var(--success)' }}>✓</span>
          {turnCount != null && <span>{turnCount} turns</span>}
        </div>
      );
    }
  }
}

type Slot =
  | { kind: 'single'; nodeIndex: number }
  | { kind: 'parallel'; batchId: number; nodeIndices: number[] };

function formatPayloadValue(value: unknown): string {
  if (value == null) return '(none)';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function getNodeSummary(node: GraphNode): string {
  switch (node.kind) {
    case 'GOAL':
      return 'Goal started';
    case 'ATTEMPT': {
      const attemptN = node.payload?.attemptN as number | undefined;
      return attemptN != null ? `Attempt ${attemptN}` : 'Attempt';
    }
    case 'TURN':
      return 'Assistant turn';
    case 'TOOL':
      return `Tool call: ${(node.payload?.toolName as string) ?? 'tool'}`;
    case 'STEER':
      return 'Steer';
    case 'REJECTED':
      return 'Rejected / error';
    case 'DONE':
      return 'Done';
  }
}

function getNonToolInput(node: GraphNode, goalText?: string): string | null {
  switch (node.kind) {
    case 'GOAL':
      return goalText ?? null;
    case 'ATTEMPT': {
      const attemptN = node.payload?.attemptN as number | undefined;
      const strategy = node.payload?.strategy as string | undefined;
      const parts: string[] = [];
      if (attemptN != null) parts.push(`Attempt ${attemptN}`);
      if (strategy) parts.push(`Strategy: ${strategy}`);
      return parts.length > 0 ? parts.join('\n') : null;
    }
    case 'TURN':
      return (node.payload?.text as string) ?? null;
    case 'STEER':
      return (node.payload?.message as string) ?? null;
    case 'DONE': {
      const turnCount = node.payload?.turnCount as number | undefined;
      return turnCount != null ? `${turnCount} turns` : null;
    }
    default:
      return null;
  }
}

function getNodeError(node: GraphNode): string | null {
  if (node.kind === 'REJECTED') {
    return (
      (node.payload?.error as string) ?? (node.payload?.reason as string) ?? 'Completion rejected'
    );
  }
  if (node.kind === 'TOOL' && node.payload?.ok === false) {
    return 'Tool call failed — see output below.';
  }
  return null;
}

function NodeDetailModal({
  node,
  goalText,
  fetchToolResult,
  onClose,
}: {
  node: GraphNode;
  goalText?: string;
  fetchToolResult: (toolCallId: string) => Promise<ToolResultData | null>;
  onClose: () => void;
}) {
  const isTool = node.kind === 'TOOL';
  const toolCallId = (node.payload?.toolCallId as string) ?? '';
  const [toolData, setToolData] = useState<ToolResultData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!isTool || !toolCallId) return;
    let cancelled = false;
    setLoading(true);
    void fetchToolResult(toolCallId)
      .then((data) => {
        if (!cancelled) setToolData(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isTool, toolCallId, fetchToolResult]);

  const summary = getNodeSummary(node);
  const errorText = getNodeError(node);
  const nonToolInput = isTool ? null : getNonToolInput(node, goalText);

  const sectionLabelStyle = {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    color: 'var(--text-tertiary)',
    marginBottom: 4,
  };
  const preStyle = {
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    fontSize: 12,
    lineHeight: 1.5,
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-primary)',
    margin: 0,
    maxHeight: 240,
    overflowY: 'auto' as const,
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismiss
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1100,
        background: 'var(--ethos-shadow-overlay)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation barrier; Escape handled via keydown listener */}
      <div
        role="dialog"
        aria-modal={true}
        aria-label={summary}
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 460,
          width: '100%',
          maxHeight: '70vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-md)',
          overflow: 'hidden',
          boxShadow: '0 8px 32px var(--ethos-shadow-overlay)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '12px 16px',
            borderBottom: '1px solid var(--border-subtle)',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontSize: 14,
              fontWeight: 500,
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            {summary}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              marginLeft: 'auto',
              background: 'none',
              border: 'none',
              color: 'var(--text-tertiary)',
              fontSize: 18,
              cursor: 'pointer',
              padding: '4px 8px',
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>
          <div style={{ marginBottom: 16 }}>
            <div style={sectionLabelStyle}>What happened</div>
            <pre style={preStyle}>{summary}</pre>
          </div>

          {errorText && (
            <div
              style={{
                marginBottom: 16,
                border: '1px solid var(--error)',
                borderRadius: 'var(--radius-md)',
                background: 'var(--bg-overlay)',
                padding: '12px 14px',
              }}
            >
              <div style={{ ...sectionLabelStyle, color: 'var(--error)' }}>Error</div>
              <pre style={{ ...preStyle, color: 'var(--error)' }}>{errorText}</pre>
            </div>
          )}

          <div style={{ marginBottom: 16 }}>
            <div style={sectionLabelStyle}>Input</div>
            {isTool ? (
              <pre style={preStyle}>
                {toolData?.input ?? formatPayloadValue(node.payload?.args)}
              </pre>
            ) : (
              <pre style={preStyle}>{nonToolInput ?? '(none)'}</pre>
            )}
          </div>

          {isTool ? (
            <div>
              <div style={sectionLabelStyle}>Output</div>
              {loading ? (
                <span style={{ color: 'var(--text-tertiary)' }}>Loading output…</span>
              ) : toolData?.found && toolData.output && toolData.output.trim().length > 0 ? (
                <pre style={preStyle}>{toolData.output}</pre>
              ) : (
                <pre style={{ ...preStyle, color: 'var(--text-tertiary)' }}>
                  (no output captured yet)
                </pre>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function ExecutionGraph({
  events,
  goalText,
  personalityId,
  isActive,
  fetchToolResult,
}: ExecutionGraphProps) {
  const mainNodes = useMemo(() => buildNodes(events), [events]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [detailNode, setDetailNode] = useState<GraphNode | null>(null);
  const showDetails = useCallback((node: GraphNode) => setDetailNode(node), []);
  const closeDetails = useCallback(() => setDetailNode(null), []);

  const dragState = useRef<{
    active: boolean;
    moved: boolean;
    startX: number;
    startY: number;
    startLeft: number;
    startTop: number;
  } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    setContainerSize({ w: container.clientWidth, h: container.clientHeight });
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setContainerSize({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const onPointerDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, a, input, textarea, select, [role="button"], [data-node-card]'))
      return;
    if (e.button !== 0) return;
    const container = scrollRef.current;
    if (!container) return;
    dragState.current = {
      active: true,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: container.scrollLeft,
      startTop: container.scrollTop,
    };
  }, []);

  const onPointerMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const st = dragState.current;
    if (!st?.active) return;
    const container = scrollRef.current;
    if (!container) return;
    const dx = e.clientX - st.startX;
    const dy = e.clientY - st.startY;
    if (!st.moved && Math.abs(dx) + Math.abs(dy) > 4) {
      st.moved = true;
      setIsDragging(true);
    }
    if (st.moved) {
      container.scrollLeft = st.startLeft - dx;
      container.scrollTop = st.startTop - dy;
    }
  }, []);

  const endDrag = useCallback(() => {
    if (dragState.current) dragState.current.active = false;
    setIsDragging(false);
  }, []);

  const onClickCapture = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (dragState.current?.moved) {
      e.stopPropagation();
      e.preventDefault();
      if (dragState.current) dragState.current.moved = false;
    }
  }, []);

  const lastTurnIndex = useMemo(() => {
    for (let i = mainNodes.length - 1; i >= 0; i--) {
      if (mainNodes[i]?.kind === 'TURN') return i;
    }
    return -1;
  }, [mainNodes]);

  const activeNodeIndex = useMemo(() => {
    if (isActive !== true) return -1;
    for (let i = mainNodes.length - 1; i >= 0; i--) {
      const n = mainNodes[i];
      if (n?.kind === 'TOOL' && n.eventType === 'tool_start') return i;
    }
    return mainNodes.length - 1;
  }, [mainNodes, isActive]);

  const slots = useMemo(() => {
    const batchSizes = new Map<number, number>();
    for (const node of mainNodes) {
      if (node.kind === 'TOOL' && node.batchId != null) {
        batchSizes.set(node.batchId, (batchSizes.get(node.batchId) ?? 0) + 1);
      }
    }

    const result: Slot[] = [];
    for (let i = 0; i < mainNodes.length; i++) {
      const node = mainNodes[i];
      if (!node) continue;
      const batchId = node.batchId;
      if (node.kind === 'TOOL' && batchId != null && (batchSizes.get(batchId) ?? 0) > 1) {
        const last = result[result.length - 1];
        if (last && last.kind === 'parallel' && last.batchId === batchId) {
          last.nodeIndices.push(i);
        } else {
          result.push({ kind: 'parallel', batchId, nodeIndices: [i] });
        }
      } else {
        result.push({ kind: 'single', nodeIndex: i });
      }
    }
    return result;
  }, [mainNodes]);

  const activeSlotIndex = useMemo(() => {
    if (activeNodeIndex < 0) return -1;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (!slot) continue;
      if (slot.kind === 'single' && slot.nodeIndex === activeNodeIndex) return i;
      if (slot.kind === 'parallel' && slot.nodeIndices.includes(activeNodeIndex)) return i;
    }
    return -1;
  }, [slots, activeNodeIndex]);

  const [celebrating, setCelebrating] = useState<Set<number>>(() => new Set());
  const prevDoneRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    const nowDone = new Set<number>();
    for (const n of mainNodes) {
      if (n.kind === 'TOOL' && n.eventType === 'tool_end') nowDone.add(n.id);
    }
    const newlyDone: number[] = [];
    for (const id of nowDone) if (!prevDoneRef.current.has(id)) newlyDone.push(id);
    prevDoneRef.current = nowDone;
    if (newlyDone.length === 0) return;
    setCelebrating((prev) => {
      const next = new Set(prev);
      for (const id of newlyDone) next.add(id);
      return next;
    });
    const timer = setTimeout(() => {
      setCelebrating((prev) => {
        const next = new Set(prev);
        for (const id of newlyDone) next.delete(id);
        return next;
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [mainNodes]);

  const [batchCelebrating, setBatchCelebrating] = useState<Set<number>>(() => new Set());
  const prevBatchDoneRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    const batchTotals = new Map<number, number>();
    const batchDone = new Map<number, number>();
    for (const n of mainNodes) {
      if (n.kind === 'TOOL' && n.batchId != null) {
        batchTotals.set(n.batchId, (batchTotals.get(n.batchId) ?? 0) + 1);
        if (n.eventType === 'tool_end') {
          batchDone.set(n.batchId, (batchDone.get(n.batchId) ?? 0) + 1);
        }
      }
    }
    const nowAllDone = new Set<number>();
    for (const [batchId, total] of batchTotals) {
      if (total > 1 && batchDone.get(batchId) === total) nowAllDone.add(batchId);
    }
    const newly: number[] = [];
    for (const id of nowAllDone) if (!prevBatchDoneRef.current.has(id)) newly.push(id);
    prevBatchDoneRef.current = nowAllDone;
    if (newly.length === 0) return;
    setBatchCelebrating((prev) => {
      const next = new Set(prev);
      for (const id of newly) next.add(id);
      return next;
    });
    const timer = setTimeout(() => {
      setBatchCelebrating((prev) => {
        const next = new Set(prev);
        for (const id of newly) next.delete(id);
        return next;
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [mainNodes]);

  const positions = useMemo(() => {
    const heights = slots.map((slot) => {
      if (slot.kind === 'parallel') {
        const n = slot.nodeIndices.length;
        return PARALLEL_HEADER_H + n * INNER_TOOL_H + (n - 1) * INNER_GAP + 2 * BOX_PAD;
      }
      return NODE_H_MAIN;
    });
    const maxNodeH = heights.reduce((m, h) => Math.max(m, h), NODE_H_MAIN);

    const rowTop =
      containerSize.h > 0 ? Math.max(MAIN_Y, (containerSize.h - maxNodeH) / 2) : MAIN_Y;

    const rel: Array<{ x: number; y: number; w: number; h: number }> = [];
    let xCursor = 0;
    let contentWidth = 0;
    for (let i = 0; i < slots.length; i++) {
      rel.push({ x: xCursor, y: rowTop, w: NODE_W, h: heights[i] ?? NODE_H_MAIN });
      contentWidth = xCursor + NODE_W;
      xCursor += NODE_W + NODE_GAP;
    }
    if (slots.length === 0) contentWidth = 0;

    const w = containerSize.w;
    const LEFT_MIN = 16;
    const RIGHT_PAD = 24;
    const leftOffset =
      w > 0
        ? (() => {
            const startThird = Math.max(LEFT_MIN, w / 3);
            return Math.max(LEFT_MIN, Math.min(startThird, w - RIGHT_PAD - contentWidth));
          })()
        : LEFT_MIN;

    return rel.map((p) => ({ ...p, x: p.x + leftOffset }));
  }, [slots, containerSize]);

  const canvasWidth = useMemo(() => {
    let maxX = 0;
    for (const p of positions) {
      const right = p.x + p.w;
      if (right > maxX) maxX = right;
    }
    return maxX + 32;
  }, [positions]);

  const canvasHeight = useMemo(() => {
    let maxBottom = MAIN_Y + NODE_H_MAIN;
    for (const p of positions) {
      const bottom = p.y + p.h;
      if (bottom > maxBottom) maxBottom = bottom;
    }
    return maxBottom + 24;
  }, [positions]);

  const arrows = useMemo(() => {
    const result: Array<{ x1: number; y1: number; x2: number; y2: number; pending: boolean }> = [];
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
    return result;
  }, [positions, isActive]);

  const didInitialCenter = useRef(false);
  useEffect(() => {
    if (didInitialCenter.current) return;
    if (isActive === true) return;
    if (mainNodes.length === 0) return;
    const container = scrollRef.current;
    if (!container) return;
    container.scrollLeft = 0;
    container.scrollTop = 0;
    didInitialCenter.current = true;
  }, [isActive, mainNodes.length]);

  useEffect(() => {
    if (isActive !== true) return;
    const container = scrollRef.current;
    if (!container) return;
    if (dragState.current?.active) return;

    const targetPos = activeSlotIndex >= 0 ? positions[activeSlotIndex] : undefined;
    const left = targetPos ? Math.max(0, targetPos.x * zoom - 16) : container.scrollWidth;
    container.scrollTo({ left, behavior: 'smooth' });
  }, [isActive, activeSlotIndex, positions, zoom]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const delta = -e.deltaY * 0.0015;
      setZoom((z) => clampZoom(z + delta));
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, []);

  const zoomIn = useCallback(() => setZoom((z) => clampZoom(z + ZOOM_STEP)), []);
  const zoomOut = useCallback(() => setZoom((z) => clampZoom(z - ZOOM_STEP)), []);
  const fitToScreen = useCallback(() => {
    if (canvasWidth <= 0 || canvasHeight <= 0) return;
    const raw = Math.min(containerSize.w / canvasWidth, containerSize.h / canvasHeight);
    const fit = Math.min(1, clampZoom(raw));
    setZoom(fit);
    const c = scrollRef.current;
    if (c) {
      c.scrollLeft = 0;
      c.scrollTop = 0;
    }
  }, [canvasWidth, canvasHeight, containerSize]);

  return (
    <>
      {detailNode && (
        <NodeDetailModal
          node={detailNode}
          goalText={goalText}
          fetchToolResult={fetchToolResult}
          onClose={closeDetails}
        />
      )}
      <div
        ref={scrollRef}
        className="exec-graph-root"
        role="application"
        aria-label="Execution graph — drag to pan"
        onMouseDown={onPointerDown}
        onMouseMove={onPointerMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
        onClickCapture={onClickCapture}
        style={{
          position: 'relative',
          height: '100%',
          minHeight: 0,
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border-subtle)',
          background: 'var(--bg-elevated)',
          overflowX: 'auto',
          overflowY: 'auto',
          cursor: isDragging ? 'grabbing' : 'grab',
          userSelect: 'none',
        }}
      >
        <style>
          {`@keyframes exec-graph-appear {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes exec-graph-spin { to { transform: rotate(360deg); } }
@keyframes exec-graph-breathe {
  0%, 100% { box-shadow: 0 0 0 rgba(74,158,255,0); }
  50% { box-shadow: 0 0 14px rgba(74,158,255,0.35); }
}
@keyframes goals-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
@keyframes exec-graph-tool-enter {
  from { opacity: 0; transform: scale(0.94) translateY(6px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}
@keyframes exec-graph-shimmer {
  0% { background-position: -160px 0; }
  100% { background-position: 220px 0; }
}
@keyframes exec-graph-active-ring {
  0%, 100% { box-shadow: 0 0 0 1px rgba(74,158,255,0.5), 0 0 10px rgba(74,158,255,0.18); }
  50% { box-shadow: 0 0 0 1px rgba(74,158,255,0.9), 0 0 18px rgba(74,158,255,0.42); }
}
@keyframes exec-graph-complete-pop {
  0% { transform: scale(1); }
  45% { transform: scale(1.04); }
  100% { transform: scale(1); }
}
@keyframes exec-graph-complete-ring {
  0% { box-shadow: 0 0 0 0 rgba(74,222,128,0.55); }
  100% { box-shadow: 0 0 0 10px rgba(74,222,128,0); }
}
@keyframes exec-graph-check-in {
  from { opacity: 0; transform: scale(0.4); }
  to { opacity: 1; transform: scale(1); }
}
.exec-graph-canvas { transition: transform 0.12s ease; }
@media (prefers-reduced-motion: reduce) {
  .exec-graph-spinner { animation: none; }
  .exec-graph-node-breathe { animation: none !important; box-shadow: 0 0 12px rgba(74,158,255,0.3) !important; }
  .exec-graph-root *, .exec-graph-root *::before, .exec-graph-root *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
  }
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
            className="exec-graph-canvas"
            style={{
              position: 'relative',
              width: Math.max(canvasWidth, zoom > 0 ? containerSize.w / zoom : containerSize.w),
              height: Math.max(canvasHeight, zoom > 0 ? containerSize.h / zoom : containerSize.h),
              transform: `scale(${zoom})`,
              transformOrigin: '0 0',
              backgroundImage: 'radial-gradient(circle, var(--border-subtle) 1px, transparent 1px)',
              backgroundSize: '20px 20px',
            }}
          >
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

            {slots.map((slot, slotIdx) => {
              const pos = positions[slotIdx];
              if (!pos) return null;

              if (slot.kind === 'parallel') {
                const n = slot.nodeIndices.length;
                const isBoxActive = slot.nodeIndices.some((ni) => {
                  const child = mainNodes[ni];
                  return child?.eventType === 'tool_start' && isActive === true;
                });
                const isBatchCelebrating = batchCelebrating.has(slot.batchId);
                return (
                  <div
                    key={`batch-${slot.batchId}`}
                    data-node-card
                    className={isBoxActive ? 'exec-graph-node-breathe' : undefined}
                    style={{
                      position: 'absolute',
                      left: pos.x,
                      top: pos.y,
                      width: pos.w,
                      height: pos.h,
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--bg-elevated)',
                      padding: BOX_PAD,
                      overflow: 'hidden',
                      cursor: 'default',
                      opacity: isBoxActive || isBatchCelebrating ? 1 : 0,
                      animation: isBoxActive
                        ? 'exec-graph-appear 300ms cubic-bezier(0.16, 1, 0.3, 1) forwards, exec-graph-breathe 1.4s ease-in-out infinite'
                        : isBatchCelebrating
                          ? 'exec-graph-appear 300ms cubic-bezier(0.16, 1, 0.3, 1) forwards, exec-graph-complete-ring 500ms ease-out'
                          : 'exec-graph-appear 300ms cubic-bezier(0.16, 1, 0.3, 1) forwards',
                      animationDelay:
                        isBoxActive || isBatchCelebrating
                          ? `${slotIdx * 60}ms, 0ms`
                          : `${slotIdx * 60}ms`,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 9,
                        fontWeight: 600,
                        textTransform: 'uppercase' as const,
                        letterSpacing: '0.05em',
                        color: 'var(--text-tertiary)',
                        marginBottom: 6,
                      }}
                    >
                      PARALLEL · {n}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: INNER_GAP }}>
                      {slot.nodeIndices.map((ni) => {
                        const node = mainNodes[ni];
                        if (!node) return null;
                        const isToolRunning = node.eventType === 'tool_start' && isActive === true;
                        const isToolDone = node.eventType === 'tool_end';
                        return (
                          // biome-ignore lint/a11y/useSemanticElements: positioned card with nested overlay/affordances; can't be <button>
                          <div
                            key={node.id}
                            data-node-card
                            role="button"
                            tabIndex={0}
                            aria-label={getNodeSummary(node)}
                            onClick={() => showDetails(node)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                showDetails(node);
                              }
                            }}
                            style={{
                              position: 'relative',
                              height: INNER_TOOL_H,
                              border: '1px solid var(--border-subtle)',
                              borderLeft: '1px solid var(--text-tertiary)',
                              borderRadius: 'var(--radius-sm)',
                              background: 'var(--bg-elevated)',
                              padding: '6px 10px',
                              overflow: 'hidden',
                              cursor: 'pointer',
                              animation: isToolRunning
                                ? 'exec-graph-active-ring 1.6s ease-in-out infinite'
                                : undefined,
                            }}
                          >
                            {isToolRunning && (
                              <div
                                style={{
                                  position: 'absolute',
                                  inset: 0,
                                  borderRadius: 'inherit',
                                  pointerEvents: 'none',
                                  background:
                                    'linear-gradient(100deg, transparent 20%, rgba(74,158,255,0.10) 50%, transparent 80%)',
                                  backgroundSize: '220px 100%',
                                  animation: 'exec-graph-shimmer 1.8s linear infinite',
                                }}
                              />
                            )}
                            <div
                              style={{
                                fontSize: 9,
                                fontWeight: 600,
                                color: getLabelColor('TOOL'),
                                textTransform: 'uppercase' as const,
                                letterSpacing: '0.05em',
                                marginBottom: 2,
                                display: 'flex',
                                alignItems: 'center',
                                gap: 4,
                              }}
                            >
                              {getNodeLabel('TOOL')}
                              {isToolRunning && (
                                <span
                                  className="exec-graph-spinner"
                                  style={{
                                    display: 'inline-block',
                                    width: 10,
                                    height: 10,
                                    border: '1.5px solid var(--border-subtle)',
                                    borderTopColor: 'var(--info)',
                                    borderRadius: '50%',
                                    animation: 'exec-graph-spin 0.8s linear infinite',
                                  }}
                                />
                              )}
                              {isToolDone && (
                                <span
                                  style={{
                                    color: 'var(--success)',
                                    fontSize: 10,
                                    display: 'inline-block',
                                    animation:
                                      'exec-graph-check-in 300ms cubic-bezier(0.16, 1, 0.3, 1)',
                                  }}
                                >
                                  ✓
                                </span>
                              )}
                            </div>
                            {renderNodeContent(node, goalText, personalityId, showDetails)}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              }

              const idx = slot.nodeIndex;
              const node = mainNodes[idx];
              if (!node) return null;

              const isLastTurnActive = isActive === true && idx === lastTurnIndex;
              const isBreathing = idx === activeNodeIndex;
              const isToolRunning =
                node.kind === 'TOOL' && node.eventType === 'tool_start' && isActive === true;
              const isToolDone = node.kind === 'TOOL' && node.eventType === 'tool_end';
              const isCelebrating = celebrating.has(node.id);
              const style = getNodeStyle(node.kind, isLastTurnActive);

              let nodeAnimation: string;
              let nodeAnimationDelay: string;
              const ease = 'cubic-bezier(0.16, 1, 0.3, 1)';
              if (node.kind === 'TOOL') {
                if (isToolRunning && isBreathing) {
                  nodeAnimation = `exec-graph-tool-enter 300ms ${ease} forwards, exec-graph-active-ring 1.6s ease-in-out infinite`;
                  nodeAnimationDelay = `${slotIdx * 60}ms, 0ms`;
                } else if (isCelebrating) {
                  nodeAnimation = `exec-graph-complete-pop 420ms ${ease}, exec-graph-complete-ring 500ms ease-out`;
                  nodeAnimationDelay = '0ms, 0ms';
                } else {
                  nodeAnimation = `exec-graph-tool-enter 300ms ${ease} forwards`;
                  nodeAnimationDelay = `${slotIdx * 60}ms`;
                }
              } else if (isBreathing) {
                nodeAnimation = `exec-graph-appear 300ms ${ease} forwards, exec-graph-breathe 1.4s ease-in-out infinite`;
                nodeAnimationDelay = `${slotIdx * 60}ms, 0ms`;
              } else {
                nodeAnimation = `exec-graph-appear 300ms ${ease} forwards`;
                nodeAnimationDelay = `${slotIdx * 60}ms`;
              }

              const borderLeftColor =
                node.kind === 'GOAL'
                  ? 'var(--purple)'
                  : node.kind === 'ATTEMPT'
                    ? 'var(--warning)'
                    : node.kind === 'STEER'
                      ? 'var(--warning)'
                      : node.kind === 'REJECTED'
                        ? 'var(--error)'
                        : node.kind === 'DONE'
                          ? 'var(--success)'
                          : isLastTurnActive
                            ? 'var(--info)'
                            : node.kind === 'TURN'
                              ? 'var(--success)'
                              : 'var(--text-tertiary)';

              return (
                // biome-ignore lint/a11y/useSemanticElements: positioned card holds a nested Details button; can't be <button>
                <div
                  key={node.id}
                  data-node-card
                  role="button"
                  tabIndex={0}
                  aria-label={getNodeSummary(node)}
                  onClick={() => showDetails(node)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      showDetails(node);
                    }
                  }}
                  className={isBreathing ? 'exec-graph-node-breathe' : undefined}
                  style={{
                    position: 'absolute',
                    left: pos.x,
                    top: pos.y,
                    width: pos.w,
                    height: pos.h,
                    borderRadius: 'var(--radius-sm)',
                    cursor: 'pointer',
                    border: '1px solid var(--border-subtle)',
                    borderLeftWidth:
                      node.kind === 'GOAL' || node.kind === 'ATTEMPT' || node.kind === 'STEER'
                        ? 3
                        : 1,
                    borderLeftColor,
                    background: style.bg,
                    padding: '6px 10px',
                    overflow: 'hidden',
                    opacity: isBreathing || isCelebrating ? 1 : 0,
                    animation: nodeAnimation,
                    animationDelay: nodeAnimationDelay,
                  }}
                  title={JSON.stringify(node.payload, null, 2)}
                >
                  {isToolRunning && (
                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        borderRadius: 'inherit',
                        pointerEvents: 'none',
                        background:
                          'linear-gradient(100deg, transparent 20%, rgba(74,158,255,0.10) 50%, transparent 80%)',
                        backgroundSize: '220px 100%',
                        animation: 'exec-graph-shimmer 1.8s linear infinite',
                      }}
                    />
                  )}
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
                      <span style={{ color: 'var(--success)', fontSize: 10 }}>✓</span>
                    )}
                    {isToolRunning && (
                      <span
                        className="exec-graph-spinner"
                        style={{
                          display: 'inline-block',
                          width: 10,
                          height: 10,
                          border: '1.5px solid var(--border-subtle)',
                          borderTopColor: 'var(--info)',
                          borderRadius: '50%',
                          animation: 'exec-graph-spin 0.8s linear infinite',
                        }}
                      />
                    )}
                    {isToolDone && (
                      <span
                        style={{
                          color: 'var(--success)',
                          fontSize: 10,
                          display: 'inline-block',
                          animation: 'exec-graph-check-in 300ms cubic-bezier(0.16, 1, 0.3, 1)',
                        }}
                      >
                        ✓
                      </span>
                    )}
                  </div>
                  {renderNodeContent(
                    node,
                    goalText,
                    personalityId,
                    node.kind === 'TOOL' ? showDetails : undefined,
                  )}
                </div>
              );
            })}
          </div>
        )}

        {mainNodes.length > 0 && (
          <div
            data-node-card
            style={{
              position: 'absolute',
              right: 12,
              bottom: 12,
              zIndex: 5,
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              padding: 2,
            }}
          >
            <button
              type="button"
              aria-label="Zoom out"
              onClick={zoomOut}
              disabled={zoom <= MIN_ZOOM}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 28,
                height: 28,
                background: 'none',
                border: 'none',
                color: 'var(--text-secondary)',
                cursor: zoom <= MIN_ZOOM ? 'default' : 'pointer',
                opacity: zoom <= MIN_ZOOM ? 0.4 : 1,
                fontSize: 16,
              }}
            >
              −
            </button>
            <span
              style={{
                minWidth: 40,
                textAlign: 'center',
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                color: 'var(--text-tertiary)',
              }}
            >
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              aria-label="Zoom in"
              onClick={zoomIn}
              disabled={zoom >= MAX_ZOOM}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 28,
                height: 28,
                background: 'none',
                border: 'none',
                color: 'var(--text-secondary)',
                cursor: zoom >= MAX_ZOOM ? 'default' : 'pointer',
                opacity: zoom >= MAX_ZOOM ? 0.4 : 1,
                fontSize: 16,
              }}
            >
              +
            </button>
            <button
              type="button"
              aria-label="Fit to screen"
              onClick={fitToScreen}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                fontSize: 11,
                padding: '0 8px',
                height: 28,
              }}
            >
              Fit
            </button>
          </div>
        )}
      </div>
    </>
  );
}

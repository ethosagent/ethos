import { useCallback, useEffect, useRef, useState } from 'react';
import { DashboardPanel } from './DashboardPanel';
import type { DashboardsClient, Panel } from './types';

interface DashboardGridProps {
  client: DashboardsClient;
  panels: Panel[];
  onLayoutChanged: () => void;
  onRefreshPanel: (panelId: string) => void;
  onDeletePanel: (panelId: string) => void;
}

const COLS = 12;
const ROW_H = 70;
const GAP = 8;

interface DragState {
  panelId: string;
  startX: number;
  startY: number;
  origCol: number;
  origRow: number;
  dx: number;
  dy: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function DashboardGrid({
  client,
  panels,
  onLayoutChanged,
  onRefreshPanel,
  onDeletePanel,
}: DashboardGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [drag, setDrag] = useState<DragState | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setContainerWidth(el.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const colWidth = containerWidth > 0 ? containerWidth / COLS : 0;

  const handlePointerDown = useCallback(
    (panel: Panel) => (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      setDrag({
        panelId: panel.id,
        startX: e.clientX,
        startY: e.clientY,
        origCol: panel.col,
        origRow: panel.row,
        dx: 0,
        dy: 0,
      });
    },
    [],
  );

  const handlePointerMove = useCallback(
    (panel: Panel) => (e: React.PointerEvent) => {
      setDrag((prev) => {
        if (!prev || prev.panelId !== panel.id) return prev;
        return { ...prev, dx: e.clientX - prev.startX, dy: e.clientY - prev.startY };
      });
    },
    [],
  );

  const handlePointerUp = useCallback(
    (panel: Panel) => async (e: React.PointerEvent) => {
      e.currentTarget.releasePointerCapture(e.pointerId);
      const current = drag;
      setDrag(null);
      if (!current || current.panelId !== panel.id || colWidth <= 0) return;
      const newCol = clamp(
        Math.round((current.origCol * colWidth + current.dx) / colWidth),
        0,
        COLS - panel.w,
      );
      const newRow = Math.max(0, Math.round((current.origRow * ROW_H + current.dy) / ROW_H));
      if (newCol === panel.col && newRow === panel.row) return;
      try {
        await client.rpc.dashboards.updatePanelLayout({
          panelId: panel.id,
          col: newCol,
          row: newRow,
          w: panel.w,
          h: panel.h,
        });
        onLayoutChanged();
      } catch {
        // best-effort
      }
    },
    [drag, colWidth, client, onLayoutChanged],
  );

  const maxBottom = panels.reduce((acc, p) => Math.max(acc, p.row + p.h), 0);
  const totalHeight = Math.max(maxBottom * ROW_H, ROW_H * 4);

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', width: '100%', height: totalHeight, marginTop: 8 }}
    >
      {panels.map((panel) => {
        const isDragging = drag?.panelId === panel.id;
        return (
          <div
            key={panel.id}
            style={{
              position: 'absolute',
              left: `${(panel.col / COLS) * 100}%`,
              top: `${panel.row * ROW_H}px`,
              width: `calc(${(panel.w / COLS) * 100}% - ${GAP}px)`,
              height: `${panel.h * ROW_H - GAP}px`,
              transform: isDragging ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined,
              zIndex: isDragging ? 10 : undefined,
            }}
          >
            <DashboardPanel
              panel={panel}
              onRefresh={onRefreshPanel}
              onDelete={onDeletePanel}
              onDragHandlePointerDown={handlePointerDown(panel)}
              onDragHandlePointerMove={handlePointerMove(panel)}
              onDragHandlePointerUp={handlePointerUp(panel)}
            />
          </div>
        );
      })}
    </div>
  );
}

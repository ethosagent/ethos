import { useCallback, useEffect, useState } from 'react';
import { DashboardGrid } from './DashboardGrid';
import { ParamFilterBar } from './ParamFilterBar';
import { ParamSchemaEditor } from './ParamSchemaEditor';
import type { Dashboard, DashboardsClient, Panel, ParamDef } from './types';

interface DashboardViewProps {
  client: DashboardsClient;
  dashboardId: string;
  onBack: () => void;
}

const COLS = 12;

const headerButtonStyle: React.CSSProperties = {
  height: 28,
  padding: '0 12px',
  background: 'none',
  border: '1px solid var(--border-subtle)',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 13,
  color: 'var(--text-secondary)',
};

export function DashboardView({ client, dashboardId, onBack }: DashboardViewProps) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [panels, setPanels] = useState<Panel[]>([]);
  const [paramsDrawerOpen, setParamsDrawerOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await client.rpc.dashboards.get({ id: dashboardId });
      setDashboard(res.dashboard);
      setPanels(res.panels);
    } catch {
      // best-effort
    }
  }, [client, dashboardId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const interval = setInterval(() => {
      load();
    }, 15_000);
    return () => clearInterval(interval);
  }, [load]);

  const handleRefreshAll = useCallback(async () => {
    try {
      await client.rpc.dashboards.refreshAll({ dashboardId });
      await load();
    } catch {
      // best-effort
    }
  }, [client, dashboardId, load]);

  const handleRefreshPanel = useCallback(
    async (panelId: string) => {
      try {
        await client.rpc.dashboards.refreshPanel({ panelId });
        await load();
      } catch {
        // best-effort
      }
    },
    [client, load],
  );

  const handleDeletePanel = useCallback(
    async (panelId: string) => {
      const confirmed = await window.ethos.dialog.showMessage({
        type: 'warning',
        message: 'Delete this panel?',
        buttons: ['Cancel', 'Delete'],
      });
      if (confirmed.response !== 1) return;
      try {
        await client.rpc.dashboards.deletePanel({ panelId });
        await load();
      } catch {
        // best-effort
      }
    },
    [client, load],
  );

  const handleAutoArrange = useCallback(async () => {
    const sorted = [...panels].sort((a, b) => a.row - b.row || a.col - b.col);
    let cursorCol = 0;
    let cursorRow = 0;
    let rowMaxH = 0;
    const layouts = sorted.map((panel) => {
      const targetW = panel.w > 6 ? 12 : 6;
      if (cursorCol + targetW > COLS) {
        cursorRow += Math.max(rowMaxH, 1);
        cursorCol = 0;
        rowMaxH = 0;
      }
      const h = Math.max(panel.h, 1);
      const layout = { panelId: panel.id, col: cursorCol, row: cursorRow, w: targetW, h };
      cursorCol += targetW;
      rowMaxH = Math.max(rowMaxH, h);
      return layout;
    });
    try {
      await Promise.all(layouts.map((l) => client.rpc.dashboards.updatePanelLayout(l)));
      await load();
    } catch {
      // best-effort
    }
  }, [panels, client, load]);

  const handleExport = useCallback(async () => {
    try {
      const res = await client.rpc.dashboards.exportDashboard({ id: dashboardId });
      await window.ethos.file.save({ defaultName: `${res.title}.json`, content: res.json });
    } catch {
      // best-effort
    }
  }, [client, dashboardId]);

  const handleParamsChange = useCallback(
    async (next: Record<string, string>) => {
      try {
        await client.rpc.dashboards.updateParams({ id: dashboardId, paramsCurrent: next });
        await client.rpc.dashboards.refreshAll({ dashboardId });
        await load();
      } catch {
        // best-effort
      }
    },
    [client, dashboardId, load],
  );

  const handleParamsSchemaSave = useCallback(
    async (schema: ParamDef[]) => {
      try {
        await client.rpc.dashboards.update({ id: dashboardId, paramsSchema: schema });
        setParamsDrawerOpen(false);
        await load();
      } catch {
        // best-effort
      }
    },
    [client, dashboardId, load],
  );

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            height: 40,
            padding: '0 16px',
            flexShrink: 0,
          }}
        >
          <button type="button" onClick={onBack} style={headerButtonStyle}>
            ← Back
          </button>
          <h3 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: 'var(--text-primary)' }}>
            {dashboard?.title ?? 'Dashboard'}
          </h3>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={handleRefreshAll} style={headerButtonStyle}>
            Refresh all
          </button>
          <button type="button" onClick={handleAutoArrange} style={headerButtonStyle}>
            Auto arrange
          </button>
          <button type="button" onClick={() => setParamsDrawerOpen(true)} style={headerButtonStyle}>
            Params
          </button>
          <button type="button" onClick={handleExport} style={headerButtonStyle}>
            Export
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '0 16px' }}>
          {dashboard && dashboard.paramsSchema.length > 0 ? (
            <ParamFilterBar
              schema={dashboard.paramsSchema}
              current={dashboard.paramsCurrent}
              onChange={handleParamsChange}
            />
          ) : null}
          <DashboardGrid
            client={client}
            panels={panels}
            onLayoutChanged={load}
            onRefreshPanel={handleRefreshPanel}
            onDeletePanel={handleDeletePanel}
          />
        </div>
      </div>

      <ParamSchemaEditor
        open={paramsDrawerOpen}
        schema={dashboard?.paramsSchema ?? []}
        onClose={() => setParamsDrawerOpen(false)}
        onSave={handleParamsSchemaSave}
      />
    </div>
  );
}

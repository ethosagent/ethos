import type { ToolContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  createDashboardImportTool,
  createDashboardSetParamsTool,
  createDashboardUpdatePanelTool,
  type DashboardToolStore,
} from '../dashboard-tools';

const ctx = { userId: 'u1' } as unknown as ToolContext;

function makeStore(overrides: Partial<DashboardToolStore>): DashboardToolStore {
  return {
    exists: () => true,
    updateParamsSchema: () => {},
    updateDashboardParams: () => {},
    importDashboard: () => ({ dashboardId: 'd1', warnings: [] }),
    getPanel: () => ({ id: 'panel1', col: 0, row: 0, w: 6, h: 4 }),
    updatePanel: () => {},
    ...overrides,
  } as unknown as DashboardToolStore;
}

describe('dashboard_set_params surfaces store validation errors (WEB-004 4b)', () => {
  it('returns input_invalid when the store rejects a param value', async () => {
    const store = makeStore({
      updateDashboardParams: () => {
        throw new Error('Dashboard param value(s) not permitted by the parameter schema: region');
      },
    });
    const tool = createDashboardSetParamsTool(store);
    const result = await tool.execute(
      { dashboard_id: 'd1', params_current: { region: "us' OR 1=1" } },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('input_invalid');
      expect(result.error).toMatch(/param/i);
    }
  });

  it('returns ok when the store accepts the params', async () => {
    const store = makeStore({});
    const tool = createDashboardSetParamsTool(store);
    const result = await tool.execute(
      { dashboard_id: 'd1', params_current: { region: 'us' } },
      ctx,
    );
    expect(result.ok).toBe(true);
  });
});

describe('dashboard_update_panel surfaces store validation errors (WEB-004 4d)', () => {
  it('returns input_invalid when the store rejects a paramDefault', async () => {
    const store = makeStore({
      updatePanel: () => {
        throw new Error('Dashboard param value(s) not permitted by the parameter schema: region');
      },
    });
    const tool = createDashboardUpdatePanelTool(store);
    const result = await tool.execute(
      { panel_id: 'panel1', param_defaults: { region: "us' OR 1=1" } },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('input_invalid');
      expect(result.error).toMatch(/param/i);
    }
  });
});

describe('dashboard_import surfaces store validation errors (WEB-004 4c)', () => {
  it('returns input_invalid when the store rejects the payload', async () => {
    const store = makeStore({
      importDashboard: () => {
        throw new Error('SQL query must start with SELECT');
      },
    });
    const tool = createDashboardImportTool(store);
    const result = await tool.execute(
      { export_json: JSON.stringify({ version: 1, title: 'X', panels: [] }) },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('input_invalid');
      expect(result.error).toMatch(/SELECT/i);
    }
  });
});

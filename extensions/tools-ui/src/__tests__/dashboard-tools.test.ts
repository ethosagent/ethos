import type { ToolContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  createDashboardAddPanelTool,
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

describe('dashboard SQL guard on the agent tool path', () => {
  const multi = 'SELECT 1; DELETE FROM dashboards';
  const refuse = () => {
    throw new Error('SQL query must not contain multiple statements');
  };

  it('dashboard_add_panel rejects a non-SELECT before reaching the store', async () => {
    let called = false;
    const store = makeStore({
      verifyOwner: () => true,
      addPanel: () => {
        called = true;
        return { id: 'p' };
      },
    });
    const tool = createDashboardAddPanelTool(store);
    const result = await tool.execute(
      {
        dashboard_id: 'd1',
        block_type: 'table',
        content: '[]',
        query_type: 'sql',
        sql_query: 'DELETE FROM dashboards',
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('dashboard_add_panel turns a store refusal of a multi-statement query into a tool error', async () => {
    const store = makeStore({ verifyOwner: () => true, getNextRow: () => 0, addPanel: refuse });
    const tool = createDashboardAddPanelTool(store);
    const result = await tool.execute(
      {
        dashboard_id: 'd1',
        block_type: 'table',
        content: '[]',
        query_type: 'sql',
        sql_query: multi,
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('input_invalid');
      expect(result.error).toMatch(/multiple statements/);
    }
  });

  it('dashboard_update_panel turns a store refusal of a multi-statement query into a tool error', async () => {
    const store = makeStore({ updatePanel: refuse });
    const tool = createDashboardUpdatePanelTool(store);
    const result = await tool.execute({ panel_id: 'panel1', sql_query: multi }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('input_invalid');
      expect(result.error).toMatch(/multiple statements/);
    }
  });
});

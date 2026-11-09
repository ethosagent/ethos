import { EthosError, type ToolContext } from '@ethosagent/types';
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
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: 'SQL query must not contain multiple statements',
      action: 'Submit a single SELECT statement.',
    });
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
      expect(result).toMatchObject({ field: 'sql_query' });
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
      expect(result).toMatchObject({ field: 'sql_query' });
      expect(result.error).toMatch(/multiple statements/);
    }
  });

  it('dashboard_update_panel reports the SELECT refusal against sql_query', async () => {
    const store = makeStore({
      updatePanel: () => {
        throw new EthosError({
          code: 'INVALID_INPUT',
          cause: 'SQL query must start with SELECT',
          action: 'Submit a SELECT statement.',
        });
      },
    });
    const tool = createDashboardUpdatePanelTool(store);
    const result = await tool.execute({ panel_id: 'panel1', sql_query: 'x' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result).toMatchObject({ field: 'sql_query' });
  });

  it('dashboard_add_panel does not report a non-validation store failure as input_invalid', async () => {
    const store = makeStore({
      verifyOwner: () => true,
      getNextRow: () => 0,
      addPanel: () => {
        throw new Error('SQLITE_FULL: database or disk is full');
      },
    });
    const tool = createDashboardAddPanelTool(store);
    await expect(
      tool.execute(
        {
          dashboard_id: 'd1',
          block_type: 'table',
          content: '[]',
          query_type: 'sql',
          sql_query: 'SELECT 1',
        },
        ctx,
      ),
    ).rejects.toThrow(/SQLITE_FULL/);
  });

  it('dashboard_add_panel does not map a non-INVALID_INPUT EthosError to input_invalid', async () => {
    const store = makeStore({
      verifyOwner: () => true,
      getNextRow: () => 0,
      addPanel: () => {
        throw new EthosError({
          code: 'TOOL_EXECUTION_FAILED',
          cause: 'disk full',
          action: 'Free space.',
        });
      },
    });
    const tool = createDashboardAddPanelTool(store);
    await expect(
      tool.execute(
        {
          dashboard_id: 'd1',
          block_type: 'table',
          content: '[]',
          query_type: 'sql',
          sql_query: 'SELECT 1',
        },
        ctx,
      ),
    ).rejects.toThrow(/disk full/);
  });
});

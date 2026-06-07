import { beforeEach, describe, expect, it } from 'vitest';
import { DashboardsService } from '../dashboards.service';

describe('DashboardsService', () => {
  let svc: DashboardsService;

  beforeEach(() => {
    svc = new DashboardsService({ dbPath: ':memory:' });
  });

  // -----------------------------------------------------------------------
  // Dashboard CRUD
  // -----------------------------------------------------------------------

  it('creates and lists dashboards', () => {
    const d = svc.create('user-1', 'My Dashboard', 'persona-1', 'A description');
    expect(d.id).toBeTruthy();
    expect(d.userId).toBe('user-1');
    expect(d.title).toBe('My Dashboard');
    expect(d.personalityId).toBe('persona-1');
    expect(d.description).toBe('A description');

    const list = svc.list('user-1');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(d.id);
  });

  it('lists only dashboards for the given user', () => {
    svc.create('user-1', 'D1', 'p1');
    svc.create('user-2', 'D2', 'p1');

    expect(svc.list('user-1')).toHaveLength(1);
    expect(svc.list('user-2')).toHaveLength(1);
  });

  it('gets dashboard with panels', () => {
    const d = svc.create('user-1', 'Dash', 'p1');
    svc.addPanel(d.id, {
      queryType: 'static',
      blockType: 'html',
      content: '<h1>hi</h1>',
    });

    const result = svc.get(d.id);
    expect(result).not.toBeNull();
    expect(result?.dashboard.id).toBe(d.id);
    expect(result?.panels).toHaveLength(1);
    expect(result?.panels[0].content).toBe('<h1>hi</h1>');
  });

  it('returns null for non-existent dashboard', () => {
    expect(svc.get('non-existent')).toBeNull();
  });

  it('updates dashboard title and description', () => {
    const d = svc.create('user-1', 'Old Title', 'p1');
    svc.update(d.id, { title: 'New Title', description: 'New desc' });
    const result = svc.get(d.id);
    expect(result?.dashboard.title).toBe('New Title');
    expect(result?.dashboard.description).toBe('New desc');
  });

  it('deletes dashboard and cascades to panels', () => {
    const d = svc.create('user-1', 'To Delete', 'p1');
    const panel = svc.addPanel(d.id, {
      queryType: 'static',
      blockType: 'text',
      content: 'hello',
    });

    svc.delete(d.id);
    expect(svc.get(d.id)).toBeNull();
    expect(svc.getPanel(panel.id)).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Panel CRUD
  // -----------------------------------------------------------------------

  it('adds static panel with correct grid position', () => {
    const d = svc.create('user-1', 'D', 'p1');
    const p = svc.addPanel(d.id, {
      queryType: 'static',
      blockType: 'html',
      content: '<p>hi</p>',
    });

    expect(p.col).toBe(0);
    expect(p.row).toBe(0);
    expect(p.w).toBe(6);
    expect(p.h).toBe(4);
  });

  it('places second panel next to the first', () => {
    const d = svc.create('user-1', 'D', 'p1');
    svc.addPanel(d.id, {
      queryType: 'static',
      blockType: 'html',
      content: 'first',
    });
    const p2 = svc.addPanel(d.id, {
      queryType: 'static',
      blockType: 'html',
      content: 'second',
    });

    // First takes cols 0-5, second should start at col 6
    expect(p2.col).toBe(6);
    expect(p2.row).toBe(0);
  });

  it('wraps to next row when grid is full', () => {
    const d = svc.create('user-1', 'D', 'p1');
    // Two 6-col panels fill row 0
    svc.addPanel(d.id, {
      queryType: 'static',
      blockType: 'html',
      content: 'a',
    });
    svc.addPanel(d.id, {
      queryType: 'static',
      blockType: 'html',
      content: 'b',
    });
    // Third should go to a new row
    const p3 = svc.addPanel(d.id, {
      queryType: 'static',
      blockType: 'html',
      content: 'c',
    });

    expect(p3.col).toBe(0);
    expect(p3.row).toBeGreaterThan(0);
  });

  it('assigns correct default sizes by block type', () => {
    const d = svc.create('user-1', 'D', 'p1');

    const table = svc.addPanel(d.id, {
      queryType: 'static',
      blockType: 'table',
      content: '[]',
    });
    expect(table.w).toBe(6);
    expect(table.h).toBe(4);

    const image = svc.addPanel(d.id, {
      queryType: 'static',
      blockType: 'image',
      content: 'data:image/png;base64,...',
    });
    expect(image.w).toBe(4);
    expect(image.h).toBe(3);

    const text = svc.addPanel(d.id, {
      queryType: 'static',
      blockType: 'text',
      content: 'hello',
    });
    expect(text.w).toBe(4);
    expect(text.h).toBe(2);

    const pdf = svc.addPanel(d.id, {
      queryType: 'static',
      blockType: 'pdf',
      content: 'data:application/pdf;base64,...',
    });
    expect(pdf.w).toBe(6);
    expect(pdf.h).toBe(4);
  });

  // -----------------------------------------------------------------------
  // SQL validation
  // -----------------------------------------------------------------------

  it('accepts valid SELECT query', () => {
    const d = svc.create('user-1', 'D', 'p1');
    const p = svc.addPanel(d.id, {
      queryType: 'sql',
      blockType: 'table',
      content: '[]',
      sqlQuery: 'SELECT * FROM users',
      pluginId: 'my-plugin',
      dataSourceId: 'ds-1',
    });
    expect(p.sqlQuery).toBe('SELECT * FROM users');
  });

  it('accepts SELECT with trailing semicolon', () => {
    const d = svc.create('user-1', 'D', 'p1');
    const p = svc.addPanel(d.id, {
      queryType: 'sql',
      blockType: 'table',
      content: '[]',
      sqlQuery: 'SELECT * FROM users;',
      pluginId: 'my-plugin',
      dataSourceId: 'ds-1',
    });
    expect(p.sqlQuery).toBe('SELECT * FROM users;');
  });

  it('rejects non-SELECT SQL query', () => {
    const d = svc.create('user-1', 'D', 'p1');
    expect(() =>
      svc.addPanel(d.id, {
        queryType: 'sql',
        blockType: 'table',
        content: '[]',
        sqlQuery: 'DROP TABLE users',
        pluginId: 'my-plugin',
        dataSourceId: 'ds-1',
      }),
    ).toThrow('SQL query must start with SELECT');
  });

  it('rejects SQL with multiple statements', () => {
    const d = svc.create('user-1', 'D', 'p1');
    expect(() =>
      svc.addPanel(d.id, {
        queryType: 'sql',
        blockType: 'table',
        content: '[]',
        sqlQuery: 'SELECT 1; DROP TABLE users',
        pluginId: 'my-plugin',
        dataSourceId: 'ds-1',
      }),
    ).toThrow('SQL query must not contain multiple statements');
  });

  it('rejects sql queryType without sqlQuery', () => {
    const d = svc.create('user-1', 'D', 'p1');
    expect(() =>
      svc.addPanel(d.id, {
        queryType: 'sql',
        blockType: 'table',
        content: '[]',
      }),
    ).toThrow('sqlQuery is required');
  });

  // -----------------------------------------------------------------------
  // Panel updates
  // -----------------------------------------------------------------------

  it('updates panel layout', () => {
    const d = svc.create('user-1', 'D', 'p1');
    const p = svc.addPanel(d.id, {
      queryType: 'static',
      blockType: 'text',
      content: 'hi',
    });

    svc.updatePanelLayout(p.id, { col: 3, row: 2, w: 8, h: 5 });
    const updated = svc.getPanel(p.id);
    expect(updated?.col).toBe(3);
    expect(updated?.row).toBe(2);
    expect(updated?.w).toBe(8);
    expect(updated?.h).toBe(5);
  });

  it('updates panel content', () => {
    const d = svc.create('user-1', 'D', 'p1');
    const p = svc.addPanel(d.id, {
      queryType: 'static',
      blockType: 'text',
      content: 'old',
    });

    svc.updatePanelContent(p.id, 'new');
    expect(svc.getPanel(p.id)?.content).toBe('new');
  });

  it('sets and clears panel error', () => {
    const d = svc.create('user-1', 'D', 'p1');
    const p = svc.addPanel(d.id, {
      queryType: 'sql',
      blockType: 'table',
      content: '[]',
      sqlQuery: 'SELECT 1',
    });

    svc.setPanelError(p.id, 'connection failed');
    expect(svc.getPanel(p.id)?.lastError).toBe('connection failed');

    svc.clearPanelError(p.id);
    expect(svc.getPanel(p.id)?.lastError).toBeNull();
  });

  it('deletes a panel', () => {
    const d = svc.create('user-1', 'D', 'p1');
    const p = svc.addPanel(d.id, {
      queryType: 'static',
      blockType: 'text',
      content: 'hi',
    });

    svc.deletePanel(p.id);
    expect(svc.getPanel(p.id)).toBeNull();
  });

  it('lists live panels (non-static)', () => {
    const d = svc.create('user-1', 'D', 'p1');
    svc.addPanel(d.id, {
      queryType: 'static',
      blockType: 'text',
      content: 'static',
    });
    svc.addPanel(d.id, {
      queryType: 'sql',
      blockType: 'table',
      content: '[]',
      sqlQuery: 'SELECT 1',
    });
    svc.addPanel(d.id, {
      queryType: 'prompt',
      blockType: 'html',
      content: '',
      prompt: 'summarize',
    });

    const live = svc.listLivePanels(d.id);
    expect(live).toHaveLength(2);
    expect(live.every((p) => p.queryType !== 'static')).toBe(true);
  });

  it('stores and retrieves panel metadata as JSON', () => {
    const d = svc.create('user-1', 'D', 'p1');
    const meta = { alt: 'chart', source: 'conversation-123' };
    const p = svc.addPanel(d.id, {
      queryType: 'static',
      blockType: 'image',
      content: 'data:image/png;base64,...',
      metadata: meta,
    });

    expect(p.metadata).toEqual(meta);
    const fetched = svc.getPanel(p.id);
    expect(fetched?.metadata).toEqual(meta);
  });
});

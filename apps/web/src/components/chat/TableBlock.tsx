import { Table } from 'antd';
import { useMemo } from 'react';

interface Props {
  data: string;
}

export function TableBlock({ data }: Props) {
  const { columns, rows } = useMemo(() => {
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>[];
      if (!Array.isArray(parsed) || parsed.length === 0) return { columns: [], rows: [] };
      const firstRow = parsed[0];
      if (!firstRow) return { columns: [], rows: [] };
      const cols = Object.keys(firstRow).map((key) => ({
        title: key,
        dataIndex: key,
        key,
        sorter: (a: Record<string, unknown>, b: Record<string, unknown>) => {
          const va = a[key];
          const vb = b[key];
          if (typeof va === 'number' && typeof vb === 'number') return va - vb;
          return String(va ?? '').localeCompare(String(vb ?? ''));
        },
      }));
      const mappedRows = parsed.map((row, i) => ({ ...row, key: i }));
      return { columns: cols, rows: mappedRows };
    } catch {
      return { columns: [], rows: [] };
    }
  }, [data]);

  if (columns.length === 0) return <div style={{ color: '#888' }}>No data</div>;

  return (
    <Table
      columns={columns}
      dataSource={rows}
      size="small"
      pagination={{ pageSize: 20, hideOnSinglePage: true }}
      scroll={{ x: 'max-content' }}
    />
  );
}

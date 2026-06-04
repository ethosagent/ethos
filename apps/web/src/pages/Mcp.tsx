import type { McpServerInfo } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Empty, Popconfirm, Table, Tag, Tooltip, Typography } from 'antd';
import { useState } from 'react';
import { AddMcpModal } from '../components/mcp/AddMcpModal';
import { McpServerActions } from '../components/mcp/McpServerActions';
import { rpc } from '../rpc';

export function Mcp() {
  const [addMcpOpen, setAddMcpOpen] = useState(false);

  const {
    data: pluginsData,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['plugins', 'list'],
    queryFn: () => rpc.plugins.list(),
  });

  if (error) {
    return (
      <Typography.Text type="danger">
        Failed to load MCP servers: {(error as Error).message}
      </Typography.Text>
    );
  }

  const mcpServers = pluginsData?.mcpServers ?? [];

  return (
    <div className="plugins-tab">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 16,
        }}
      >
        <Typography.Title level={4} style={{ margin: 0 }}>
          MCP Servers
        </Typography.Title>
        <Button type="primary" onClick={() => setAddMcpOpen(true)}>
          Add MCP
        </Button>
      </div>
      <McpTable servers={mcpServers} loading={isLoading} />
      <AddMcpModal open={addMcpOpen} onClose={() => setAddMcpOpen(false)} />
    </div>
  );
}

function McpTable({ servers, loading }: { servers: McpServerInfo[]; loading?: boolean }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  const deleteMut = useMutation({
    mutationFn: (name: string) => rpc.mcp.delete({ name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plugins'] });
      qc.invalidateQueries({ queryKey: ['mcp', 'list'] });
    },
    onError: (err) => {
      notification.error({
        message: 'Delete failed',
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  if (loading) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'rgba(255,255,255,0.45)' }}>
        Loading...
      </div>
    );
  }

  if (servers.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <span>
            No MCP servers configured. Click <strong>Add MCP</strong> above, or run{' '}
            <Typography.Text code>ethos mcp add</Typography.Text> from the CLI.
          </span>
        }
      />
    );
  }

  return (
    <Table<McpServerInfo>
      rowKey="name"
      dataSource={servers}
      pagination={false}
      size="small"
      columns={[
        {
          title: 'Name',
          dataIndex: 'name',
          key: 'name',
          render: (name: string) => <strong>{name}</strong>,
        },
        {
          title: 'Transport',
          dataIndex: 'transport',
          key: 'transport',
          width: 150,
          render: (t: string) => (
            <span>
              <Tag bordered={false}>{t}</Tag>
              {t === 'sse' ? (
                <Tag color="warning" bordered={false} style={{ fontSize: 11, marginLeft: 4 }}>
                  deprecated
                </Tag>
              ) : null}
            </span>
          ),
        },
        {
          title: 'Endpoint',
          key: 'endpoint',
          render: (_, server) =>
            server.transport === 'stdio' ? (
              server.command ? (
                <Typography.Text code style={{ fontSize: 11 }}>
                  {server.command}
                </Typography.Text>
              ) : (
                <Typography.Text type="secondary">missing command</Typography.Text>
              )
            ) : server.url ? (
              <Typography.Text code style={{ fontSize: 11 }}>
                {server.url}
              </Typography.Text>
            ) : (
              <Typography.Text type="secondary">missing url</Typography.Text>
            ),
        },
        {
          title: 'Auth',
          key: 'auth',
          width: 100,
          render: (_, server) => {
            const s = server.auth_status;
            if (!s || s === 'none') return <Tag bordered={false}>none</Tag>;
            if (s === 'authorized')
              return (
                <Tag color="green" bordered={false}>
                  authorized
                </Tag>
              );
            if (s === 'expired')
              return (
                <Tag color="orange" bordered={false}>
                  expired
                </Tag>
              );
            if (s === 'missing')
              return (
                <Tag color="red" bordered={false}>
                  missing
                </Tag>
              );
            if (s === 'pending')
              return (
                <Tag color="blue" bordered={false}>
                  pending
                </Tag>
              );
            return null;
          },
        },
        {
          title: 'Attached to',
          key: 'attached',
          render: (_: unknown, server: McpServerInfo) => (
            <AttachedPersonalitiesCell serverName={server.name} />
          ),
        },
        {
          title: '',
          key: 'actions',
          width: 260,
          render: (_, server) => (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <McpServerActions
                serverName={server.name}
                transport={server.transport}
                authStatus={server.auth_status}
              />
              <Popconfirm
                title="Remove this server?"
                description="This removes the server definition and any stored tokens. Personalities that reference it will lose the connection."
                okText="Remove"
                okButtonProps={{ danger: true }}
                onConfirm={() => deleteMut.mutate(server.name)}
              >
                <Button
                  size="small"
                  danger
                  loading={
                    deleteMut.isPending &&
                    (deleteMut.variables as string | undefined) === server.name
                  }
                >
                  Remove
                </Button>
              </Popconfirm>
            </div>
          ),
        },
      ]}
    />
  );
}

function AttachedPersonalitiesCell({ serverName }: { serverName: string }) {
  const { data } = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list({}),
  });
  const attached = (data?.items ?? []).filter((p) => (p.mcp_servers ?? []).includes(serverName));
  if (attached.length === 0) {
    return <Typography.Text type="secondary">none</Typography.Text>;
  }
  return (
    <Tooltip title={attached.map((p) => p.id).join(', ')}>
      <span>
        {attached
          .slice(0, 3)
          .map((p) => p.name)
          .join(', ')}
        {attached.length > 3 ? ` +${attached.length - 3}` : ''}
      </span>
    </Tooltip>
  );
}

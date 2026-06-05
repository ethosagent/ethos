import type { MeshAgent } from '@ethosagent/web-contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { App as AntApp, Button, Empty, Form, Input, Spin, Typography } from 'antd';
import { type MeshNode, MeshTopology } from '../components/ui/MeshTopology';
import { StatusDot } from '../components/ui/StatusDot';
import { rpc } from '../rpc';

// Mesh tab — swarm pillar of v0.5.
//
// Two parts: an SVG topology canvas showing gateway + agent nodes,
// and a status table. Below: route test for capability-based routing.

function agentToNode(agent: MeshAgent): MeshNode {
  const elapsed = Date.now() - new Date(agent.lastSeenAt).getTime();
  let status: MeshNode['status'] = 'healthy';
  if (elapsed > 30_000) status = 'error';
  else if (elapsed > 15_000) status = 'reconnecting';

  return {
    id: agent.agentId,
    name: agent.agentId,
    type: 'agent',
    status,
  };
}

function statusForAgent(agent: MeshAgent): 'connected' | 'connecting' | 'offline' {
  const elapsed = Date.now() - new Date(agent.lastSeenAt).getTime();
  if (elapsed > 30_000) return 'offline';
  if (elapsed > 15_000) return 'connecting';
  return 'connected';
}

function statusLabel(s: 'connected' | 'connecting' | 'offline'): string {
  if (s === 'connected') return 'Healthy';
  if (s === 'connecting') return 'Reconnecting';
  return 'Offline';
}

export function Mesh() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['mesh', 'list'],
    queryFn: () => rpc.mesh.list(),
    refetchInterval: 15_000,
  });

  if (isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }
  if (error) {
    return (
      <Typography.Text type="danger">
        Failed to load mesh: {(error as Error).message}
      </Typography.Text>
    );
  }

  const agents = data?.agents ?? [];

  const topologyNodes: MeshNode[] = [
    { id: 'gateway', name: 'gateway', type: 'gateway', status: 'healthy' },
    ...agents.map(agentToNode),
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Page header */}
      <div>
        <h1
          style={{
            fontSize: 20,
            fontWeight: 600,
            color: 'var(--text-primary)',
            margin: 0,
            lineHeight: 1.3,
          }}
        >
          Mesh
        </h1>
        <p
          style={{
            fontSize: 13,
            color: 'var(--text-secondary)',
            margin: '2px 0 0',
          }}
        >
          Agent network topology
        </p>
      </div>

      {/* SVG topology canvas */}
      <MeshTopology nodes={topologyNodes} />

      {/* Status table */}
      <div
        style={{
          maxHeight: 200,
          overflowY: 'auto',
          marginTop: 0,
        }}
      >
        {/* Column headers */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            height: 28,
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <span style={{ ...colHeader, flex: 1 }}>NODE</span>
          <span style={{ ...colHeader, width: 120 }}>STATUS</span>
          <span style={{ ...colHeader, width: 80 }}>SESSIONS</span>
          <span style={{ ...colHeader, width: 80 }}>LATENCY</span>
        </div>

        {agents.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No mesh peers registered. Run another `ethos serve` to see it here."
            style={{ padding: '24px 0' }}
          />
        ) : (
          agents.map((agent) => {
            const s = statusForAgent(agent);
            return (
              <div
                key={agent.agentId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  height: 36,
                  borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                <span
                  style={{
                    flex: 1,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    color: 'var(--text-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {agent.agentId}
                </span>
                <span
                  style={{
                    width: 120,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    flexShrink: 0,
                  }}
                >
                  <StatusDot status={s} size={8} />
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12,
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {statusLabel(s)}
                  </span>
                </span>
                <span
                  style={{
                    width: 80,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    color: 'var(--text-tertiary)',
                    fontVariantNumeric: 'tabular-nums',
                    flexShrink: 0,
                  }}
                >
                  {agent.activeSessions}
                </span>
                <span
                  style={{
                    width: 80,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    color: 'var(--text-tertiary)',
                    fontVariantNumeric: 'tabular-nums',
                    flexShrink: 0,
                  }}
                >
                  &mdash;
                </span>
              </div>
            );
          })
        )}
      </div>

      {/* Toolbar: refresh + count */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--text-tertiary)',
          }}
        >
          {agents.length} {agents.length === 1 ? 'agent' : 'agents'} live
        </span>
        <Button size="small" onClick={() => void refetch()} loading={isFetching}>
          Refresh
        </Button>
      </div>

      {/* Route test */}
      <RouteTest />
    </div>
  );
}

const colHeader: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  fontFamily: 'var(--font-mono)',
  color: 'var(--text-tertiary)',
};

function RouteTest() {
  const { notification } = AntApp.useApp();
  const [form] = Form.useForm<{ capability: string }>();

  const routeMut = useMutation({
    mutationFn: (capability: string) => rpc.mesh.routeTest({ capability }),
    onSuccess: (result) => {
      if (result.ok && result.routedTo) {
        notification.success({
          message: `Routed to ${result.routedTo}`,
          description: 'The mesh would dispatch a task with this capability to this peer.',
          placement: 'topRight',
        });
      } else {
        notification.warning({
          message: 'No peer available',
          description: result.reason ?? 'No live mesh agent advertises this capability.',
          placement: 'topRight',
        });
      }
    },
    onError: (err) =>
      notification.error({ message: 'Route failed', description: (err as Error).message }),
  });

  return (
    <section style={{ marginTop: 8 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 500,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--text-tertiary)',
          marginBottom: 8,
        }}
      >
        ROUTE TEST
      </div>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        Pick the agent the mesh would route a task to, given a capability. Doesn't dispatch any
        work.
      </Typography.Paragraph>
      <Form form={form} layout="inline" onFinish={(values) => routeMut.mutate(values.capability)}>
        <Form.Item
          name="capability"
          rules={[{ required: true, message: 'Required' }]}
          style={{ flexGrow: 1, minWidth: 240 }}
        >
          <Input placeholder="e.g. code, web, delegate" autoComplete="off" />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={routeMut.isPending}>
            Test
          </Button>
        </Form.Item>
      </Form>
    </section>
  );
}

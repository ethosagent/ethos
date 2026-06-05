import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppState } from '../../state/AppContext';
import { type MeshNode, MeshTopology } from '../../ui/MeshTopology';
import type { MeshAgent } from './AgentTable';
import { AgentTable } from './AgentTable';
import { RegisterAgentDrawer } from './RegisterAgentDrawer';
import { RouteTestSection } from './RouteTestSection';

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

export function MeshPage() {
  const { state } = useAppState();
  const { port } = state;

  const client = useMemo(
    () => createEthosClient({ baseUrl: `http://localhost:${port}`, fetch: globalThis.fetch }),
    [port],
  );

  const [agents, setAgents] = useState<MeshAgent[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const loadAgents = useCallback(async () => {
    try {
      const res = await client.rpc.mesh.list({});
      setAgents(
        res.agents.map((a) => ({
          agentId: a.agentId,
          capabilities: a.capabilities,
          activeSessions: a.activeSessions,
          lastSeenAt: a.lastSeenAt,
        })),
      );
    } catch {
      // best-effort
    }
  }, [client]);

  useEffect(() => {
    loadAgents();
    const interval = setInterval(() => void loadAgents(), 15_000);
    return () => clearInterval(interval);
  }, [loadAgents]);

  const topologyNodes: MeshNode[] = [
    { id: 'gateway', name: 'gateway', type: 'gateway', status: 'healthy' },
    ...agents.map(agentToNode),
  ];

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
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

      {/* Agent table + register */}
      <AgentTable agents={agents} onRegister={() => setDrawerOpen(true)} />

      {/* Route test */}
      <RouteTestSection />

      {/* Register drawer */}
      <RegisterAgentDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </div>
  );
}

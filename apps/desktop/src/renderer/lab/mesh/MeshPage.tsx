import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useServerUrl } from '../../shell/ServerUrl';
import type { MeshAgent } from './AgentTable';
import { AgentTable } from './AgentTable';
import { RegisterAgentDrawer } from './RegisterAgentDrawer';
import { RouteTestSection } from './RouteTestSection';

export function MeshPage() {
  const baseUrl = useServerUrl();
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

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
  }, [loadAgents]);

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 24 }}>
      <AgentTable agents={agents} onRegister={() => setDrawerOpen(true)} />
      <RouteTestSection />
      <RegisterAgentDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </div>
  );
}

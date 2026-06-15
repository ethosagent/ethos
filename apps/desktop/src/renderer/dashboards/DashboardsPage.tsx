import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useServerUrl } from '../shell/ServerUrl';
import { CreateDashboardFlow } from './CreateDashboardFlow';
import { DashboardList } from './DashboardList';
import { DashboardView } from './DashboardView';
import type { Personality } from './types';

export function DashboardsPage() {
  const baseUrl = useServerUrl();
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [view, setView] = useState<'list' | 'detail' | 'create'>('list');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [personalities, setPersonalities] = useState<Personality[]>([]);
  const [defaultPersonalityId, setDefaultPersonalityId] = useState('');

  const loadPersonalities = useCallback(async () => {
    try {
      const res = await client.rpc.personalities.list({});
      setPersonalities(res.items);
      setDefaultPersonalityId(res.defaultId);
    } catch {
      // best-effort
    }
  }, [client]);

  useEffect(() => {
    loadPersonalities();
  }, [loadPersonalities]);

  const handleOpen = useCallback((id: string) => {
    setSelectedId(id);
    setView('detail');
  }, []);

  const handleCreate = useCallback(() => {
    setView('create');
  }, []);

  const handleImported = useCallback((id: string) => {
    setSelectedId(id);
    setView('detail');
  }, []);

  const handleBack = useCallback(() => {
    setView('list');
  }, []);

  if (view === 'detail' && selectedId) {
    return <DashboardView client={client} dashboardId={selectedId} onBack={handleBack} />;
  }

  if (view === 'create') {
    return (
      <CreateDashboardFlow
        client={client}
        personalities={personalities}
        onCreated={handleOpen}
        onCancel={handleBack}
      />
    );
  }

  return (
    <DashboardList
      client={client}
      personalities={personalities}
      defaultPersonalityId={defaultPersonalityId}
      onOpen={handleOpen}
      onCreate={handleCreate}
      onImported={handleImported}
    />
  );
}

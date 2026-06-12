import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useServerUrl } from '../shell/ServerUrl';
import { PersonalityEditor } from './PersonalityEditor';
import { PersonalityList } from './PersonalityList';
import { PersonalityWizard } from './PersonalityWizard';

interface PersonalityListItem {
  id: string;
  name: string;
  description: string | null;
  builtin: boolean;
}

export function PersonalitiesPage() {
  const baseUrl = useServerUrl();
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [personalities, setPersonalities] = useState<PersonalityListItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);

  const loadList = useCallback(async () => {
    try {
      const res = await client.rpc.personalities.list({});
      setPersonalities(
        res.items.map(
          (p: { id: string; name: string; description: string | null; builtin: boolean }) => ({
            id: p.id,
            name: p.name,
            description: p.description,
            builtin: p.builtin,
          }),
        ),
      );
    } catch {
      // best-effort
    }
  }, [client]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  const handleSelect = useCallback((id: string) => {
    setIsNew(false);
    setActiveId(id);
  }, []);

  const handleNew = useCallback(() => {
    setIsNew(true);
    setActiveId(null);
  }, []);

  const handleSaved = useCallback(
    (savedId?: string) => {
      loadList();
      if (savedId) {
        setActiveId(savedId);
        setIsNew(false);
      }
    },
    [loadList],
  );

  const handleDeleted = useCallback(() => {
    setActiveId(null);
    setIsNew(false);
    loadList();
  }, [loadList]);

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <PersonalityList
        personalities={personalities}
        activeId={activeId}
        onSelect={handleSelect}
        onNew={handleNew}
        onWizard={() => setWizardOpen(true)}
      />
      <PersonalityEditor
        personalityId={activeId}
        isNew={isNew}
        onSaved={handleSaved}
        onDeleted={handleDeleted}
      />
      {wizardOpen && (
        <PersonalityWizard
          onClose={() => setWizardOpen(false)}
          onCreated={(id) => {
            setWizardOpen(false);
            loadList();
            setActiveId(id);
            setIsNew(false);
          }}
        />
      )}
    </div>
  );
}

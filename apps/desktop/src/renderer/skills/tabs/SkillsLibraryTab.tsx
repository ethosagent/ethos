import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ImportPersonalityPicker } from '../components/ImportPersonalityPicker';
import { PersonalitySubTabPicker } from '../components/PersonalitySubTabPicker';
import { SkillCard } from '../components/SkillCard';
import { SkillDetailDrawer } from '../components/SkillDetailDrawer';

interface Skill {
  id: string;
  name: string;
  description: string | null;
  body: string;
  modifiedAt: string;
  source: 'system' | 'user' | 'evolver' | 'personality';
  readonly: boolean;
}

interface PersonalitySkill {
  id: string;
  name: string;
  description: string | null;
  body: string;
  modifiedAt: string;
}

interface SkillsLibraryTabProps {
  port: number;
}

export function SkillsLibraryTab({ port }: SkillsLibraryTabProps) {
  const client = useMemo(
    () => createEthosClient({ baseUrl: `http://localhost:${port}`, fetch: globalThis.fetch }),
    [port],
  );

  const [skills, setSkills] = useState<Skill[]>([]);
  const [personalitySkills, setPersonalitySkills] = useState<PersonalitySkill[]>([]);
  const [personalities, setPersonalities] = useState<{ id: string; name: string }[]>([]);
  const [activeSubTab, setActiveSubTab] = useState('global');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [isNewSkill, setIsNewSkill] = useState(false);
  const [importPickerSkillId, setImportPickerSkillId] = useState<string | null>(null);
  const importAnchorRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), 150);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const loadSkills = useCallback(async () => {
    try {
      const res = await client.rpc.skills.list({});
      setSkills(res.skills);
    } catch {
      // best-effort
    }
  }, [client]);

  const loadPersonalities = useCallback(async () => {
    try {
      const res = await client.rpc.personalities.list({});
      setPersonalities(res.items.map((p) => ({ id: p.id, name: p.name })));
    } catch {
      // best-effort
    }
  }, [client]);

  const loadPersonalitySkills = useCallback(
    async (personalityId: string) => {
      try {
        const res = await client.rpc.personalities.skillsList({ personalityId });
        setPersonalitySkills(res.skills);
      } catch {
        setPersonalitySkills([]);
      }
    },
    [client],
  );

  useEffect(() => {
    loadSkills();
    loadPersonalities();
  }, [loadSkills, loadPersonalities]);

  useEffect(() => {
    if (activeSubTab !== 'global') {
      loadPersonalitySkills(activeSubTab);
    }
  }, [activeSubTab, loadPersonalitySkills]);

  const subTabs = useMemo(() => {
    const tabs: { id: string; label: string }[] = [{ id: 'global', label: 'Global library' }];
    for (const p of personalities) {
      tabs.push({ id: p.id, label: p.name });
    }
    return tabs;
  }, [personalities]);

  const installedIds = useMemo(() => {
    const set = new Set<string>();
    for (const s of personalitySkills) {
      set.add(s.id);
    }
    return set;
  }, [personalitySkills]);

  const filteredSkills = useMemo(() => {
    const query = debouncedQuery.toLowerCase();
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(query) || (s.description ?? '').toLowerCase().includes(query),
    );
  }, [skills, debouncedQuery]);

  const handleImportGlobal = useCallback(
    async (skillId: string, personalityId: string) => {
      try {
        await client.rpc.personalities.skillsImportGlobal({
          personalityId,
          skillIds: [skillId],
        });
        if (activeSubTab !== 'global') {
          loadPersonalitySkills(activeSubTab);
        }
        loadSkills();
      } catch {
        // best-effort
      }
    },
    [client, activeSubTab, loadPersonalitySkills, loadSkills],
  );

  const handleRemove = useCallback(
    async (skillId: string) => {
      if (activeSubTab === 'global') return;
      try {
        await client.rpc.personalities.skillsDelete({
          personalityId: activeSubTab,
          skillId,
        });
        loadPersonalitySkills(activeSubTab);
        loadSkills();
      } catch {
        // best-effort
      }
    },
    [client, activeSubTab, loadPersonalitySkills, loadSkills],
  );

  const handleDeleteSkill = useCallback(
    async (skillId: string) => {
      const confirmed = await window.ethos.dialog.showMessage({
        type: 'warning',
        message: 'Delete this skill? This action cannot be undone.',
        buttons: ['Cancel', 'Delete'],
      });
      if (confirmed.response !== 1) return;
      try {
        await client.rpc.skills.delete({ id: skillId });
        loadSkills();
        if (activeSubTab !== 'global') {
          loadPersonalitySkills(activeSubTab);
        }
      } catch {
        // best-effort
      }
    },
    [client, loadSkills, activeSubTab, loadPersonalitySkills],
  );

  const handleSaved = useCallback(() => {
    loadSkills();
    if (activeSubTab !== 'global') {
      loadPersonalitySkills(activeSubTab);
    }
  }, [loadSkills, activeSubTab, loadPersonalitySkills]);

  const handleDeleted = useCallback(() => {
    loadSkills();
    if (activeSubTab !== 'global') {
      loadPersonalitySkills(activeSubTab);
    }
  }, [loadSkills, activeSubTab, loadPersonalitySkills]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Sub-header row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 32,
          marginTop: 8,
          padding: '0 16px',
          borderBottom: '1px solid var(--border-subtle)',
          flexShrink: 0,
        }}
      >
        <PersonalitySubTabPicker
          activeTab={activeSubTab}
          tabs={subTabs}
          onTabChange={setActiveSubTab}
        />
        <span style={{ flex: 1 }} />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search..."
          style={{
            height: 28,
            width: 160,
            padding: '0 8px',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--text-primary)',
            backgroundColor: 'var(--bg-overlay)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-sm)',
            outline: 'none',
            marginRight: 8,
            boxSizing: 'border-box',
          }}
        />
        <button
          type="button"
          onClick={() => {
            setIsNewSkill(true);
            setSelectedSkillId(null);
          }}
          style={{
            height: 28,
            padding: '0 12px',
            background: 'none',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
            fontSize: 13,
            color: 'var(--text-secondary)',
          }}
        >
          New skill
        </button>
      </div>

      {/* Skill list */}
      <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
        {filteredSkills.length === 0 && (
          <div style={{ marginTop: 40, fontSize: 14, color: 'var(--text-tertiary)' }}>
            No skills in the library. Create one or install from a skill pack.
          </div>
        )}
        {filteredSkills.map((skill) => {
          const isPersonalityView = activeSubTab !== 'global';
          const isInstalled = isPersonalityView && installedIds.has(skill.id);

          return (
            <SkillCard
              key={skill.id}
              skill={skill}
              installed={isPersonalityView ? isInstalled : undefined}
              onImport={() => {
                if (isPersonalityView) {
                  handleImportGlobal(skill.id, activeSubTab);
                } else {
                  setImportPickerSkillId(skill.id);
                }
              }}
              onRemove={isPersonalityView && isInstalled ? () => handleRemove(skill.id) : undefined}
              onClick={() => {
                setIsNewSkill(false);
                setSelectedSkillId(skill.id);
              }}
              onEdit={() => {
                setIsNewSkill(false);
                setSelectedSkillId(skill.id);
              }}
              onDelete={() => handleDeleteSkill(skill.id)}
            />
          );
        })}
      </div>

      {/* Import personality picker (for global tab) */}
      <ImportPersonalityPicker
        open={importPickerSkillId !== null}
        personalities={personalities}
        onImport={(personalityId) => {
          if (importPickerSkillId) {
            handleImportGlobal(importPickerSkillId, personalityId);
          }
          setImportPickerSkillId(null);
        }}
        onClose={() => setImportPickerSkillId(null)}
        anchorRef={importAnchorRef}
      />

      {/* Skill detail drawer */}
      <SkillDetailDrawer
        open={selectedSkillId !== null || isNewSkill}
        skillId={selectedSkillId}
        isNew={isNewSkill}
        port={port}
        onClose={() => {
          setSelectedSkillId(null);
          setIsNewSkill(false);
        }}
        onSaved={handleSaved}
        onDeleted={handleDeleted}
      />
    </div>
  );
}

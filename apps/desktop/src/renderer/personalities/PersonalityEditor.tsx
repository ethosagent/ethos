import { createEthosClient } from '@ethosagent/sdk';
import type { McpPolicy, Personality } from '@ethosagent/web-contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useServerUrl } from '../shell/ServerUrl';
import { CharacterSheetTab } from './tabs/CharacterSheetTab';
import { IdentityTab } from './tabs/IdentityTab';
import { MCPTab } from './tabs/MCPTab';
import { ModelTab } from './tabs/ModelTab';
import { PluginsTab } from './tabs/PluginsTab';
import { SafetyTab } from './tabs/SafetyTab';
import { SkillsTab } from './tabs/SkillsTab';
import { ToolsTab } from './tabs/ToolsTab';

type TabId = 'identity' | 'model' | 'tools' | 'plugins' | 'mcp' | 'safety' | 'skills' | 'sheet';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'identity', label: 'Identity' },
  { id: 'tools', label: 'Tools' },
  { id: 'model', label: 'Model' },
  { id: 'mcp', label: 'MCP' },
  { id: 'safety', label: 'Safety' },
  { id: 'skills', label: 'Skills' },
  { id: 'plugins', label: 'Plugins' },
];

interface ModelTierConfig {
  trivial?: string;
  default?: string;
  deep?: string;
}

interface EditorDraft {
  name: string;
  id: string;
  description: string;
  soulMd: string;
  tags: string[];
  model: string | ModelTierConfig | null;
  toolset: string[];
  plugins: string[];
  mcpServers: string[];
  mcpTools: Record<string, string[]>;
  approvalMode: string;
  fsReach: { read: string[]; write: string[] };
}

interface PersonalityEditorProps {
  personalityId: string | null;
  isNew: boolean;
  onSaved: (savedId?: string) => void;
  onDeleted: () => void;
}

function emptyDraft(): EditorDraft {
  return {
    name: '',
    id: '',
    description: '',
    soulMd: '',
    tags: [],
    model: null,
    toolset: [],
    plugins: [],
    mcpServers: [],
    mcpTools: {},
    approvalMode: 'inherit',
    fsReach: { read: [], write: [] },
  };
}

function personalityToDraft(
  p: Personality,
  soulMd: string,
  mcpPolicy: McpPolicy | null,
): EditorDraft {
  const mcpTools: Record<string, string[]> = {};
  if (mcpPolicy?.servers) {
    for (const [server, policy] of Object.entries(mcpPolicy.servers)) {
      if (policy.tools && policy.tools.length > 0) {
        mcpTools[server] = policy.tools;
      }
    }
  }

  return {
    name: p.name,
    id: p.id,
    description: p.description ?? '',
    soulMd,
    tags: p.capabilities ?? [],
    model: p.model,
    toolset: p.toolset ?? [],
    plugins: p.plugins ?? [],
    mcpServers: p.mcp_servers ?? [],
    mcpTools,
    approvalMode: 'inherit',
    fsReach: {
      read: p.fs_reach?.read ?? [],
      write: p.fs_reach?.write ?? [],
    },
  };
}

export function PersonalityEditor({
  personalityId,
  isNew,
  onSaved,
  onDeleted,
}: PersonalityEditorProps) {
  const baseUrl = useServerUrl();
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [activeTab, setActiveTab] = useState<TabId>('identity');
  const [personality, setPersonality] = useState<Personality | null>(null);
  const [draft, setDraft] = useState<EditorDraft>(emptyDraft());
  const [originalDraft, setOriginalDraft] = useState<EditorDraft>(emptyDraft());
  const [loading, setLoading] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [duplicateInput, setDuplicateInput] = useState<string | null>(null);

  useEffect(() => {
    if (isNew) {
      const empty = emptyDraft();
      setDraft(empty);
      setOriginalDraft(empty);
      setPersonality(null);
      setActiveTab('identity');
      return;
    }

    if (!personalityId) return;

    let cancelled = false;
    setLoading(true);

    async function load() {
      try {
        const res = await client.rpc.personalities.get({ id: personalityId as string });
        if (cancelled) return;
        setPersonality(res.personality);
        const d = personalityToDraft(res.personality, res.soulMd, res.mcpPolicy);
        setDraft(d);
        setOriginalDraft(d);
      } catch {
        // best-effort
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [personalityId, isNew, client]);

  const hasChanges = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(originalDraft),
    [draft, originalDraft],
  );

  const updateDraft = useCallback((changes: Partial<EditorDraft>) => {
    setDraft((prev) => ({ ...prev, ...changes }));
    setSaveError(null);
  }, []);

  const handleSave = useCallback(async () => {
    // Client-side validation before calling the API
    if (isNew) {
      if (!draft.name.trim()) {
        setSaveError('Name is required');
        return;
      }
      const idRegex = /^[a-z0-9_-]+$/;
      if (!draft.id || !idRegex.test(draft.id)) {
        setSaveError('Name must contain at least one letter or number (used to generate the ID)');
        return;
      }
    }
    setSaveStatus('saving');
    try {
      if (isNew) {
        await client.rpc.personalities.create({
          id: draft.id,
          name: draft.name,
          description: draft.description || undefined,
          model: draft.model ?? undefined,
          toolset: draft.toolset,
          soulMd: draft.soulMd,
          capabilities: draft.tags.length > 0 ? draft.tags : undefined,
          plugins: draft.plugins.length > 0 ? draft.plugins : undefined,
          mcp_servers: draft.mcpServers.length > 0 ? draft.mcpServers : undefined,
          fs_reach:
            draft.fsReach.read.length > 0 || draft.fsReach.write.length > 0
              ? {
                  read: draft.fsReach.read.length > 0 ? draft.fsReach.read : undefined,
                  write: draft.fsReach.write.length > 0 ? draft.fsReach.write : undefined,
                }
              : undefined,
        });
      } else {
        const updatePayload: Record<string, unknown> = { id: draft.id };
        if (draft.name !== originalDraft.name) updatePayload.name = draft.name;
        if (draft.description !== originalDraft.description)
          updatePayload.description = draft.description;
        if (draft.soulMd !== originalDraft.soulMd) updatePayload.soulMd = draft.soulMd;
        if (JSON.stringify(draft.model) !== JSON.stringify(originalDraft.model))
          updatePayload.model = draft.model ?? undefined;
        if (JSON.stringify(draft.toolset) !== JSON.stringify(originalDraft.toolset))
          updatePayload.toolset = draft.toolset;
        if (JSON.stringify(draft.plugins) !== JSON.stringify(originalDraft.plugins))
          updatePayload.plugins = draft.plugins;
        if (JSON.stringify(draft.tags) !== JSON.stringify(originalDraft.tags))
          updatePayload.capabilities = draft.tags;
        if (JSON.stringify(draft.mcpServers) !== JSON.stringify(originalDraft.mcpServers))
          updatePayload.mcp_servers = draft.mcpServers;
        if (JSON.stringify(draft.mcpTools) !== JSON.stringify(originalDraft.mcpTools))
          updatePayload.mcp_tools = draft.mcpTools;
        if (JSON.stringify(draft.fsReach) !== JSON.stringify(originalDraft.fsReach))
          updatePayload.fs_reach = {
            read: draft.fsReach.read.length > 0 ? draft.fsReach.read : undefined,
            write: draft.fsReach.write.length > 0 ? draft.fsReach.write : undefined,
          };

        await client.rpc.personalities.update(
          updatePayload as Parameters<typeof client.rpc.personalities.update>[0],
        );
      }
      setSaveStatus('saved');
      setOriginalDraft(draft);
      if (isNew) {
        onSaved(draft.id);
      } else {
        onSaved();
      }
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (err) {
      setSaveStatus('idle');
      setSaveError(err instanceof Error ? err.message : 'Save failed. Check the console.');
    }
  }, [isNew, draft, originalDraft, client, onSaved]);

  const handleDelete = useCallback(async () => {
    if (!personalityId) return;
    try {
      const result = await window.ethos.dialog.showMessage({
        type: 'warning',
        title: 'Delete Personality',
        message: `Are you sure you want to delete "${draft.name}"? This cannot be undone.`,
        buttons: ['Cancel', 'Delete'],
      });
      if (result.response === 1) {
        await client.rpc.personalities.delete({ id: personalityId });
        onDeleted();
      }
    } catch {
      // best-effort
    }
  }, [personalityId, draft.name, client, onDeleted]);

  const handleDuplicate = useCallback(async () => {
    if (!personalityId) return;
    const newId = duplicateInput ?? `copy-of-${personalityId}`;
    try {
      await client.rpc.personalities.duplicate({ id: personalityId, newId });
      setDuplicateInput(null);
      onSaved();
    } catch {
      // best-effort
    }
  }, [personalityId, duplicateInput, client, onSaved]);

  if (!isNew && !personalityId) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-tertiary)',
          fontSize: 13,
        }}
      >
        Select a personality to edit
      </div>
    );
  }

  if (loading) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-tertiary)',
          fontSize: 13,
        }}
      >
        Loading...
      </div>
    );
  }

  const isBuiltin = personality?.builtin ?? false;

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        maxWidth: 800,
        padding: 32,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          height: 48,
          borderBottom: '1px solid var(--border-subtle)',
          gap: 0,
          flexShrink: 0,
        }}
      >
        {!isNew && personalityId && (
          <button
            type="button"
            onClick={() => setActiveTab('sheet')}
            style={{
              background: 'none',
              border: 'none',
              borderBottom:
                activeTab === 'sheet' ? '2px solid var(--accent)' : '2px solid transparent',
              padding: '0 16px',
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: activeTab === 'sheet' ? 500 : 400,
              color: activeTab === 'sheet' ? 'var(--text-primary)' : 'var(--text-secondary)',
              transition:
                'color var(--motion-fast) var(--ease), border-color var(--motion-fast) var(--ease)',
            }}
          >
            Character Sheet
          </button>
        )}
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            style={{
              background: 'none',
              border: 'none',
              borderBottom:
                activeTab === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
              padding: '0 16px',
              fontSize: 14,
              fontWeight: activeTab === tab.id ? 500 : 400,
              color: activeTab === tab.id ? 'var(--text-primary)' : 'var(--text-secondary)',
              cursor: 'pointer',
              transition:
                'color var(--motion-fast) var(--ease), border-color var(--motion-fast) var(--ease)',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 0' }}>
        {activeTab === 'identity' && (
          <IdentityTab
            personality={{
              id: draft.id,
              name: draft.name,
              description: draft.description,
              capabilities: draft.tags,
              soulMd: draft.soulMd,
            }}
            isNew={isNew}
            onChange={(changes) => {
              const mapped: Partial<EditorDraft> = {};
              if (changes.name !== undefined) mapped.name = changes.name;
              if (changes.id !== undefined) mapped.id = changes.id;
              if (changes.description !== undefined) mapped.description = changes.description;
              if (changes.soulMd !== undefined) mapped.soulMd = changes.soulMd;
              if (changes.tags !== undefined) mapped.tags = changes.tags;
              updateDraft(mapped);
            }}
          />
        )}
        {activeTab === 'model' && (
          <ModelTab
            personality={{ model: draft.model }}
            onChange={(model) => updateDraft({ model })}
          />
        )}
        {activeTab === 'tools' && (
          <ToolsTab toolset={draft.toolset} onChange={(toolset) => updateDraft({ toolset })} />
        )}
        {activeTab === 'plugins' && (
          <PluginsTab plugins={draft.plugins} onChange={(next) => updateDraft({ plugins: next })} />
        )}
        {activeTab === 'mcp' && (
          <MCPTab
            mcpServers={draft.mcpServers}
            mcpTools={draft.mcpTools}
            onChange={(mcpServers, mcpTools) => updateDraft({ mcpServers, mcpTools })}
            personalityId={draft.id}
          />
        )}
        {activeTab === 'safety' && (
          <SafetyTab
            personality={{
              fs_reach:
                draft.fsReach.read.length > 0 || draft.fsReach.write.length > 0
                  ? draft.fsReach
                  : null,
            }}
            approvalMode={draft.approvalMode}
            onChange={(changes) => {
              const mapped: Partial<EditorDraft> = {};
              if (changes.approvalMode !== undefined) mapped.approvalMode = changes.approvalMode;
              if (changes.fsReach !== undefined) mapped.fsReach = changes.fsReach;
              updateDraft(mapped);
            }}
          />
        )}
        {activeTab === 'skills' && <SkillsTab personalityId={isNew ? null : personalityId} />}
        {activeTab === 'sheet' && !isNew && personalityId && (
          <CharacterSheetTab personalityId={personalityId} />
        )}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: 40,
          borderTop: '1px solid var(--border-subtle)',
          backgroundColor: 'var(--bg-elevated)',
          padding: '0 16px',
          flexShrink: 0,
        }}
      >
        <div>
          {!isBuiltin && !isNew && (
            <button
              type="button"
              onClick={handleDelete}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: 14,
                color: 'var(--error)',
                padding: 0,
              }}
            >
              Delete
            </button>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {!isNew &&
            (duplicateInput !== null ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input
                  type="text"
                  value={duplicateInput}
                  onChange={(e) => setDuplicateInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleDuplicate();
                    if (e.key === 'Escape') setDuplicateInput(null);
                  }}
                  style={{
                    width: 160,
                    height: 24,
                    fontSize: 12,
                    fontFamily: 'var(--font-mono)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 4,
                    padding: '0 8px',
                    backgroundColor: 'var(--bg-base)',
                    color: 'var(--text-primary)',
                    outline: 'none',
                  }}
                />
                <button
                  type="button"
                  onClick={handleDuplicate}
                  style={{
                    background: 'none',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 4,
                    padding: '2px 8px',
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                  }}
                >
                  Go
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setDuplicateInput(`copy-of-${personalityId}`)}
                style={{
                  background: 'none',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 4,
                  padding: '4px 12px',
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                }}
              >
                Duplicate
              </button>
            ))}
          {saveError && (
            <span
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 12,
                color: 'var(--error)',
                maxWidth: 300,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                marginRight: 8,
              }}
            >
              {saveError}
            </span>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={!hasChanges || saveStatus === 'saving'}
            style={{
              backgroundColor: hasChanges ? 'var(--accent)' : 'var(--bg-overlay)',
              border: 'none',
              borderRadius: 4,
              padding: '4px 16px',
              fontSize: 13,
              fontWeight: 500,
              color: hasChanges ? 'white' : 'var(--text-tertiary)',
              cursor: hasChanges ? 'pointer' : 'default',
              minWidth: 70,
            }}
          >
            {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved ✓' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
